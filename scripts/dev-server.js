#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8888);
const HOST = process.env.HOST || '0.0.0.0';

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

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const isShareRoute = /^\/v\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  let file = isShareRoute ? path.join(PUBLIC_DIR, 'index.html') : resolvePublicFile(url.pathname);
  let status = 200;

  if (!file) {
    file = path.join(PUBLIC_DIR, '404.html');
    status = 404;
  }

  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  };
  response.writeHead(status, headers);
  if (request.method === 'HEAD') response.end();
  else response.end(fs.readFileSync(file));
});

server.listen(PORT, HOST, () => {
  console.log(`Yori is running at http://${HOST}:${PORT}`);
});
