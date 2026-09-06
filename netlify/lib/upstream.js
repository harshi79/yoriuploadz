/**
 * YoriUpload — upstream storage layer.
 *
 * The relay functions (upload / import-url / diag) all go through here.
 *
 * Why this exists: a single upstream provider is a single point of failure.
 * Catbox/Litterbox regularly reject requests coming from datacenter IP ranges
 * (which is exactly what a Netlify Function is) and can be slow enough to blow
 * the 10 s function timeout. When that happened the old code surfaced a generic
 * "Something went wrong" — or nothing parseable at all, because Netlify itself
 * returned a plain-text 502 after killing the function.
 *
 * So: every store attempt walks a chain of providers inside an explicit time
 * budget, and every failure is reported with the provider, HTTP status and the
 * upstream's own words.
 */

'use strict';

const USER_AGENT = 'YoriUpload/1.1 (+https://github.com/harshi79/yoriuploadz)';

/**
 * Netlify kills synchronous functions at 10 s (26 s on higher tiers). Staying
 * *under* that is essential: if we run past it the browser gets an opaque
 * platform error instead of our JSON, which is what "upload just fails" looks
 * like from the outside. Override with UPLOAD_BUDGET_MS if your plan allows a
 * longer function timeout.
 */
const DEFAULT_BUDGET_MS = clampInt(process.env.UPLOAD_BUDGET_MS, 9000, 2000, 25000);
const MIN_ATTEMPT_MS = 1500;

const ENDPOINTS = {
  catbox: process.env.UPSTREAM_PERMANENT_URL || 'https://catbox.moe/user/api.php',
  litterbox: process.env.UPSTREAM_TEMP_URL || 'https://litterbox.catbox.moe/resources/internals/api.php',
  zerox: process.env.UPSTREAM_ZEROX_URL || 'https://0x0.st',
  tmpfiles: process.env.UPSTREAM_TMPFILES_URL || 'https://tmpfiles.org/api/v1/upload',
};

const EXPIRY_HOURS = { '1h': 1, '12h': 12, '24h': 24, '72h': 72 };
const VALID_EXPIRY = new Set(Object.keys(EXPIRY_HOURS));

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function firstLine(text, max = 300) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Strip the upstream's "Error: " prefix so messages read naturally. */
function cleanReason(text) {
  return firstLine(text).replace(/^error\s*:?\s*/i, '');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

function fileForm(fields, buffer, fieldName, filename, mime) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
  }
  if (buffer) {
    form.append(fieldName, new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);
  }
  return form;
}

/* --------------------------------- providers -------------------------------- */
/*
 * Each provider exposes:
 *   kinds     — which jobs it can do ('temp' | 'permanent' | 'url')
 *   label     — human name for error messages
 *   retention(expiry) — note shown to the user when it is used as a fallback
 *   upload(buffer, meta, timeoutMs) -> { ok, url, status, detail }
 *   fromUrl(url, timeoutMs)         -> { ok, url, status, detail }   (optional)
 */

const providers = {
  litterbox: {
    label: 'Litterbox',
    kinds: ['temp'],
    endpoint: () => ENDPOINTS.litterbox,
    retention: (expiry) => `expires in ${expiry}`,
    async upload(buffer, meta, timeoutMs) {
      const form = fileForm(
        { reqtype: 'fileupload', time: meta.expiry },
        buffer,
        'fileToUpload',
        meta.filename,
        meta.mime
      );
      const res = await fetchWithTimeout(ENDPOINTS.litterbox, { method: 'POST', body: form }, timeoutMs);
      const text = (await res.text()).trim();
      const ok = res.ok && /^https:\/\/(litter|files)\.catbox\.moe\/[A-Za-z0-9._-]+$/i.test(text);
      return { ok, url: ok ? text : null, status: res.status, detail: ok ? '' : cleanReason(text) };
    },
  },

  catbox: {
    label: 'Catbox',
    kinds: ['permanent', 'url'],
    endpoint: () => ENDPOINTS.catbox,
    retention: () => 'permanent link',
    async upload(buffer, meta, timeoutMs) {
      const form = fileForm(
        { reqtype: 'fileupload', userhash: process.env.CATBOX_USERHASH || '' },
        buffer,
        'fileToUpload',
        meta.filename,
        meta.mime
      );
      const res = await fetchWithTimeout(ENDPOINTS.catbox, { method: 'POST', body: form }, timeoutMs);
      const text = (await res.text()).trim();
      const ok = res.ok && /^https:\/\/files\.catbox\.moe\/[A-Za-z0-9._-]+$/i.test(text);
      return { ok, url: ok ? text : null, status: res.status, detail: ok ? '' : cleanReason(text) };
    },
    async fromUrl(url, timeoutMs) {
      const form = fileForm({ reqtype: 'urlupload', userhash: process.env.CATBOX_USERHASH || '', url });
      const res = await fetchWithTimeout(ENDPOINTS.catbox, { method: 'POST', body: form }, timeoutMs);
      const text = (await res.text()).trim();
      const ok = res.ok && /^https:\/\/files\.catbox\.moe\/[A-Za-z0-9._-]+$/i.test(text);
      return { ok, url: ok ? text : null, status: res.status, detail: ok ? '' : cleanReason(text) };
    },
  },

  // 0x0.st accepts both file uploads and "grab this URL" requests, and — unlike
  // Catbox — does not blanket-block cloud egress IPs. Retention is size based
  // (roughly 30–365 days), so it is a good fallback for both link types.
  zerox: {
    label: '0x0.st',
    kinds: ['temp', 'permanent', 'url'],
    endpoint: () => ENDPOINTS.zerox,
    retention: (expiry) =>
      expiry === 'permanent' ? 'long-term link (fallback storage, up to 1 year)' : `expires in ${expiry}`,
    async upload(buffer, meta, timeoutMs) {
      const fields = { secret: '' };
      if (meta.expiry !== 'permanent') fields.expires = String(EXPIRY_HOURS[meta.expiry] || 24);
      const form = fileForm(fields, buffer, 'file', meta.filename, meta.mime);
      const res = await fetchWithTimeout(ENDPOINTS.zerox, { method: 'POST', body: form }, timeoutMs);
      const text = (await res.text()).trim();
      const ok = res.ok && /^https:\/\/0x0\.st\/[A-Za-z0-9._-]+$/i.test(text);
      return { ok, url: ok ? text : null, status: res.status, detail: ok ? '' : cleanReason(text) };
    },
    async fromUrl(url, timeoutMs) {
      const form = fileForm({ url, secret: '' });
      const res = await fetchWithTimeout(ENDPOINTS.zerox, { method: 'POST', body: form }, timeoutMs);
      const text = (await res.text()).trim();
      const ok = res.ok && /^https:\/\/0x0\.st\/[A-Za-z0-9._-]+$/i.test(text);
      return { ok, url: ok ? text : null, status: res.status, detail: ok ? '' : cleanReason(text) };
    },
  },

  // Last resort for short-lived links: keeps files for ~1 hour only.
  tmpfiles: {
    label: 'tmpfiles.org',
    kinds: ['temp'],
    endpoint: () => ENDPOINTS.tmpfiles,
    retention: () => 'expires in about 1 hour (fallback storage)',
    async upload(buffer, meta, timeoutMs) {
      const form = fileForm({}, buffer, 'file', meta.filename, meta.mime);
      const res = await fetchWithTimeout(ENDPOINTS.tmpfiles, { method: 'POST', body: form }, timeoutMs);
      const text = (await res.text()).trim();
      let url = null;
      try {
        const parsed = JSON.parse(text);
        const raw = parsed && parsed.data && parsed.data.url;
        // Turn the landing page URL into a direct-download URL.
        if (typeof raw === 'string') url = raw.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
      } catch {
        /* non-JSON => treated as failure below */
      }
      const ok = res.ok && !!url && /^https:\/\/tmpfiles\.org\/dl\/\d+\/.+$/i.test(url);
      return { ok, url: ok ? url : null, status: res.status, detail: ok ? '' : cleanReason(text) };
    },
  },
};

const DEFAULT_CHAINS = {
  temp: ['litterbox', 'zerox', 'tmpfiles'],
  permanent: ['catbox', 'zerox'],
  url: ['catbox', 'zerox'],
};

/** Env overrides: UPSTREAM_ORDER="zerox,catbox" and UPSTREAM_DISABLED="tmpfiles". */
function chainFor(kind) {
  const disabled = new Set(
    String(process.env.UPSTREAM_DISABLED || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const override = String(process.env.UPSTREAM_ORDER || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((id) => providers[id]);

  const base = override.length ? override : DEFAULT_CHAINS[kind];
  return base.filter((id) => providers[id] && providers[id].kinds.includes(kind) && !disabled.has(id));
}

function describeFailure(attempts) {
  const first = attempts.find((a) => a.error);
  if (!first) return 'No storage provider was available.';
  if (attempts.every((a) => a.error === 'timeout')) {
    return 'The storage service did not respond in time. Please try again — smaller files upload faster.';
  }
  const detail = first.detail || first.error;
  return `${first.label}: ${detail}`;
}

/**
 * Store a buffer. `expiry` is one of 1h/12h/24h/72h or 'permanent'.
 * Always resolves; never throws.
 */
async function storeFile(buffer, { filename, mime, expiry }, options = {}) {
  const kind = VALID_EXPIRY.has(expiry) ? 'temp' : 'permanent';
  return runChain(chainFor(kind), options, (provider, timeoutMs) =>
    provider.upload(buffer, { filename, mime, expiry: kind === 'temp' ? expiry : 'permanent' }, timeoutMs)
  , expiry);
}

/** Ask a provider to fetch a remote URL and re-host it. Always resolves. */
async function storeFromUrl(url, options = {}) {
  const chain = chainFor('url').filter((id) => typeof providers[id].fromUrl === 'function');
  return runChain(chain, options, (provider, timeoutMs) => provider.fromUrl(url, timeoutMs), 'permanent');
}

async function runChain(chain, options, run, expiry) {
  const budget = clampInt(options.budgetMs, DEFAULT_BUDGET_MS, 2000, 25000);
  const deadline = Date.now() + budget;
  const attempts = [];

  if (!chain.length) {
    return { ok: false, attempts, error: 'No storage provider is enabled for this kind of link.' };
  }

  for (let i = 0; i < chain.length; i++) {
    const id = chain[i];
    const provider = providers[id];
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      attempts.push({ provider: id, label: provider.label, error: 'skipped (out of time)' });
      continue;
    }

    // Give the primary provider most of the budget but always keep a slice in
    // reserve so at least one fallback can still be tried.
    const left = chain.length - i;
    const timeoutMs = left > 1 ? Math.max(MIN_ATTEMPT_MS, Math.floor(remaining * 0.6)) : remaining;
    const started = Date.now();

    try {
      const result = await run(provider, timeoutMs);
      const ms = Date.now() - started;
      if (result.ok) {
        attempts.push({ provider: id, label: provider.label, status: result.status, ms, ok: true });
        return {
          ok: true,
          url: result.url,
          provider: id,
          providerLabel: provider.label,
          fallback: i > 0,
          note: provider.retention(expiry),
          attempts,
        };
      }
      attempts.push({
        provider: id,
        label: provider.label,
        status: result.status,
        ms,
        error: result.detail || `HTTP ${result.status}`,
        detail: result.detail,
      });
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      attempts.push({
        provider: id,
        label: provider.label,
        ms: Date.now() - started,
        error: aborted ? 'timeout' : (err && err.message) || 'network error',
      });
    }
  }

  return { ok: false, attempts, error: describeFailure(attempts) };
}

/** Reachability probe used by /api/diag — no files are uploaded. */
async function probeProviders(timeoutMs = 4000) {
  const ids = Object.keys(providers);
  return Promise.all(
    ids.map(async (id) => {
      const provider = providers[id];
      const endpoint = provider.endpoint();
      const started = Date.now();
      try {
        const res = await fetchWithTimeout(endpoint, { method: 'GET' }, timeoutMs);
        const text = (await res.text()).slice(0, 200);
        return {
          provider: id,
          label: provider.label,
          endpoint,
          reachable: true,
          status: res.status,
          ms: Date.now() - started,
          sample: firstLine(text, 120),
        };
      } catch (err) {
        const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
        return {
          provider: id,
          label: provider.label,
          endpoint,
          reachable: false,
          ms: Date.now() - started,
          error: aborted ? 'timeout' : (err && err.message) || 'network error',
        };
      }
    })
  );
}

module.exports = {
  DEFAULT_BUDGET_MS,
  VALID_EXPIRY,
  chainFor,
  probeProviders,
  providers,
  storeFile,
  storeFromUrl,
  USER_AGENT,
};
