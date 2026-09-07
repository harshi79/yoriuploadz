'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const CATBOX_ENDPOINT = 'https://catbox.moe/user/api.php';
const CATBOX_FILE_HOST = 'files.catbox.moe';
const MAX_UPLOAD_BYTES = 200_000_000;
const GIF_MAX_BYTES = 20_000_000;
const DOWNLOAD_WAIT_MS = 5_000;
const DOWNLOAD_TICKET_LIFETIME_MS = 15 * 60_000;
const BLOCKED_EXTENSIONS = new Set(['exe', 'scr', 'cpl', 'jar']);
const CATBOX_URL_PATTERN = /^https:\/\/files\.catbox\.moe\/[A-Za-z0-9._-]+$/;

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function cleanFilename(value) {
  let name = String(value || 'file');
  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep the original when it is not valid percent encoding.
  }
  name = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\\/]+/g, '-')
    .replace(/^(?:\.\.-)+/, '')
    .trim();
  if (/^\.*$/.test(name)) name = 'file';
  return Array.from(name).slice(0, 180).join('');
}

function safeMime(value) {
  const mime = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}

function extensionOf(filename) {
  const index = filename.lastIndexOf('.');
  return index < 0 ? '' : filename.slice(index + 1).toLowerCase();
}

function validUserhash(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(value);
}

function firstLine(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^error\s*:?\s*/i, '')
    .slice(0, 220);
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'Cache-Control': 'no-store',
    'Content-Length': body.byteLength,
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function publicOrigin(request) {
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (request.socket.encrypted ? 'https' : 'http');
  return `${protocol}://${request.headers.host || 'localhost'}`;
}

function requestIp(request) {
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || request.socket.remoteAddress || 'unknown';
}

function createLimiter(limit, windowMs) {
  const entries = new Map();
  return {
    take(key, now = Date.now()) {
      const current = entries.get(key);
      if (!current || current.resetAt <= now) {
        entries.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (current.count >= limit) return false;
      current.count += 1;
      if (entries.size > 10_000) {
        for (const [entryKey, value] of entries) {
          if (value.resetAt <= now) entries.delete(entryKey);
        }
      }
      return true;
    },
  };
}

function transportFor(url) {
  return url.protocol === 'http:' ? http : https;
}

function uploadToCatbox(request, response, config, metadata) {
  const boundary = `----yori-${crypto.randomUUID()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="reqtype"\r\n\r\n' +
      'fileupload\r\n' +
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="userhash"\r\n\r\n' +
      `${config.catboxUserhash}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="fileToUpload"; filename="${metadata.filename.replace(/"/g, '')}"\r\n` +
      `Content-Type: ${metadata.mime}\r\n\r\n`
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const endpoint = new URL(config.catboxEndpoint);
  let answered = false;
  let received = 0;

  const answer = (status, payload) => {
    if (answered || response.destroyed) return;
    answered = true;
    sendJson(response, status, payload);
  };

  const upstream = transportFor(endpoint).request(endpoint, {
    method: 'POST',
    headers: {
      'Content-Length': prefix.byteLength + metadata.size + suffix.byteLength,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'User-Agent': 'YoriUpload/3.0',
    },
  }, (upstreamResponse) => {
    const chunks = [];
    let length = 0;
    upstreamResponse.on('data', (chunk) => {
      length += chunk.byteLength;
      if (length > 16_384) {
        upstreamResponse.destroy(new Error('Catbox response was too large'));
        return;
      }
      chunks.push(chunk);
    });
    upstreamResponse.on('end', () => {
      if (answered) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (
        upstreamResponse.statusCode >= 200 &&
        upstreamResponse.statusCode < 300 &&
        CATBOX_URL_PATTERN.test(text)
      ) {
        const shareId = createSharePayload(config.shareSecret, {
          u: text,
          n: metadata.filename,
          s: metadata.size,
          t: metadata.mime,
        });
        answer(200, {
          ok: true,
          sharePath: `/v/${shareId}`,
          name: metadata.filename,
          size: metadata.size,
          type: metadata.mime,
          permanent: true,
        });
        return;
      }

      const detail = firstLine(text).replaceAll(config.catboxUserhash, '[redacted]');
      const upstreamStatus = Number(upstreamResponse.statusCode) || 502;
      const status = upstreamStatus >= 500 ? 502 : upstreamStatus === 429 ? 429 : upstreamStatus === 413 ? 413 : 422;
      console.error('Catbox rejected upload', JSON.stringify({ status: upstreamStatus, detail }));
      answer(status, { ok: false, error: detail || `Catbox rejected the upload (HTTP ${upstreamStatus}).` });
    });
    upstreamResponse.on('error', () => answer(502, { ok: false, error: 'Permanent storage returned an invalid response.' }));
  });

  upstream.setTimeout(config.upstreamTimeoutMs, () => upstream.destroy(new Error('Catbox upload timed out')));
  upstream.on('error', (error) => {
    if (!answered) console.error('Catbox upload failed', error.message);
    answer(502, { ok: false, error: 'Permanent storage could not be reached.' });
  });

  request.pause();
  request.on('data', (chunk) => {
    received += chunk.byteLength;
    if (received > metadata.size) {
      upstream.destroy(new Error('Upload body exceeded declared size'));
      request.destroy();
      return;
    }
    if (!upstream.write(chunk)) {
      request.pause();
      upstream.once('drain', () => request.resume());
    }
  });
  request.on('end', () => {
    if (received !== metadata.size) {
      upstream.destroy(new Error('Upload body size did not match Content-Length'));
      answer(400, { ok: false, error: 'Upload body was incomplete.' });
      return;
    }
    upstream.end(suffix);
  });
  request.on('aborted', () => upstream.destroy(new Error('Visitor cancelled upload')));
  request.on('error', () => upstream.destroy(new Error('Visitor upload stream failed')));
  response.on('close', () => {
    if (!response.writableEnded) upstream.destroy(new Error('Visitor disconnected'));
  });

  if (!upstream.write(prefix)) upstream.once('drain', () => request.resume());
  else request.resume();
}

function shareSignature(secret, encoded) {
  return crypto.createHmac('sha256', secret).update(`share.${encoded}`).digest('base64url');
}

function createSharePayload(secret, entry) {
  const encoded = Buffer.from(JSON.stringify(entry)).toString('base64url');
  return `${encoded}.${shareSignature(secret, encoded)}`;
}

function decodeSharePayload(payload, secret) {
  const match = String(payload || '').match(/^([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return null;
  const supplied = Buffer.from(match[2]);
  const expected = Buffer.from(shareSignature(secret, match[1]));
  if (supplied.byteLength !== expected.byteLength || !crypto.timingSafeEqual(supplied, expected)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.u !== 'string' || !CATBOX_URL_PATTERN.test(parsed.u)) return null;
    const target = new URL(parsed.u);
    if (target.protocol !== 'https:' || target.hostname.toLowerCase() !== CATBOX_FILE_HOST) return null;
    return {
      target,
      name: cleanFilename(parsed.n || 'download'),
      size: Number.isFinite(Number(parsed.s)) ? Math.max(0, Number(parsed.s)) : 0,
      type: safeMime(parsed.t),
    };
  } catch {
    return null;
  }
}

function ticketSignature(secret, payload, readyAt, expiresAt) {
  return crypto.createHmac('sha256', secret).update(`${payload}.${readyAt}.${expiresAt}`).digest('base64url');
}

function createDownloadTicket(secret, payload, waitMs, now = Date.now()) {
  const readyAt = now + waitMs;
  const expiresAt = readyAt + DOWNLOAD_TICKET_LIFETIME_MS;
  const signature = ticketSignature(secret, payload, readyAt, expiresAt);
  return { readyAt, expiresAt, ticket: `${readyAt}.${expiresAt}.${signature}` };
}

function verifyDownloadTicket(secret, payload, ticket, now = Date.now()) {
  const match = String(ticket || '').match(/^(\d{13})\.(\d{13})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return { ok: false, status: 403 };
  const readyAt = Number(match[1]);
  const expiresAt = Number(match[2]);
  const supplied = Buffer.from(match[3]);
  const expected = Buffer.from(ticketSignature(secret, payload, readyAt, expiresAt));
  if (supplied.byteLength !== expected.byteLength || !crypto.timingSafeEqual(supplied, expected)) {
    return { ok: false, status: 403 };
  }
  if (now < readyAt) return { ok: false, status: 425, retryAfter: Math.max(1, Math.ceil((readyAt - now) / 1000)) };
  if (now > expiresAt) return { ok: false, status: 403 };
  return { ok: true };
}

function contentDisposition(filename) {
  return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function proxyDownload(request, response, share, config) {
  const upstreamUrl = config.downloadProxyOrigin
    ? new URL(`${share.target.pathname}${share.target.search}`, config.downloadProxyOrigin)
    : share.target;
  const headers = { 'User-Agent': 'YoriDownload/3.0' };
  if (request.headers.range && /^bytes=\d*-\d*$/.test(request.headers.range)) headers.Range = request.headers.range;

  const upstream = transportFor(upstreamUrl).request(upstreamUrl, { method: 'GET', headers }, (upstreamResponse) => {
    const status = Number(upstreamResponse.statusCode) || 502;
    if (status !== 200 && status !== 206) {
      upstreamResponse.resume();
      sendJson(response, status === 404 ? 404 : 502, {
        ok: false,
        error: status === 404 ? 'This file is no longer available.' : 'The file could not be downloaded.',
      });
      return;
    }

    const responseHeaders = {
      ...SECURITY_HEADERS,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': contentDisposition(share.name),
      'Content-Type': safeMime(upstreamResponse.headers['content-type'] || share.type),
    };
    for (const header of ['accept-ranges', 'content-length', 'content-range', 'etag', 'last-modified']) {
      if (upstreamResponse.headers[header]) responseHeaders[header] = upstreamResponse.headers[header];
    }
    response.writeHead(status, responseHeaders);
    upstreamResponse.pipe(response);
    upstreamResponse.on('error', () => response.destroy());
  });

  upstream.setTimeout(config.upstreamTimeoutMs, () => upstream.destroy(new Error('Catbox download timed out')));
  upstream.on('error', (error) => {
    console.error('Catbox download failed', error.message);
    if (!response.headersSent) sendJson(response, 502, { ok: false, error: 'The file could not be downloaded.' });
    else response.destroy();
  });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => {
    if (!response.writableEnded) upstream.destroy();
  });
  upstream.end();
}

function resolvePublicFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = path.resolve(PUBLIC_DIR, relative);
  if (!candidate.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  return candidate;
}

function sendFile(request, response, file, status = 200) {
  const stat = fs.statSync(file);
  const headers = {
    ...SECURITY_HEADERS,
    'Cache-Control': file.endsWith('icon.svg') ? 'public, max-age=86400' : 'public, max-age=0, must-revalidate',
    'Content-Length': stat.size,
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
  };
  response.writeHead(status, headers);
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(file).pipe(response);
}

function createYoriServer(options = {}) {
  const catboxUserhash = options.catboxUserhash ?? process.env.CATBOX_USERHASH ?? '';
  const derivedShareSecret = validUserhash(catboxUserhash)
    ? crypto.createHash('sha256').update(`yori-share:${catboxUserhash}`).digest('base64url')
    : crypto.randomBytes(32).toString('base64url');
  const config = {
    catboxEndpoint: options.catboxEndpoint || CATBOX_ENDPOINT,
    catboxUserhash,
    downloadProxyOrigin: options.downloadProxyOrigin || '',
    downloadWaitMs: options.downloadWaitMs ?? DOWNLOAD_WAIT_MS,
    shareSecret: options.shareSecret || process.env.SHARE_SECRET || derivedShareSecret,
    upstreamTimeoutMs: options.upstreamTimeoutMs || 10 * 60_000,
  };
  const uploadVisitorLimit = createLimiter(8, 60_000);
  const uploadGlobalLimit = createLimiter(120, 60_000);
  const ticketLimit = createLimiter(30, 60_000);
  const downloadLimit = createLimiter(30, 60_000);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, publicOrigin(request));
    const ip = requestIp(request);

    if (url.pathname === '/health' || url.pathname === '/healthz') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return sendJson(response, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
      }
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'Cache-Control': 'no-store',
        'Content-Length': '2',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      return request.method === 'HEAD' ? response.end() : response.end('OK');
    }

    if (url.pathname === '/api/upload') {
      if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'POST' });
      const origin = request.headers.origin;
      const fetchSite = request.headers['sec-fetch-site'];
      if ((origin && origin !== publicOrigin(request)) || (fetchSite && fetchSite !== 'same-origin')) {
        return sendJson(response, 403, { ok: false, error: 'Cross-site uploads are blocked.' });
      }
      if (request.headers['x-yori-upload'] !== '1') return sendJson(response, 400, { ok: false, error: 'Invalid upload request.' });
      if (request.headers['content-type'] !== 'application/octet-stream') {
        return sendJson(response, 415, { ok: false, error: 'Upload body must be a file.' });
      }
      if (!validUserhash(config.catboxUserhash)) {
        return sendJson(response, 503, { ok: false, error: 'Permanent storage is not configured.' });
      }
      if (!uploadVisitorLimit.take(ip) || !uploadGlobalLimit.take('global')) {
        return sendJson(response, 429, { ok: false, error: 'Too many uploads. Wait a minute and retry.' }, { 'Retry-After': '60' });
      }

      const size = Number(request.headers['content-length']);
      if (!Number.isSafeInteger(size) || size < 1) {
        return sendJson(response, size === 0 ? 400 : 411, { ok: false, error: size === 0 ? 'This file is empty.' : 'File size is required.' });
      }
      if (size > MAX_UPLOAD_BYTES) return sendJson(response, 413, { ok: false, error: 'Maximum file size is 200 MB.' });

      const filename = cleanFilename(request.headers['x-file-name']);
      const mime = safeMime(request.headers['x-file-type']);
      const extension = extensionOf(filename);
      if (BLOCKED_EXTENSIONS.has(extension) || extension.startsWith('doc')) {
        return sendJson(response, 415, { ok: false, error: `Catbox does not accept .${extension} files.` });
      }
      if (extension === 'gif' && size > GIF_MAX_BYTES) {
        return sendJson(response, 413, { ok: false, error: 'Catbox limits GIF files to 20 MB.' });
      }
      return uploadToCatbox(request, response, config, { filename, mime, size });
    }

    if (url.pathname === '/api/download-ticket') {
      if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET' });
      if (!ticketLimit.take(ip)) return sendJson(response, 429, { ok: false, error: 'Too many requests. Wait a minute and retry.' });
      const payload = url.searchParams.get('share') || '';
      const share = decodeSharePayload(payload, config.shareSecret);
      if (!share) return sendJson(response, 400, { ok: false, error: 'Invalid shared file.' });
      const ticket = createDownloadTicket(config.shareSecret, payload, config.downloadWaitMs);
      return sendJson(response, 200, {
        ok: true,
        readyAt: ticket.readyAt,
        expiresAt: ticket.expiresAt,
        waitMs: config.downloadWaitMs,
        downloadPath: `/d/${payload}?ticket=${encodeURIComponent(ticket.ticket)}`,
      });
    }

    const downloadMatch = url.pathname.match(/^\/d\/([A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{43})$/);
    if (downloadMatch) {
      if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET' });
      if (!downloadLimit.take(ip)) return sendJson(response, 429, { ok: false, error: 'Too many downloads. Wait a minute and retry.' });
      const payload = downloadMatch[1];
      const share = decodeSharePayload(payload, config.shareSecret);
      if (!share) return sendJson(response, 404, { ok: false, error: 'Invalid shared file.' });
      const verification = verifyDownloadTicket(config.shareSecret, payload, url.searchParams.get('ticket'));
      if (!verification.ok) {
        if (verification.status === 425) {
          return sendJson(response, 425, { ok: false, error: 'Please wait for the download button.' }, { 'Retry-After': String(verification.retryAfter) });
        }
        return sendJson(response, 403, { ok: false, error: 'This download link is invalid or expired.' });
      }
      return proxyDownload(request, response, share, config);
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/d/')) {
      return sendJson(response, 404, { ok: false, error: 'Not found.' });
    }

    const shareRouteMatch = url.pathname.match(/^\/v\/([A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{43})\/?$/);
    const isShareRoute = Boolean(shareRouteMatch && decodeSharePayload(shareRouteMatch[1], config.shareSecret));
    let file = isShareRoute ? path.join(PUBLIC_DIR, 'index.html') : resolvePublicFile(url.pathname);
    let status = 200;
    if (!file) {
      file = path.join(PUBLIC_DIR, '404.html');
      status = 404;
    }
    return sendFile(request, response, file, status);
  });

  server.requestTimeout = 10 * 60_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8888);
  const host = process.env.HOST || '0.0.0.0';
  const server = createYoriServer();
  server.listen(port, host, () => console.log(`Yori is running at http://${host}:${port}`));
}

module.exports = {
  CATBOX_FILE_HOST,
  MAX_UPLOAD_BYTES,
  createDownloadTicket,
  createSharePayload,
  createYoriServer,
  decodeSharePayload,
  verifyDownloadTicket,
};
