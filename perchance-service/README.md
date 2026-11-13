# Standalone Perchance Image Service

This Docker app runs independently of SOHAM's Node backend and can be deployed at its own Render URL. For reliable supported generation, open `/studio`: it uses Perchance's documented browser API from the user's browser and does not expose a service token. The server-side Python package route is best-effort and can fail when Perchance requires interactive verification; it relies on upstream internals and may break when Perchance changes them.

## Base URL and health checks

For a Render URL such as `https://your-perchance-service.onrender.com`:

| Method and path | Purpose | Calls Perchance? |
| --- | --- | --- |
| `GET /` | Service overview and route discovery | No |
| `GET /studio` | Official browser-based generation UI (recommended) | Yes, when the user clicks Generate |
| `GET /healthz` | Fast liveness check; recommended Render health-check path | No |
| `GET /health/live` | Liveness alias | No |
| `GET /health/ready` | Detailed readiness; checks token configuration and local Playwright/Chromium installation | No |
| `GET /api/health` | Detailed readiness alias | No |
| `GET /api/test` | Non-generative runtime diagnostics and live-test instructions | No |
| `GET /perchance` | Generation route details and sample request | No |
| `POST /perchance` | Generate an image and return image bytes (service token required) | Yes |
| `GET /perchance/generate?prompt=...` | Temporary tokenless generation test; 72-hour window and strict quotas | Yes |
| `POST /api/test/generate` | Run an actual test generation; optional body uses a built-in prompt (service token required) | Yes |
| `GET /docs` | Swagger UI | No |
| `GET /openapi.json` | OpenAPI document | No |

`/healthz` only says the HTTP process is alive. `/health/ready` and `/api/health` additionally check that the service token is set and that Playwright can start and its Chromium binary exists. They do not make an upstream Perchance request. `/api/test/generate` attempts server-side generation and may take up to four minutes; Perchance can reject server automation. Do not configure it as a health check. For supported generation, use `/studio` in a browser.

## Configure the service

Set this secret in the Render service's Environment page:

```text
PERCHANCE_SERVICE_TOKEN=<a long random secret>
```

The token is required for the server-side `POST /perchance` and `POST /api/test/generate` routes. It is not used by `/studio`. Do not expose it in browser code or commit it to Git.

### Temporary public GET test (less secure; 72 hours only)

`GET /perchance/generate` accepts the same generation parameters as the POST body, as query parameters, and does not require the service token. By default, the 72-hour clock starts when this service process starts. For a fixed deadline across restarts, set `PERCHANCE_PUBLIC_GET_EXPIRES_AT` to an ISO-8601 timestamp with a timezone (for example, `2026-11-16T12:35:24Z`) in Render; set it to an empty value to disable the route immediately. Once expired, it returns `410`; invalid or disabled expiry returns `503`.

This intentionally less-secure test route is limited to **3 attempts per client IP per rolling hour** and **10 attempts total per process per rolling hour**. Limits are in-memory and reset on restart; they are not a substitute for authentication and should not be treated as a production control. Avoid sensitive prompts because query strings may be recorded in access logs. Example:

```bash
curl -fS --get "$PERCHANCE_URL/perchance/generate" \
  --data-urlencode 'prompt=A fox under a pine tree in snowfall' \
  --data-urlencode 'shape=square' \
  -o perchance-image.png -D perchance-headers.txt
```

A successful response is image bytes. All the same upstream restrictions apply: if Perchance rejects server-side generation or requires interactive verification, the route returns the documented `503` error and does not attempt to bypass that protection. Keep the authenticated POST route for normal server integrations.

In Render, set the service health-check path to `/healthz`. The service binds to `0.0.0.0` and Render's `$PORT` (default `10000`).

## Generate an image

```bash
export PERCHANCE_URL='https://your-perchance-service.onrender.com'
read -s PERCHANCE_SERVICE_TOKEN
curl -fS -X POST "$PERCHANCE_URL/perchance" \
  -H "X-Perchance-Service-Token: $PERCHANCE_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"A fox in a snowy pine forest","shape":"square","negativePrompt":"text, watermark","seed":-1,"guidanceScale":7}' \
  -o perchance-image.png -D perchance-headers.txt
```

The success body is the image binary. Response headers include `Content-Type`, `X-Perchance-Seed`, `X-Perchance-Width`, `X-Perchance-Height`, and `X-Perchance-Extension`.

Run a built-in real-generation test (also returns image bytes):

```bash
curl -fS -X POST "$PERCHANCE_URL/api/test/generate" \
  -H "X-Perchance-Service-Token: $PERCHANCE_SERVICE_TOKEN" \
  -o perchance-test.png -D perchance-test-headers.txt
```

For a non-generative diagnostic report, use:

```bash
curl -i "$PERCHANCE_URL/api/test"
```

## Request fields and failures

- `prompt`: required, 1–1500 characters.
- `shape`: `portrait`, `square`, or `landscape` (default `square`).
- `negativePrompt`: optional, up to 500 characters.
- `seed`: `-1` for a random seed, otherwise a non-negative 32-bit integer.
- `guidanceScale`: 1–30 (default 7).

Errors return JSON: `401` missing/invalid service token; `413` image too large; `422` invalid input; `429` generation already in progress; `502` unexpected upstream failure; `503` token not configured or Perchance requires server-side browser verification; `504` generation timeout. On `PERCHANCE_BROWSER_VERIFICATION_REQUIRED`, no image was generated—use `/studio` or request an authorized server API from Perchance. The service does not try to bypass bot protections or fall back to another provider.

## SOHAM integration (optional)

The SOHAM Node backend can proxy this independent service through `POST /api/perchance`. Set `PERCHANCE_SERVICE_URL` on the Node service to this service's HTTPS origin and configure the same `PERCHANCE_SERVICE_TOKEN` on both services. This proxy is optional; the Perchance service itself does not call or require SOHAM.

## Free Render note

Render Free instances have constrained CPU and memory and spin down when idle. A cold start delays the first request, and headless Chromium may exceed the available resources. Health endpoints are safe and inexpensive; live generation is not guaranteed to succeed on the Free plan.
