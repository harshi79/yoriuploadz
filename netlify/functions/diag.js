/**
 * YoriUpload — deployment self-check.
 *
 * GET /api/diag tells you, from inside the deployed function, whether each
 * storage provider is reachable and what it answers. That is the fastest way
 * to tell "my site is broken" apart from "the storage provider is blocking
 * this datacenter IP today".
 *
 * GET /api/diag?live=1 additionally performs a real 12-byte test upload
 * through the normal code path, so you see the exact error the uploader sees.
 *
 * When APP_SECRET is set the endpoint requires the access key, so a private
 * deployment does not leak its configuration.
 */

'use strict';

const { CORS, checkAccess, clientIp, json, makeRateLimiter } = require('../lib/http');
const { DEFAULT_BUDGET_MS, chainFor, probeProviders, storeFile } = require('../lib/upstream');

const rateLimited = makeRateLimiter({ windowMs: 60 * 1000, max: 10 });

exports.handler = async (event) => {
  const headers = event.headers || {};

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }

  const denied = checkAccess(headers);
  if (denied) return denied;

  if (rateLimited(clientIp(headers))) {
    return json(429, { ok: false, error: 'Too many diagnostics requests. Please wait a moment.' });
  }

  const params = event.queryStringParameters || {};
  const started = Date.now();

  const report = {
    ok: true,
    time: new Date().toISOString(),
    runtime: {
      node: process.version,
      hasFetch: typeof fetch === 'function',
      hasFormData: typeof FormData === 'function',
      hasBlob: typeof Blob === 'function',
      region: process.env.AWS_REGION || null,
    },
    config: {
      appSecret: Boolean(process.env.APP_SECRET),
      catboxUserhash: Boolean(process.env.CATBOX_USERHASH),
      uploadBudgetMs: DEFAULT_BUDGET_MS,
      chains: {
        temp: chainFor('temp'),
        permanent: chainFor('permanent'),
        url: chainFor('url'),
      },
    },
    providers: await probeProviders(3500),
  };

  if (params.live === '1' || params.live === 'true') {
    const buffer = Buffer.from('yoriupload\n', 'utf8');
    const expiry = ['1h', '12h', '24h', '72h'].includes(params.expiry) ? params.expiry : '1h';
    const result = await storeFile(
      buffer,
      { filename: 'yoriupload-selftest.txt', mime: 'text/plain', expiry },
      { budgetMs: Math.max(3000, DEFAULT_BUDGET_MS - (Date.now() - started)) }
    );
    report.liveUpload = {
      expiry,
      ok: result.ok,
      url: result.url || null,
      provider: result.provider || null,
      error: result.ok ? null : result.error,
      attempts: result.attempts,
    };
    report.ok = result.ok;
  }

  report.elapsedMs = Date.now() - started;
  return json(report.ok ? 200 : 502, report);
};
