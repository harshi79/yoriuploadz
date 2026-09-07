# Yori

Permanent Catbox file sharing through a single Render web service. Visitors upload and download on Yori without creating an account or being redirected to Catbox.

## How it works

```text
Upload
Browser ── raw file ──► Yori on Render ── streamed multipart ──► Catbox account
Browser ◄────────────── Yori /v/... share link ◄───────────────┘

Download
Yori share page ── signed five-second ticket ──► Yori download endpoint
Browser ◄── attachment stream ◄── Yori ◄── files.catbox.moe
```

- The operator's `CATBOX_USERHASH` stays in a protected Render environment variable.
- Files are associated with that Catbox account, so visitors never log in.
- The share page enforces a five-second wait before enabling its download button.
- The download button uses a signed, expiring ticket. Requesting it early returns HTTP 425.
- File bytes are streamed back through Yori with `Content-Disposition: attachment`; there is no Catbox redirect.
- ZIP files, images, videos, and other accepted types keep their upstream content type.
- Range requests are forwarded so supported downloads can resume.
- Neither uploads nor downloads are buffered completely in server memory.

## Storage limits

Provider details were checked on **7 September 2026**:

- Catbox describes account-associated files as permanent, with no scheduled expiry or inactivity timer.
- Permanent is not a guarantee that a third-party service will exist forever. Catbox can remove files for policy, legal, abuse, account, or service reasons.
- Yori accepts files up to **200 MB**, matching Catbox's advertised maximum.
- Catbox rejects `.exe`, `.scr`, `.cpl`, `.doc*`, and `.jar` files. GIF files are limited to 20 MB.
- Anyone with a Yori share link can download its file.

Official references:

- [Catbox FAQ](https://catbox.moe/faq.php)
- [Catbox API tools](https://catbox.moe/tools.php)

## Easiest deployment: Render Blueprint

No CLI, Docker, database, or Cloudflare configuration is required.

1. Create or sign in to the Catbox account that will own all uploads.
2. Copy its user hash from the Catbox account page. Never put it in source code or chat.
3. Sign in to [Render](https://dashboard.render.com/) with GitHub.
4. Choose **New → Blueprint** and select this repository.
5. Render reads `render.yaml`. When prompted for `CATBOX_USERHASH`, paste the hash there.
6. Click **Apply**. Render builds the app, starts it, and gives you an HTTPS `onrender.com` address.
7. Upload a small test file and confirm it appears in the operator's Catbox account.

`SHARE_SECRET` is generated automatically by Render. It signs the five-second download tickets and requires no manual setup. A custom domain can be attached later from the Render dashboard.

### Render Free limitations

Render's Free web service is easy to deploy, but it is intended for hobby projects:

- It spins down after 15 minutes without traffic; the first request afterward can take about one minute while it wakes.
- The workspace receives 750 Free instance hours per month.
- Relayed uploads and downloads consume Render bandwidth. Heavy external-storage traffic can exhaust the free allowance or trigger suspension.
- Catbox might reject traffic from a cloud-hosting network. Verify one real account-associated upload after deployment.

Upgrading the same Render service removes the free-instance sleep without changing the code or URLs.

Official Render references:

- [Deploy for Free](https://render.com/docs/free)
- [Blueprint specification](https://render.com/docs/blueprint-spec)
- [Regions](https://render.com/docs/regions)

## Local development

```bash
npm install
cp .env.example .env
# Add CATBOX_USERHASH only to your ignored .env file.
npm run dev
```

Open <http://localhost:8888>. The server reads `.env` during local development and binds to `0.0.0.0`.

Real Catbox delivery can only be tested when a valid userhash is configured. Without it, the upload endpoint fails closed with `503 Permanent storage is not configured`.

## Validation

```bash
npm test
npm run check
npm run build
```

The tests use a local fake Catbox server and verify:

- streamed account-associated multipart uploads;
- trusted `files.catbox.moe` result validation;
- server-enforced download waiting;
- signed and expiring download tickets;
- same-origin attachment streaming without redirects;
- blocked cross-site uploads and prohibited extensions;
- app-shell, API, and 404 routes.

## Security notes

The public upload endpoint has per-IP and global in-memory rate limits, rejects cross-site browser requests, validates size and extension restrictions, and accepts successful URLs only from `files.catbox.moe`. Download proxying also validates that exact HTTPS host and requires a signed ticket.

These controls reduce casual abuse but are not authentication. The operator remains responsible for files associated with the Catbox account and should review that account regularly.

The Yori share URL contains the Catbox file URL plus display metadata encoded as URL-safe Base64 and signed by the server. The signature prevents visitors from turning Yori into a proxy for arbitrary Catbox files. Encoding is not encryption; Catbox files remain public to anyone who knows their underlying URL. Recent-link history stays only in browser `localStorage`.

## Project layout

```text
public/              uploader, five-second download page, terms, styles
server.js            static server, Catbox relay, tickets, download proxy
render.yaml          one-screen Render Blueprint configuration
tests/server.test.js local end-to-end upload and download tests
```

## License

MIT — see [LICENSE](LICENSE).
