# Yori

A focused file-sharing interface backed by permanent, account-associated Catbox storage. Visitors upload without creating an account; a Cloudflare Worker keeps the operator's Catbox `userhash` secret.

## Storage behavior

Checked against the official provider documentation on **7 September 2026**:

- Catbox describes files associated with an account as permanent, with no scheduled expiry or inactivity timer.
- “Permanent” is not a guarantee that a third-party service will exist forever. Catbox can remove files for policy, legal, abuse, account, or service reasons.
- The selected Cloudflare relay limits each request to **100 MB**, below Catbox's 200 MB provider limit.
- Catbox rejects `.exe`, `.scr`, `.cpl`, `.doc*`, and `.jar` files. GIF files are limited to 20 MB.
- Files are public to anyone who has their `files.catbox.moe` URL.
- Visitors do not log in. Every successful upload is associated with the operator's Catbox account through a Worker secret.

Official references:

- [Catbox FAQ](https://catbox.moe/faq.php)
- [Catbox API tools](https://catbox.moe/tools.php)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

## Deploy to Cloudflare

### 1. Create the storage account

1. Create or sign in to the single Catbox account that will own the uploads.
2. Copy its user hash from the Catbox account page.
3. Do **not** put that value in HTML, JavaScript, `wrangler.jsonc`, Git, logs, or chat.

The operator account is responsible for all public uploads made through the site. Review it regularly and remove abusive files.

### 2. Configure and deploy the Worker

Node.js 22 or newer is required by the pinned Wrangler release.

```bash
npm install
npm run cf:login
npm run deploy
npm run cf:secret
```

The first deploy creates the Worker and publishes everything in `public/` as one site; uploads remain disabled until the secret is set. `npm run cf:secret` then securely prompts for `CATBOX_USERHASH`, stores it with Cloudflare, and activates a new Worker version without committing the value. Attach a custom domain in the Cloudflare dashboard if needed.

If the secret is added in the Cloudflare dashboard instead, create an encrypted Worker secret named exactly `CATBOX_USERHASH`, then redeploy.

### 3. Verify production

Open the deployed site and upload a small allowed file. A successful response must point to `https://files.catbox.moe/...`; confirm the new file also appears in the operator's Catbox account so its association is verified. Live upstream delivery cannot be validated by the build alone, and Catbox may reject some cloud-network traffic, so complete this check after deployment.

## Run locally

Create an ignored local secret file only if real upload testing is required:

```bash
npm install
cp .dev.vars.example .dev.vars
# Replace the placeholder in .dev.vars locally.
npm run dev
```

Open <http://localhost:8888>. Wrangler serves the static site and `/api/upload` on `0.0.0.0`.

For interface-only work without Wrangler or a secret:

```bash
npm run dev:static
```

The static server cannot process `/api/upload`.

## Validation

```bash
npm run check
npm run build
```

`check` runs browser-script and Worker syntax checks plus Worker route/upload tests. `build` also asks Wrangler to validate and bundle the deployment without publishing it.

## Architecture

```text
Browser ── raw file (same origin) ──► Cloudflare Worker
                                      ├─ origin and rate-limit checks
                                      ├─ protected CATBOX_USERHASH
                                      └─ streamed multipart request ──► Catbox account
Browser ◄── files.catbox.moe URL ◄─────────────────────────────────────┘

Browser ──► /v/<encoded display metadata> ──► Yori shared-file page
```

The browser sends the raw file to avoid multipart overhead at Cloudflare's 100 MB request-body ceiling. The Worker streams it into Catbox's required multipart format instead of buffering the complete file in Worker memory. It accepts successful URLs only from `files.catbox.moe`.

The Yori share URL contains only the Catbox URL, display name, size, and MIME type. The Catbox user hash never reaches the browser. Recent-link history stays in browser `localStorage` and is not synchronized by Yori.

Public upload endpoints attract abuse. The Worker rejects cross-site browser requests, requires a same-origin request marker, limits uploads per visitor and globally, and enforces provider restrictions. These are mitigations, not authentication.

## Project layout

```text
public/               static interface, viewer, terms, and Cloudflare headers
worker/index.mjs      upload validation and streamed Catbox relay
tests/worker.test.mjs Worker route and upload tests
scripts/dev-server.js dependency-free interface-only server
wrangler.jsonc        Worker assets and rate-limit configuration
```

## License

MIT — see [LICENSE](LICENSE).
