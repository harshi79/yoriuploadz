#!/usr/bin/env node
/**
 * YoriUpload — local dev server (no dependencies, no netlify-cli required).
 *
 * Serves public/ and emulates the parts of Netlify the relay functions rely on:
 *   - the /api/* redirects from netlify.toml
 *   - the SPA fallback used by /v/<token> share links
 *   - the lambda-style `event` object, including base64-encoded binary bodies
 *
 * Usage:
 *   node scripts/dev-server.js              # real upstream storage providers
 *   MOCK_UPSTREAM=1 node scripts/dev-server.js   # offline: fake storage, no network
 *   PORT=8080 node scripts/dev-server.js
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8888);
const HOST = process.env.HOST || '0.0.0.0';
const MOCK = process.env.MOCK_UPSTREAM === '1';

const ROUTES = {
  '/api/upload': 'netlify/functions/upload.js',
  '/api/import': 'netlify/functions/import-url.js',
  '/api/diag': 'netlify/functions/diag.js',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Netlify sends text bodies as-is and everything else base64-encoded. */
function isTextBody(contentType) {
  return /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded))/i.test(contentType || '');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ------------------------- offline mock storage ------------------------- */
/* Lets you exercise the whole upload flow (including fallbacks) with no
   network access at all. Files are kept in memory and served back. */

const mockStore = new Map();

function mockHandler(req, res, url, body) {
  const id = Math.random().toString(36).slice(2, 8);
  if (url.pathname === '/__mock/tmpfiles') {
    const link = `http://localhost:${PORT}/__mock/file/${id}`;
    mockStore.set(id, body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: { url: link.replace('/__mock/file/', '/') } }));
    return;
  }
  mockStore.set(id, body);
  const host =
    url.pathname === '/__mock/temp'
      ? 'https://litter.catbox.moe'
      : url.pathname === '/__mock/zerox'
        ? 'https://0x0.st'
        : 'https://files.catbox.moe';
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`${host}/${id}.bin`);
}

function applyMockEnv() {
  const base = `http://127.0.0.1:${PORT}/__mock`;
  process.env.UPSTREAM_TEMP_URL = `${base}/temp`;
  process.env.UPSTREAM_PERMANENT_URL = `${base}/perm`;
  process.env.UPSTREAM_ZEROX_URL = `${base}/zerox`;
  process.env.UPSTREAM_TMPFILES_URL = `${base}/tmpfiles`;
}

/* ------------------------------- server -------------------------------- */

if (MOCK) applyMockEnv();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (MOCK && url.pathname.startsWith('/__mock')) {
    const body = await readBody(req);
    return mockHandler(req, res, url, body);
  }

  const fnFile = ROUTES[url.pathname];
  if (fnFile) {
    const body = await readBody(req);
    const contentType = req.headers['content-type'] || '';
    const isBase64Encoded = body.length > 0 && !isTextBody(contentType);
    const event = {
      httpMethod: req.method,
      path: url.pathname,
      headers: req.headers,
      queryStringParameters: Object.fromEntries(url.searchParams.entries()),
      body: body.length ? (isBase64Encoded ? body.toString('base64') : body.toString('utf8')) : null,
      isBase64Encoded,
    };

    const fnPath = path.join(ROOT, fnFile);
    try {
      delete require.cache[require.resolve(fnPath)];
      const { handler } = require(fnPath);
      const out = await handler(event, {});
      res.writeHead(out.statusCode, out.headers || {});
      res.end(out.body || '');
    } catch (err) {
      console.error(`[dev] ${url.pathname} crashed:`, err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Function crashed: ${err.message}` }));
    }
    console.log(`[dev] ${req.method} ${url.pathname} -> ${res.statusCode}`);
    return;
  }

  // Static files, with the SPA fallback that makes /v/<token> links work.
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const candidate = path.join(PUBLIC_DIR, path.normalize(requested).replace(/^(\.\.[/\\])+/, ''));
  const file = candidate.startsWith(PUBLIC_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(PUBLIC_DIR, 'index.html');

  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

server.listen(PORT, HOST, () => {
  console.log(`YoriUpload dev server on http://${HOST}:${PORT}`);
  console.log(MOCK ? 'Upstream storage: MOCKED (offline mode)' : 'Upstream storage: real providers');
});
