/**
 * YoriUpload — import-by-URL relay.
 *
 * Accepts a direct file URL from the user, asks the upstream storage
 * service to fetch and host it, then returns the public link.
 * Server-side only — no CORS issues, and the browser never sees the
 * upstream service.
 */

// Upstream endpoint is overridable (used for local testing).
const UPSTREAM_ENDPOINT = process.env.UPSTREAM_PERMANENT_URL || 'https://catbox.moe/user/api.php';
const FETCH_TIMEOUT_MS = 50 * 1000;
const KEY_HEADER = 'x-access-key';
const MAX_URL_LENGTH = 2048;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-access-key',
  'Access-Control-Max-Age': '86400',
};

const rate = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 60;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
    body: JSON.stringify(payload),
  };
}

function rateLimited(ip) {
  const now = Date.now();
  const hits = (rate.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) return true;
  hits.push(now);
  rate.set(ip, hits);
  return false;
}

function isSafeUrl(value) {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && value.length <= MAX_URL_LENGTH;
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  const headers = event.headers || {};
  const ip = headers['x-forwarded-for'] || headers['x-nf-client-connection-ip'] || 'unknown';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }

  const secret = process.env.APP_SECRET;
  if (secret && (headers[KEY_HEADER] || '') !== secret) {
    return json(403, { ok: false, error: 'This upload service is private and requires an access key.' });
  }

  if (rateLimited(ip)) {
    return json(429, { ok: false, error: 'Too many requests. Please wait and try again.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid request.' });
  }

  const url = String(payload.url || '').trim();
  if (!isSafeUrl(url)) {
    return json(400, {
      ok: false,
      error: 'That does not look like a direct file link. Paste the full URL of the file itself.',
    });
  }

  try {
    const form = new FormData();
    form.append('reqtype', 'urlupload');
    if (process.env.CATBOX_USERHASH) form.append('userhash', process.env.CATBOX_USERHASH);
    form.append('url', url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const upstream = await fetch(UPSTREAM_ENDPOINT, {
      method: 'POST',
      body: form,
      signal: controller.signal,
      headers: {
        'User-Agent': 'YoriUpload/1.0 (+https://github.com/harshi79/yoriuploadz)',
      },
    });
    clearTimeout(timer);

    const text = (await upstream.text()).trim();

    if (upstream.ok && /^https:\/\/files\.catbox\.moe\/[A-Za-z0-9._-]+$/i.test(text)) {
      return json(200, { ok: true, url: text });
    }

    const reason = text
      .replace(/^error\s*:?\s*/i, '')
      .replace(/\s+/g, ' ')
      .slice(0, 300);
    console.error(`url import failed upstream (status ${upstream.status}): ${reason || 'unknown'}`);
    return json(502, {
      ok: false,
      error: reason || 'The source could not be fetched. It must be a publicly reachable direct file link.',
    });
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    console.error(`url import error: ${aborted ? 'timeout' : (err && err.message) || 'unknown'}`);
    return json(502, {
      ok: false,
      error: aborted ? 'Import timed out. Please try again.' : 'Import failed. Please try again.',
    });
  }
};
