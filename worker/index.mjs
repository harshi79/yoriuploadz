const CATBOX_ENDPOINT = 'https://catbox.moe/user/api.php';
const MAX_UPLOAD_BYTES = 100_000_000;
const GIF_MAX_BYTES = 20_000_000;
const BLOCKED_EXTENSIONS = new Set(['exe', 'scr', 'cpl', 'jar']);
const FILE_URL_PATTERN = /^https:\/\/files\.catbox\.moe\/[A-Za-z0-9._-]+$/;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' blob: data: https://files.catbox.moe; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function json(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      ...extraHeaders,
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function withSecurityHeaders(response) {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
  return secured;
}

function cleanFilename(value) {
  let name = String(value || 'file');
  try {
    name = decodeURIComponent(name);
  } catch {
    // Use the original value when it is not valid percent encoding.
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
  const mime = String(value || '').trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}

function extensionOf(filename) {
  const index = filename.lastIndexOf('.');
  return index < 0 ? '' : filename.slice(index + 1).toLowerCase();
}

function firstLine(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^error\s*:?\s*/i, '')
    .slice(0, 220);
}

function validUserhash(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(value);
}

function multipartUpload(request, { filename, mime, userhash, size }) {
  const boundary = `----yori-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="reqtype"\r\n\r\n' +
      'fileupload\r\n' +
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="userhash"\r\n\r\n' +
      `${userhash}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="fileToUpload"; filename="${filename.replace(/"/g, '')}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const totalLength = prefix.byteLength + size + suffix.byteLength;
  const { readable, writable } = new FixedLengthStream(totalLength);

  const pump = (async () => {
    let writer = writable.getWriter();
    await writer.write(prefix);
    writer.releaseLock();

    await request.body.pipeTo(writable, { preventClose: true });

    writer = writable.getWriter();
    await writer.write(suffix);
    await writer.close();
  })();

  return { boundary, body: readable, pump };
}

async function allowedByRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const [visitor, global] = await Promise.all([
    env.UPLOAD_RATE_LIMITER?.limit({ key: `upload:${ip}` }) || { success: true },
    env.GLOBAL_RATE_LIMITER?.limit({ key: 'all-uploads' }) || { success: true },
  ]);
  return visitor.success && global.success;
}

async function upload(request, env) {
  if (!validUserhash(env.CATBOX_USERHASH)) {
    return json(503, { ok: false, error: 'Permanent storage is not configured.' });
  }

  const requestUrl = new URL(request.url);
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if ((origin && origin !== requestUrl.origin) || (fetchSite && fetchSite !== 'same-origin')) {
    return json(403, { ok: false, error: 'Cross-site uploads are blocked.' });
  }
  if (request.headers.get('x-yori-upload') !== '1') {
    return json(400, { ok: false, error: 'Invalid upload request.' });
  }
  if (request.headers.get('content-type') !== 'application/octet-stream') {
    return json(415, { ok: false, error: 'Upload body must be a file.' });
  }
  if (!(await allowedByRateLimit(request, env))) {
    return json(429, { ok: false, error: 'Too many uploads. Wait a minute and retry.' }, { 'Retry-After': '60' });
  }

  const size = Number(request.headers.get('content-length'));
  if (!Number.isSafeInteger(size) || size < 1 || !request.body) {
    return json(size === 0 ? 400 : 411, { ok: false, error: size === 0 ? 'This file is empty.' : 'File size is required.' });
  }
  if (size > MAX_UPLOAD_BYTES) {
    return json(413, { ok: false, error: 'Maximum file size is 100 MB.' });
  }

  const filename = cleanFilename(request.headers.get('x-file-name'));
  const mime = safeMime(request.headers.get('x-file-type'));
  const extension = extensionOf(filename);
  if (BLOCKED_EXTENSIONS.has(extension) || extension.startsWith('doc')) {
    return json(415, { ok: false, error: `Catbox does not accept .${extension} files.` });
  }
  if (extension === 'gif' && size > GIF_MAX_BYTES) {
    return json(413, { ok: false, error: 'Catbox limits GIF files to 20 MB.' });
  }

  const multipart = multipartUpload(request, {
    filename,
    mime,
    userhash: env.CATBOX_USERHASH,
    size,
  });

  let upstream;
  try {
    const upstreamRequest = fetch(CATBOX_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
        'User-Agent': 'YoriUpload/2.1',
      },
      body: multipart.body,
      duplex: 'half',
      redirect: 'manual',
    });
    [upstream] = await Promise.all([upstreamRequest, multipart.pump]);
  } catch (error) {
    console.error('Catbox upload failed', error instanceof Error ? error.message : String(error));
    return json(502, { ok: false, error: 'Permanent storage could not be reached.' });
  }

  const text = (await upstream.text()).trim();
  if (upstream.ok && FILE_URL_PATTERN.test(text)) {
    return json(200, {
      ok: true,
      url: text,
      name: filename,
      size,
      type: mime,
      permanent: true,
    });
  }

  const detail = firstLine(text).replaceAll(env.CATBOX_USERHASH, '[redacted]');
  const status = upstream.status >= 500 ? 502 : upstream.status === 429 ? 429 : upstream.status === 413 ? 413 : 422;
  console.error('Catbox rejected upload', JSON.stringify({ status: upstream.status, detail }));
  return json(status, {
    ok: false,
    error: detail || `Catbox rejected the upload (HTTP ${upstream.status}).`,
  });
}

async function asset(request, env, pathname) {
  if (/^\/v\/[A-Za-z0-9_-]+\/?$/.test(pathname)) {
    const indexUrl = new URL(request.url);
    indexUrl.pathname = '/';
    indexUrl.search = '';
    return withSecurityHeaders(await env.ASSETS.fetch(new Request(indexUrl, request)));
  }
  return withSecurityHeaders(await env.ASSETS.fetch(request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/upload') {
      if (request.method !== 'POST') {
        return json(405, { ok: false, error: 'Method not allowed.' }, { Allow: 'POST' });
      }
      return upload(request, env);
    }
    if (url.pathname.startsWith('/api/')) {
      return json(404, { ok: false, error: 'Not found.' });
    }
    return asset(request, env, url.pathname);
  },
};

