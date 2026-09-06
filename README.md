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
- Static site + two dependency-free Netlify Functions (no `npm install` needed)

## Deploy to Netlify

1. Push this repo to GitHub (or connect it via the Netlify UI).
2. In Netlify: **Add new site → Import from Git** → pick the repo.
3. No build command is needed; publish directory is `public` (set in
   `netlify.toml`, functions are picked up from `netlify/functions`).
4. Deploy. That's it.

Local development (optional):

```bash
npx netlify-cli dev
```

## Configuration (Netlify → Site configuration → Environment variables)

| Variable         | Effect                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| `APP_SECRET`     | **Optional.** If set, visitors must enter this key once to upload/import. Leave empty to make the site fully open. |
| `CATBOX_USERHASH`| **Optional.** If set, permanent uploads are associated with that account (anonymous uploads otherwise). |

You can also copy `.env.example` to `.env` for local testing.

## Limits (important — read this)

- **Per-file upload limit is ~4 MB**, because Netlify Functions cap binary request
  bodies at ~6 MB (~4.5 MB after base64 encoding). This is a Netlify platform
  limit, not something this app can raise.
- Image files (PNG/JPEG/WebP/etc.) larger than 4 MB are downscaled automatically in
  the browser so most photos still fit.
- Non-image files over 4 MB are rejected with a clear message.
- Files smaller than that are accepted; the upstream storage service uses public
  links for everyone, so keep uploads appropriate and private.

## How it works (for the operator)

```
Browser ──► /api/upload (Netlify Function relay) ──► storage service
Browser ──► /api/import (Netlify Function relay) ──► storage service
Browser ──► /v/<token>  (share viewer, served by this site)
```

- The browser never talks to the storage service directly, so there are no CORS
  issues and the infrastructure stays out of view.
- Temporary uploads go to the ephemeral storage service (1h–72h); permanent
  uploads go to the permanent service.
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
public/                   # What visitors see (nothing else is published)
  index.html              #   Landing, uploader and share viewer
  styles.css              #   Styling
  app.js                  #   Client logic (upload, paste, history, viewer)
  terms.html / 404.html   #   Info pages
  icon.svg                #   Favicon
```

## License

MIT — see [LICENSE](LICENSE).
