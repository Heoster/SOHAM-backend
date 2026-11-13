# Standalone Perchance Image Service

This Docker app runs independently of SOHAM's Node backend. It can be deployed as its own Render Web Service and called directly at its own Render URL. It uses the pinned unofficial `eeemoon/perchance` Python package with Playwright/Chromium. The upstream implementation can break when Perchance changes its internals.

## Base URL and health checks

For a Render URL such as `https://your-perchance-service.onrender.com`:

| Method and path | Purpose | Calls Perchance? |
| --- | --- | --- |
| `GET /` | Service overview and route discovery | No |
| `GET /healthz` | Fast liveness check; recommended Render health-check path | No |
| `GET /health/live` | Liveness alias | No |
| `GET /health/ready` | Detailed readiness; checks token configuration and local Playwright/Chromium installation | No |
| `GET /api/health` | Detailed readiness alias | No |
| `GET /api/test` | Non-generative runtime diagnostics and live-test instructions | No |
| `GET /perchance` | Generation route details and sample request | No |
| `POST /perchance` | Generate an image and return image bytes | Yes |
| `POST /api/test/generate` | Run an actual test generation; optional body uses a built-in prompt | Yes |
| `GET /docs` | Swagger UI | No |
| `GET /openapi.json` | OpenAPI document | No |

`/healthz` only says the HTTP process is alive. `/health/ready` and `/api/health` additionally check that the service token is set and that Playwright can start and its Chromium binary exists. They do not make an upstream Perchance request. The `/api/test/generate` route performs a real generation and may take up to four minutes; do not configure it as a health check.

## Configure the service

Set this secret in the Render service's Environment page:

```text
PERCHANCE_SERVICE_TOKEN=<a long random secret>
```

The token is required for both generation routes. Do not expose it in browser code or commit it to Git.

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

Errors return JSON: `401` missing/invalid service token; `413` image too large; `422` invalid input; `429` generation already in progress; `502` upstream generation failure; `503` token not configured; `504` generation timeout. The service does not silently fall back to another image provider.

## SOHAM integration (optional)

The SOHAM Node backend can proxy this independent service through `POST /api/perchance`. Set `PERCHANCE_SERVICE_URL` on the Node service to this service's HTTPS origin and configure the same `PERCHANCE_SERVICE_TOKEN` on both services. This proxy is optional; the Perchance service itself does not call or require SOHAM.

## Free Render note

Render Free instances have constrained CPU and memory and spin down when idle. A cold start delays the first request, and headless Chromium may exceed the available resources. Health endpoints are safe and inexpensive; live generation is not guaranteed to succeed on the Free plan.
