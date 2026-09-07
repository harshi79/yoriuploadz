# Yori

A focused, account-free file-sharing interface. Files upload directly from the browser to GoFile guest storage, so they do not pass through Netlify Functions.

## What changed in v2

- Replaced the unreliable Catbox/Litterbox serverless relay with GoFile's browser upload API
- Removed the Netlify binary-body bottleneck that capped uploads at roughly 4 MB
- Removed unsupported expiry controls, URL import, diagnostics, and misleading privacy/permanence claims
- Added accurate upload progress, cancellation, retry, offline handling, image preview, native sharing, and local recent-link history
- Restricted Yori viewer redirects to known storage hosts
- Added a strict Content Security Policy and hardened production headers
- Rebuilt the interface and shared-file page with responsive and accessible states

## Current storage behavior

Checked against GoFile's official API and terms on **7 September 2026**:

- Basic guest upload requires no sign-up, email, or operator API key
- GoFile automatically issues a guest token; Yori keeps it in that browser and reuses it without exposing it in share links
- GoFile publishes no fixed per-file size limit for guest uploads
- Free storage is ephemeral and has no guaranteed retention period
- Free traffic, content-count, abuse, and rate limits still apply
- Files are uploaded to `https://upload.gofile.io/uploadfile`
- Successful uploads return a GoFile download page wrapped in a Yori `/v/…` share link

“Free” does not mean unlimited guaranteed infrastructure. Never present guest storage as permanent or use it as the only copy of a file.

Official references:

- [GoFile API](https://gofile.io/api)
- [GoFile Terms](https://gofile.io/terms)
- [GoFile Privacy Policy](https://gofile.io/privacy)

## Run locally

```bash
npm run dev
```

Open <http://localhost:8888>. The server binds to `0.0.0.0` by default. Override with `HOST` or `PORT` when needed.

```bash
HOST=0.0.0.0 PORT=3000 npm run dev
npm run check
npm run build
```

The browser must be able to connect to GoFile for real uploads. There is no local storage mock.

## Deploy to Netlify

1. Connect the repository to Netlify.
2. Leave the build command empty or use `npm run build`.
3. Publish `public`.
4. Deploy.

`netlify.toml` already configures the `/v/*` viewer rewrite, cache behavior, and security headers. No environment variables or secrets are required.

## Architecture

```text
Browser ── file bytes ──► GoFile guest upload API
        ◄─ download page ──┘

Browser ──► /v/<encoded metadata> ──► Yori shared-file page
```

Only display metadata is encoded in a share URL: provider URL, file name, size, and MIME type. The GoFile guest token is never included. The token and recent links stay in localStorage and are never synchronized by Yori.

## Project layout

```text
public/
  index.html       uploader and shared-file view
  app.js           upload flow, viewer, and local history
  styles.css       responsive visual system
  terms.html       service and provider disclosures
  404.html         not-found page
  icon.svg         favicon
scripts/
  dev-server.js    dependency-free local static server
netlify.toml       production routing and security headers
```

## License

MIT — see [LICENSE](LICENSE).
