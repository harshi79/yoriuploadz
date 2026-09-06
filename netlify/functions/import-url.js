/**
 * YoriUpload — import-by-URL relay.
 *
 * Accepts a direct file URL from the user, asks an upstream storage service to
 * fetch and host it, then returns the public link. Falls back to a second
 * provider when the first one refuses (see ../lib/upstream.js).
 */

'use strict';

const { CORS, checkAccess, clientIp, json, makeRateLimiter } = require('../lib/http');
const { storeFromUrl } = require('../lib/upstream');

const MAX_URL_LENGTH = 2048;
const rateLimited = makeRateLimiter({ windowMs: 60 * 60 * 1000, max: 60 });

function isSafeUrl(value) {
  if (!value || value.length > MAX_URL_LENGTH) return false;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    // Don't let the relay be used to probe private networks.
    const host = u.hostname.toLowerCase();
    const blocked =
      host === 'localhost' ||
      host === '::1' ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    return !blocked;
  } catch {
    return false;
  }
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

  const denied = checkAccess(headers);
  if (denied) return denied;

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

  const result = await storeFromUrl(url);

  if (result.ok) {
    return json(200, {
      ok: true,
      url: result.url,
      provider: result.provider,
      fallback: result.fallback,
      note: result.fallback ? `Saved via ${result.providerLabel} — ${result.note}.` : '',
    });
  }

  console.error('url import failed', JSON.stringify({ url, attempts: result.attempts }));

  const everyTimeout = result.attempts.length > 0 && result.attempts.every((a) => a.error === 'timeout');
  return json(everyTimeout ? 504 : 502, {
    ok: false,
    error: result.error,
    attempts: result.attempts.map((a) => ({ provider: a.label || a.provider, status: a.status, error: a.error })),
  });
};
