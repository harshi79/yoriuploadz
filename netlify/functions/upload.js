/**
 * YoriUpload — internal upload relay.
 *
 * Receives a raw file body from the site and stores it:
 *  - temporary links (1h/12h/24h/72h) go to the ephemeral storage service
 *  - permanent links go to the permanent storage service
 *
 * This function is the only component that talks to the upstream services,
 * so the browser never sees them (and there are no CORS issues).
 */

// Upstream endpoints are overridable (used for local testing).
const PERMANENT_ENDPOINT = process.env.UPSTREAM_PERMANENT_URL || 'https://catbox.moe/user/api.php';
const TEMP_ENDPOINT = process.env.UPSTREAM_TEMP_URL || 'https://litterbox.catbox.moe/resources/internals/api.php';
const MAX_BYTES = 4 * 1024 * 1024; // Netlify binary request payload limit (~4.5 MiB)
const FETCH_TIMEOUT_MS = 50 * 1000;
const KEY_HEADER = 'x-access-key';
const VALID_EXPIRY = new Set(['1h', '12h', '24h', '72h']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-file-name, x-file-type, x-expiry, x-access-key',
  'Access-Control-Max-Age': '86400',
};

// Very small per-instance throttle (only helps while a warm instance is alive).
const rate = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 30;

function rateLimited(ip) {
  const now = Date.now();
  const hits = (rate.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) return true;
  hits.push(now);
  rate.set(ip, hits);
  return false;
}

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

function sanitizeFilename(raw) {
  if (!raw) return 'file';
  let name = decodeURIComponent(raw).replace(/[\u0000-\u001f\u007f]/g, '');
  // Strip any path components / traversal just in case.
  name = name.replace(/[\\/]+/g, '-').replace(/^\.+/, '');
  name = name.trim();
  if (!name || name.length > 200) name = name ? name.slice(0, 200) : 'file';
  return name || 'file';
}

function isOkUrl(text, patterns) {
  return patterns.some((re) => re.test(text));
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

  // Optional shared-secret gate. Set APP_SECRET as a Netlify environment
  // variable to make the service private; leave unset for open sharing.
  const secret = process.env.APP_SECRET;
  if (secret) {
    const supplied = headers[KEY_HEADER] || '';
    let a = supplied;
    let b = secret;
    let mismatch = a.length !== b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      mismatch = mismatch || a.charCodeAt(i) !== b.charCodeAt(i);
    }
    if (mismatch) {
      return json(403, { ok: false, error: 'This upload service is private and requires an access key.' });
    }
  }

  if (rateLimited(ip)) {
    return json(429, { ok: false, error: 'Too many uploads. Please wait a moment and try again.' });
  }

  if (!event.body) {
    return json(400, { ok: false, error: 'No file data received.' });
  }

  const sizeBytes = event.isBase64Encoded
    ? Math.floor(event.body.length * 3 / 4) - (event.body.endsWith('==') ? 2 : event.body.endsWith('=') ? 1 : 0)
    : Buffer.byteLength(event.body, 'utf8');

  if (sizeBytes <= 0) {
    return json(400, { ok: false, error: 'Empty file.' });
  }
  if (sizeBytes > MAX_BYTES) {
    return json(413, {
      ok: false,
      error: 'File is too large for this deployment (max 4 MB). Try a smaller file.',
    });
  }

  const filename = sanitizeFilename(
    headers['x-file-name'] || (event.queryStringParameters && event.queryStringParameters.filename) || 'file'
  );
  const mime = (headers['x-file-type'] || 'application/octet-stream').slice(0, 200);
  const expiryRaw = String(headers['x-expiry'] || '24h').trim();
  const temporary = VALID_EXPIRY.has(expiryRaw);
  const expiry = temporary ? expiryRaw : 'permanent';

  const buffer = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'utf8');

  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    if (temporary) {
      form.append('time', expiryRaw);
    } else if (process.env.CATBOX_USERHASH) {
      form.append('userhash', process.env.CATBOX_USERHASH);
    }
    form.append('fileToUpload', new Blob([buffer], { type: mime }), filename);

    const endpoint = temporary ? TEMP_ENDPOINT : PERMANENT_ENDPOINT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const upstream = await fetch(endpoint, {
      method: 'POST',
      body: form,
      signal: controller.signal,
      headers: {
        'User-Agent': 'YoriUpload/1.0 (+https://github.com/harshi79/yoriuploadz)',
      },
    });
    clearTimeout(timer);

    const text = (await upstream.text()).trim();
    const okUrl = isOkUrl(text, [
      /^https:\/\/files\.catbox\.moe\/[A-Za-z0-9._-]+$/i,
      /^https:\/\/litter\.catbox\.moe\/[A-Za-z0-9._-]+$/i,
    ]);

    if (upstream.ok && okUrl) {
      return json(200, {
        ok: true,
        url: text,
        name: filename,
        size: buffer.length,
        type: mime,
        expires: expiry === 'permanent' ? 'permanent' : expiry,
      });
    }

    // Upstream returns "Error: ..." plain text on failure.
    const reason = text
      .replace(/^error\s*:?\s*/i, '')
      .replace(/\s+/g, ' ')
      .slice(0, 300);
    console.error(`upload failed upstream (status ${upstream.status}): ${reason || 'unknown'}`);
    return json(502, {
      ok: false,
      error: reason || 'The storage service did not accept the file. Please try again.',
    });
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    console.error(`upload error: ${aborted ? 'timeout' : (err && err.message) || 'unknown'}`);
    return json(502, {
      ok: false,
      error: aborted
        ? 'Upload timed out. Please try again.'
        : 'Something went wrong while saving the file. Please try again.',
    });
  }
};
