# YoriUpload

A fast, private file-sharing website you can host on **Netlify** in a few clicks.
Drag in a file (or paste it, or import from a URL), get a link, share it anywhere.
No account, no tracking, nothing to install.

Shares are served through this site (`.netlify.app/v/...`), so it looks and feels
like one self-contained service — the uploader UI, the relay, and the share pages
all live on your own domain.

## Features

- Drag & drop, file picker, clipboard paste, and URL import
- Link expiry: 1 h / 12 h / 24 h / 72 h / permanent (real expirations)
- Images are auto-optimized client-side so they fit the upload limit
- Optional **access key** (site can be made invite-only)
- Share links that point at your own domain (with a built-in viewer page)
- Upload history in the browser (localStorage only)
- Dark, mobile-friendly UI — zero dependencies, zero CDNs
- **Automatic storage failover** — if the primary provider refuses or stalls, the
  relay retries the next one instead of failing the upload
- **Self-check endpoint** (`/api/diag`) and a "Run diagnostics" button on every
  error, so a failed upload tells you *why*
- Static site + dependency-free Netlify Functions (no `npm install` needed)

## Deploy to Netlify

1. Push this repo to GitHub (or connect it via the Netlify UI).
2. In Netlify: **Add new site → Import from Git** → pick the repo.
3. No build command is needed; publish directory is `public` (set in
   `netlify.toml`, functions are picked up from `netlify/functions`).
4. Deploy. That's it.

Local development (optional):

```bash
npm run dev          # netlify-cli (closest to production)
npm run dev:local    # no dependencies: emulates the Netlify redirects + functions
npm run dev:offline  # same, but with mocked storage — works with no network at all
```

Then open <http://localhost:8888>.

## Configuration (Netlify → Site configuration → Environment variables)

| Variable         | Effect                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| `APP_SECRET`     | **Optional.** If set, visitors must enter this key once to upload/import. Leave empty to make the site fully open. |
| `CATBOX_USERHASH`| **Optional.** If set, permanent uploads are associated with that account (anonymous uploads otherwise). |
| `UPLOAD_BUDGET_MS`| **Optional.** Total time the relay may spend talking to storage. Default `9000`, deliberately under Netlify's 10 s function timeout. Raise it only if your plan allows longer-running functions. |
| `UPSTREAM_ORDER`  | **Optional.** Comma-separated provider order, e.g. `zerox,catbox`. Valid ids: `litterbox`, `catbox`, `zerox`, `tmpfiles`. |
| `UPSTREAM_DISABLED`| **Optional.** Comma-separated provider ids to never use, e.g. `tmpfiles`. |

You can also copy `.env.example` to `.env` for local testing.

### Storage providers and failover

| Link type | Order tried |
| --------- | ----------- |
| 1 h / 12 h / 24 h / 72 h | Litterbox → 0x0.st → tmpfiles.org |
| Permanent | Catbox → 0x0.st |
| URL import | Catbox → 0x0.st |

The whole chain runs inside `UPLOAD_BUDGET_MS`; the first provider gets most of
the budget and a slice is always reserved so a fallback can still be attempted.
When a fallback is used the UI says so, because retention differs per provider
(0x0.st keeps files roughly 30–365 days; tmpfiles.org only ~1 hour).

## Limits (important — read this)

- **Per-file upload limit is ~4 MB**, because Netlify Functions cap binary request
  bodies at ~6 MB (~4.5 MB after base64 encoding). This is a Netlify platform
  limit, not something this app can raise.
- Image files (PNG/JPEG/WebP/etc.) larger than 4 MB are downscaled automatically in
  the browser so most photos still fit.
- Non-image files over 4 MB are rejected with a clear message.
- Files smaller than that are accepted; the upstream storage service uses public
  links for everyone, so keep uploads appropriate and private.

## Troubleshooting "upload fails"

1. **Open `/api/diag` on your deployed site** (e.g.
   `https://your-site.netlify.app/api/diag`). It reports, from inside the
   function, the Node runtime, the active provider chain, and whether each
   provider is reachable. Add `?live=1` to also run a real 12-byte test upload
   and see the exact upstream error. If `APP_SECRET` is set, send the key as the
   `x-access-key` header — or just use the **Run diagnostics** button that now
   appears under any upload error in the UI.
2. **Read the error text in the UI.** It now includes the HTTP status, the
   provider, and the upstream's own message instead of a generic
   "Something went wrong".
3. Common causes and what they look like:

   | Symptom | Cause | Fix |
   | ------- | ----- | --- |
   | `Catbox: invalid Uploader` / HTTP 403 from Catbox | Catbox blocks many datacenter IP ranges, and Netlify Functions run from one | Nothing to fix locally — the relay now fails over to `0x0.st`. To skip Catbox entirely set `UPSTREAM_ORDER=zerox`. |
   | `HTTP 502/504 — Task timed out` | The upload ran past Netlify's 10 s function limit | Already mitigated by `UPLOAD_BUDGET_MS=9000`; upload smaller files, or raise the limit if your plan allows longer functions. |
   | `HTTP 413` | File bigger than 4 MB | Netlify caps function request bodies at ~6 MB (~4.4 MB before base64). Not raisable in this architecture. |
   | `HTTP 403 … requires an access key` | `APP_SECRET` is set | Enter the key when prompted; it is stored in localStorage. |
   | `404` on `/api/upload` | Functions were not deployed | Confirm `netlify/functions` is the functions directory and redeploy. |
4. **Check the function log** in Netlify → *Logs → Functions*. Every failure logs
   a JSON line with the full attempt trail (provider, HTTP status, upstream text).

## How it works (for the operator)

```
Browser ──► /api/upload (Netlify Function relay) ──► storage service
Browser ──► /api/import (Netlify Function relay) ──► storage service
Browser ──► /api/diag   (self-check: which provider is reachable?)
Browser ──► /v/<token>  (share viewer, served by this site)
```

- The browser never talks to the storage service directly, so there are no CORS
  issues and the infrastructure stays out of view.
- Temporary uploads go to the ephemeral storage service (1h–72h); permanent
  uploads go to the permanent service. Each has a fallback provider, so one
  upstream refusing traffic (a common cause of "upload fails") no longer takes
  the site down.
- It is possible to point the functions at your own deployment via
  `UPSTREAM_PERMANENT_URL` / `UPSTREAM_TEMP_URL` — useful when self-hosting or
  testing the same code against a different backend.

## Security notes for the operator

- If you set `APP_SECRET`, never commit it; it lives only in Netlify env vars.
- The functions contain a small per-instance rate limit as a first line of defence.
- Add your own abuse/monitoring in the Netlify dashboard if you open the site publicly.
- Keep the terms page up to date for your jurisdiction.

## Project layout

```
netlify.toml              # Netlify config: publish dir, redirects, headers
netlify/functions/        # Dependency-free relay functions
  upload.js               #   POST /api/upload  (raw file bytes → storage)
  import-url.js           #   POST /api/import  (direct URL → storage)
  diag.js                 #   GET  /api/diag    (deployment self-check)
netlify/lib/              # Shared relay code
  upstream.js             #   provider chain, failover, time budget
  http.js                 #   JSON responses, access key, rate limiting
scripts/dev-server.js     # Dependency-free local emulator of the above
public/                   # What visitors see (nothing else is published)
  index.html              #   Landing, uploader and share viewer
  styles.css              #   Styling
  app.js                  #   Client logic (upload, paste, history, viewer)
  terms.html / 404.html   #   Info pages
  icon.svg                #   Favicon
```

## License

MIT — see [LICENSE](LICENSE).
