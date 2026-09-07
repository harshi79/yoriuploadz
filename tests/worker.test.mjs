import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../worker/index.mjs';

const USERHASH = 'test-userhash-1234567890';

function uploadRequest({
  name = 'photo.png',
  type = 'image/png',
  body = new TextEncoder().encode('abc'),
  size = body.byteLength,
  origin = 'https://yori.test',
} = {}) {
  return new Request('https://yori.test/api/upload', {
    method: 'POST',
    headers: {
      'Content-Length': String(size),
      'Content-Type': 'application/octet-stream',
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      'x-file-name': encodeURIComponent(name),
      'x-file-type': type,
      'x-yori-upload': '1',
    },
    body,
  });
}

function env(overrides = {}) {
  return {
    CATBOX_USERHASH: USERHASH,
    ASSETS: {
      fetch: async (request) => new Response(new URL(request.url).pathname, { status: 200 }),
    },
    UPLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) },
    GLOBAL_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  };
}

test('rejects Catbox-blocked extensions before contacting storage', async () => {
  for (const name of ['malware.exe', '.exe', 'proposal.docx']) {
    const response = await worker.fetch(uploadRequest({ name }), env());
    assert.equal(response.status, 415);
    assert.match((await response.json()).error, /^Catbox does not accept \./);
  }
});

test('serves the app shell for a share route', async () => {
  let assetPath = '';
  const response = await worker.fetch(new Request('https://yori.test/v/payload'), env({
    ASSETS: {
      fetch: async (request) => {
        assetPath = new URL(request.url).pathname;
        return new Response('app');
      },
    },
  }));

  assert.equal(response.status, 200);
  assert.equal(assetPath, '/');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('rejects non-POST API requests', async () => {
  const response = await worker.fetch(new Request('https://yori.test/api/upload'), env());
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
});

test('fails closed when the protected Catbox secret is absent', async () => {
  const response = await worker.fetch(uploadRequest(), env({ CATBOX_USERHASH: '' }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'Permanent storage is not configured.' });
});

test('blocks cross-site and oversized upload attempts', async () => {
  const crossSite = await worker.fetch(
    uploadRequest({ origin: 'https://attacker.test' }),
    env()
  );
  assert.equal(crossSite.status, 403);

  const oversized = await worker.fetch(uploadRequest({ size: 100_000_001 }), env());
  assert.equal(oversized.status, 413);
});

test('enforces both upload rate limit bindings', async () => {
  const response = await worker.fetch(uploadRequest(), env({
    UPLOAD_RATE_LIMITER: { limit: async () => ({ success: false }) },
  }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
});

test('streams multipart bytes to Catbox and accepts only its file host', async () => {
  const originalFetch = globalThis.fetch;
  const originalFixedLengthStream = globalThis.FixedLengthStream;
  globalThis.FixedLengthStream = class extends TransformStream {
    constructor() {
      super();
    }
  };

  let multipart = '';
  let upstreamUrl = 'https://files.catbox.moe/a1b2c3.png';
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://catbox.moe/user/api.php');
    assert.match(options.headers['Content-Type'], /^multipart\/form-data; boundary=/);
    multipart = new TextDecoder().decode(await new Response(options.body).arrayBuffer());
    return new Response(upstreamUrl, { status: 200 });
  };

  try {
    const response = await worker.fetch(uploadRequest(), env());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      url: 'https://files.catbox.moe/a1b2c3.png',
      name: 'photo.png',
      size: 3,
      type: 'image/png',
      permanent: true,
    });
    assert.match(multipart, /name="reqtype"\r\n\r\nfileupload/);
    assert.match(multipart, new RegExp(`name="userhash"\\r\\n\\r\\n${USERHASH}`));
    assert.match(multipart, /name="fileToUpload"; filename="photo.png"/);
    assert.match(multipart, /Content-Type: image\/png\r\n\r\nabc/);

    upstreamUrl = 'https://attacker.test/not-catbox.png';
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const rejected = await worker.fetch(uploadRequest(), env());
      assert.equal(rejected.status, 422);
      assert.equal((await rejected.json()).ok, false);
    } finally {
      console.error = originalConsoleError;
    }
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.FixedLengthStream = originalFixedLengthStream;
  }
});
