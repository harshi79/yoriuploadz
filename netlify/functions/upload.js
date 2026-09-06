/**
 * YoriUpload — internal upload relay.
 *
 * Receives a raw file body from the site and stores it upstream:
 *  - temporary links (1h/12h/24h/72h) go to ephemeral storage
 *  - permanent links go to permanent storage
 * with automatic fallback to a second provider when the first one refuses or
 * stalls (see ../lib/upstream.js).
 *
 * The browser never talks to the storage services directly, so there are no
 * CORS issues and the upstreams stay out of view.
 */

'use strict';

const { CORS, checkAccess, clientIp, json, makeRateLimiter } = require('../lib/http');
const { VALID_EXPIRY, chainFor, storeFile } = require('../lib/upstream');

/**
 * Netlify base64-encodes binary request bodies and caps the encoded payload at
 * ~6 MB, which leaves roughly 4.4 MB of real file. We stop at 4 MB so the
 * browser-side limit and this one agree.
 */
const MAX_BYTES = 4 * 1024 * 1024;

const rateLimited = makeRateLimiter({ windowMs: 60 * 1000, max: 30 });

function sanitizeFilename(raw) {
  if (!raw) return 'file';
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    /* not percent-encoded — use as-is */
  }
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');
  // Strip any path components / traversal just in case.
  name = name.replace(/[\\/]+/g, '-').replace(/^\.+/, '').trim();
  if (name.length > 200) name = name.slice(0, 200);
  return name || 'file';
}

/** Size of the decoded body, without allocating it twice. */
function decodedSize(event) {
  if (!event.body) return 0;
  if (!event.isBase64Encoded) return Buffer.byteLength(event.body, 'utf8');
  const padding = event.body.endsWith('==') ? 2 : event.body.endsWith('=') ? 1 : 0;
  return Math.floor((event.body.length * 3) / 4) - padding;
}

exports.handler = async (event) => {
  const headers = event.headers || {};
  const ip = clientIp(headers);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }

  // Optional shared-secret gate (APP_SECRET). Unset = open to everyone.
  const denied = checkAccess(headers);
  if (denied) return denied;

  if (rateLimited(ip)) {
    return json(429, { ok: false, error: 'Too many uploads. Please wait a moment and try again.' });
  }

  if (!event.body) {
    return json(400, { ok: false, error: 'No file data received.' });
  }

  const sizeBytes = decodedSize(event);
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
  const mime = String(headers['x-file-type'] || 'application/octet-stream').slice(0, 200);
  const expiryRaw = String(headers['x-expiry'] || '24h').trim();
  const expiry = VALID_EXPIRY.has(expiryRaw) ? expiryRaw : 'permanent';

  const buffer = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'utf8');

  const result = await storeFile(buffer, { filename, mime, expiry });

  if (result.ok) {
    return json(200, {
      ok: true,
      url: result.url,
      name: filename,
      size: buffer.length,
      type: mime,
      expires: expiry,
      provider: result.provider,
      fallback: result.fallback,
      note: result.fallback ? `Saved via ${result.providerLabel} — ${result.note}.` : '',
    });
  }

  // Log the full attempt trail; it is the only way to tell "provider blocked
  // our IP" apart from "provider was slow" in the Netlify function log.
  console.error(
    'upload failed',
    JSON.stringify({ expiry, size: buffer.length, chain: chainFor(VALID_EXPIRY.has(expiry) ? 'temp' : 'permanent'), attempts: result.attempts })
  );

  const everyTimeout = result.attempts.length > 0 && result.attempts.every((a) => a.error === 'timeout');
  return json(everyTimeout ? 504 : 502, {
    ok: false,
    error: result.error,
    attempts: result.attempts.map((a) => ({ provider: a.label || a.provider, status: a.status, error: a.error })),
  });
};
