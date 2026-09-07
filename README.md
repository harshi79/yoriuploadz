# Yori

A Dockerized file-sharing service for Render. Visitors upload and download on Yori; Catbox stores the file, but the browser is never redirected there.

## Does Catbox require an API key or account?

Catbox's official tools page documents an HTTP form endpoint at `https://catbox.moe/user/api.php`. Yori must call that endpoint to upload a file, but **Catbox does not require an API key**.

The `userhash` field is optional:

- Omit `userhash`: anonymous upload, no account required.
- Include an account `userhash`: the file is associated with that account.

Catbox's FAQ says anonymous files are removed after two years without a hit, while account-associated uploads are permanent. Because Yori's requirement is permanent storage, this build keeps `CATBOX_USERHASH` as one protected Render environment variable. It is not an API key and visitors never see it or log in.

Official references:

- [Catbox API tools](https://catbox.moe/tools.php)
- [Catbox FAQ](https://catbox.moe/faq.php)
- [Catbox acceptable-use policy](https://catbox.moe/legal.php)

## File flow

```text
UPLOAD
Browser ── raw file ──► Yori ── streamed multipart + userhash ──► Catbox account
Browser ◄──────────── signed Yori /v/... link ◄─────────────────┘

DOWNLOAD
Yori link ── five-second signed gate ──► Yori /d/... endpoint
Browser ◄── attachment stream ◄── Yori ◄── files.catbox.moe
```

- Upload and download bodies are streamed instead of buffered in memory.
- Catbox's direct URL is not returned by the browser API or used as an interface action.
- Share paths are signed so visitors cannot turn Yori into a proxy for arbitrary Catbox files.
- Download tickets are signed, server-enforced, and expire after 15 minutes.
- Requesting a download before five seconds returns HTTP 425.
- Downloads keep the upstream file type and use `Content-Disposition: attachment`, so ZIPs, images, videos, and other files download without navigating away.
- Supported range requests are forwarded for resumable downloads.

## Deploy on Render Free with Docker

A Blueprint is not required.

1. Open the [Render dashboard](https://dashboard.render.com/).
2. Choose **New → Web Service** and connect this GitHub repository.
3. Select the branch containing this code, or merge it into `main` first.
4. Set **Language** to **Docker**. Render automatically finds the root `Dockerfile`.
5. Choose the **Free** instance type.
6. Add one environment variable:
   - Key: `CATBOX_USERHASH`
   - Value: the user hash from the operator's Catbox account
7. Under **Advanced**, set **Health Check Path** to `/health`.
8. Create the service.

No build command or start command is needed for the Docker runtime. The image runs its tests while building, starts the dependency-free Node server on Render's `PORT`, and runs as an unprivileged user.

The signing key is derived server-side from the protected Catbox userhash with domain-separated SHA-256. You can optionally set a separate `SHARE_SECRET`, but it is not required. Changing either value invalidates previously issued Yori share links.

Official Render references:

- [Docker on Render](https://render.com/docs/docker)
- [Web services and port binding](https://render.com/docs/web-services)
- [Render Free](https://render.com/docs/free)
- [Health checks](https://render.com/docs/health-checks)

## UptimeRobot health monitor

The same lightweight Node process exposes:

```text
GET /health     → 200 OK, body: OK
HEAD /health    → 200 OK
GET /healthz    → 200 OK, body: OK
```

Create an UptimeRobot HTTP monitor for:

```text
https://YOUR-SERVICE.onrender.com/health
```

A five-minute interval is sufficient. The endpoint performs no Catbox request, file access, database work, or secret lookup. Regular pings consume Render Free instance hours; Render currently grants 750 hours per workspace each month.

## Provider and free-host limits

Checked on **7 September 2026**:

- Yori accepts files up to 200 MB, matching Catbox's advertised maximum.
- Catbox blocks `.exe`, `.scr`, `.cpl`, `.doc*`, and `.jar`; GIF files are limited to 20 MB.
- Account-associated uploads have no scheduled expiry, but no third party can guarantee literal forever storage.
- Catbox can remove policy-violating files and ban the owning account.
- Catbox requires prior approval for commercial services and prohibits using its files as an external video-streaming source. Yori forces attachment downloads rather than embedding or streaming media. Obtain Catbox approval before monetizing this service.
- Render Free services normally spin down after 15 minutes without traffic and can take about one minute to wake.
- Relayed uploads and downloads consume Render bandwidth. High external-storage traffic can exhaust the free allowance or trigger suspension.
- Catbox may reject traffic from some cloud networks, so verify one real upload after deploying.

## Local development

```bash
npm install
cp .env.example .env
# Put the account userhash only in the ignored .env file.
npm run dev
```

Open <http://localhost:8888>. Without `CATBOX_USERHASH`, uploads fail closed with HTTP 503; static pages, health checks, and automated tests still work.

## Docker validation

```bash
docker build -t yoriupload .
docker run --rm -p 10000:10000 yoriupload
curl http://localhost:10000/health
```

Expected response:

```text
OK
```

## Tests

```bash
npm test
npm run check
npm run build
```

The local test suite verifies streamed multipart uploads, exact Catbox-host validation, signed share paths, the server-enforced wait, attachment proxying without redirects, `/health`, blocked cross-site uploads, prohibited extensions, and 404 behavior.

## Security

The upload endpoint has per-IP and global in-memory rate limits, same-origin browser checks, size restrictions, extension checks, and an exact `files.catbox.moe` result allowlist. The download endpoint accepts only server-signed Catbox files and signed wait tickets.

The Yori share path contains signed, URL-safe Base64 metadata. Base64 is not encryption: Catbox files remain public to anyone who discovers their underlying provider URL. The operator is responsible for all content associated with the Catbox account.

## Project layout

```text
Dockerfile           tested, unprivileged Render container
.dockerignore        minimal Docker build context
public/              3D brutalist uploader and gated download interface
server.js            health route, static server, upload relay, download proxy
tests/server.test.js local end-to-end tests with a fake Catbox server
```

## License

MIT — see [LICENSE](LICENSE).
