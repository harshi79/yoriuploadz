'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const {
  createDownloadTicket,
  createSharePayload,
  createYoriServer,
  decodeSharePayload,
  verifyDownloadTicket,
} = require('../server');

const USERHASH = 'test-userhash-1234567890';
const SHARE_SECRET = 'test-share-secret-that-is-long-enough';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function sharePayload(overrides = {}) {
  return createSharePayload(SHARE_SECRET, {
    u: 'https://files.catbox.moe/test-file.zip',
    n: 'archive.zip',
    s: 7,
    t: 'application/zip',
    ...overrides,
  });
}

function uploadHeaders(origin, name = 'archive.zip') {
  return {
    'Content-Type': 'application/octet-stream',
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
    'x-file-name': encodeURIComponent(name),
    'x-file-type': 'application/zip',
    'x-yori-upload': '1',
  };
}

test('download tickets enforce the five-second server wait', () => {
  const payload = sharePayload();
  const now = 1_800_000_000_000;
  const ticket = createDownloadTicket(SHARE_SECRET, payload, 5_000, now);

  assert.equal(ticket.readyAt, now + 5_000);
  assert.equal(verifyDownloadTicket(SHARE_SECRET, payload, ticket.ticket, now + 4_999).status, 425);
  assert.equal(verifyDownloadTicket(SHARE_SECRET, payload, ticket.ticket, now + 5_000).ok, true);
  assert.equal(verifyDownloadTicket(SHARE_SECRET, `${payload}x`, ticket.ticket, now + 5_000).status, 403);
});

test('share payloads require a valid signature and HTTPS files.catbox.moe target', () => {
  const valid = sharePayload();
  const tampered = `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(decodeSharePayload(valid, SHARE_SECRET).target.hostname, 'files.catbox.moe');
  assert.equal(decodeSharePayload(tampered, SHARE_SECRET), null);
  assert.equal(decodeSharePayload(sharePayload({ u: 'https://attacker.test/file.zip' }), SHARE_SECRET), null);
  assert.equal(decodeSharePayload(sharePayload({ u: 'http://files.catbox.moe/file.zip' }), SHARE_SECRET), null);
});

test('streams uploads to Catbox and downloads back through Yori without redirects', async (context) => {
  let uploadBody = Buffer.alloc(0);
  let downloadedPath = '';
  const fileBody = Buffer.from('ZIPDATA');

  const storage = http.createServer((request, response) => {
    if (request.url === '/upload' && request.method === 'POST') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        uploadBody = Buffer.concat(chunks);
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('https://files.catbox.moe/test-file.zip\n');
      });
      return;
    }

    downloadedPath = request.url;
    response.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': fileBody.byteLength,
      'Content-Type': 'application/zip',
    });
    response.end(fileBody);
  });
  const storageOrigin = await listen(storage);

  const yori = createYoriServer({
    catboxEndpoint: `${storageOrigin}/upload`,
    catboxUserhash: USERHASH,
    downloadProxyOrigin: storageOrigin,
    downloadWaitMs: 200,
    shareSecret: SHARE_SECRET,
    upstreamTimeoutMs: 2_000,
  });
  const yoriOrigin = await listen(yori);
  context.after(async () => {
    await close(yori);
    await close(storage);
  });

  const upload = await fetch(`${yoriOrigin}/api/upload`, {
    method: 'POST',
    headers: uploadHeaders(yoriOrigin),
    body: fileBody,
  });
  assert.equal(upload.status, 200);
  const uploaded = await upload.json();
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.name, 'archive.zip');
  assert.equal(uploaded.size, 7);
  assert.equal(uploaded.type, 'application/zip');
  assert.equal(uploaded.permanent, true);
  assert.equal('url' in uploaded, false);
  assert.match(uploaded.sharePath, /^\/v\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);

  const multipart = uploadBody.toString('utf8');
  assert.match(multipart, /name="reqtype"\r\n\r\nfileupload/);
  assert.match(multipart, new RegExp(`name="userhash"\\r\\n\\r\\n${USERHASH}`));
  assert.match(multipart, /name="fileToUpload"; filename="archive.zip"/);
  assert.match(multipart, /Content-Type: application\/zip\r\n\r\nZIPDATA/);

  const payload = uploaded.sharePath.slice(3);
  const viewer = await fetch(`${yoriOrigin}/v/${payload}`);
  assert.equal(viewer.status, 200);
  assert.match(await viewer.text(), /id="viewerDownload"/);

  const ticketResponse = await fetch(`${yoriOrigin}/api/download-ticket?share=${payload}`);
  assert.equal(ticketResponse.status, 200);
  const ticket = await ticketResponse.json();
  assert.equal(ticket.ok, true);
  assert.equal(ticket.waitMs, 200);
  assert.match(ticket.downloadPath, new RegExp(`^/d/${payload}\\?ticket=`));

  const tooEarly = await fetch(`${yoriOrigin}${ticket.downloadPath}`);
  assert.equal(tooEarly.status, 425);
  assert.equal(tooEarly.headers.get('retry-after'), '1');

  await delay(210);
  const download = await fetch(`${yoriOrigin}${ticket.downloadPath}`, { redirect: 'manual' });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('location'), null);
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.match(download.headers.get('content-disposition'), /attachment;/);
  assert.equal(Buffer.from(await download.arrayBuffer()).toString(), 'ZIPDATA');
  assert.equal(downloadedPath, '/test-file.zip');
});

test('fails closed without the Catbox secret and blocks invalid routes', async (context) => {
  const yori = createYoriServer({ catboxUserhash: '', shareSecret: SHARE_SECRET });
  const origin = await listen(yori);
  context.after(() => close(yori));

  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'OK');
  assert.equal((await fetch(`${origin}/health`, { method: 'HEAD' })).status, 200);

  const upload = await fetch(`${origin}/api/upload`, {
    method: 'POST',
    headers: uploadHeaders(origin),
    body: Buffer.from('abc'),
  });
  assert.equal(upload.status, 503);
  assert.deepEqual(await upload.json(), { ok: false, error: 'Permanent storage is not configured.' });

  assert.equal((await fetch(`${origin}/v/bad/extra`)).status, 404);
  assert.equal((await fetch(`${origin}/missing`)).status, 404);
  assert.equal((await fetch(`${origin}/api/nope`)).status, 404);
});

test('blocks cross-site uploads and Catbox-prohibited extensions', async (context) => {
  const yori = createYoriServer({ catboxUserhash: USERHASH, shareSecret: SHARE_SECRET });
  const origin = await listen(yori);
  context.after(() => close(yori));

  const crossSite = await fetch(`${origin}/api/upload`, {
    method: 'POST',
    headers: uploadHeaders('https://attacker.test'),
    body: Buffer.from('abc'),
  });
  assert.equal(crossSite.status, 403);

  const blocked = await fetch(`${origin}/api/upload`, {
    method: 'POST',
    headers: uploadHeaders(origin, 'proposal.docx'),
    body: Buffer.from('abc'),
  });
  assert.equal(blocked.status, 415);
});
