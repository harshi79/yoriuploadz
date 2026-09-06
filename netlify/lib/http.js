/**
 * YoriUpload — small HTTP helpers shared by the relay functions.
 */

'use strict';

const KEY_HEADER = 'x-access-key';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-file-name, x-file-type, x-expiry, x-access-key',
  'Access-Control-Max-Age': '86400',
};

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

/** Constant-time-ish comparison so the access key can't be probed by timing. */
function secretMatches(supplied, secret) {
  const a = String(supplied || '');
  const b = String(secret || '');
  let mismatch = a.length !== b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    mismatch = mismatch || a.charCodeAt(i) !== b.charCodeAt(i);
  }
  return !mismatch;
}

/** Returns an error response when the request is not allowed through, else null. */
function checkAccess(headers) {
  const secret = process.env.APP_SECRET;
  if (!secret) return null;
  if (secretMatches(headers[KEY_HEADER], secret)) return null;
  return json(403, { ok: false, error: 'This upload service is private and requires an access key.' });
}

function clientIp(headers) {
  const forwarded = headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return headers['x-nf-client-connection-ip'] || 'unknown';
}

/** Per-instance throttle. Only effective while a warm instance lives — by design. */
function makeRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function rateLimited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return true;
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 500) {
      for (const [key, list] of hits) if (!list.some((t) => now - t < windowMs)) hits.delete(key);
    }
    return false;
  };
}

module.exports = { CORS, KEY_HEADER, checkAccess, clientIp, json, makeRateLimiter, secretMatches };
