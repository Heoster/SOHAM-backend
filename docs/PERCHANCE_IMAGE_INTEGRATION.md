# Perchance image generation in SOHAM

SOHAM now has two browser/server approaches:

- The official browser client in `image/perchance-browser-client.ts` uses Perchance's documented JSONP Image API. It is useful when generation should run in the user's browser.
- The isolated `perchance-service/` Docker service uses the third-party `eeemoon/perchance` Python package and Playwright/Chromium. This is exposed internally at `POST /perchance`; SOHAM's Node API proxies it at `POST /api/perchance`.

The Python package is unofficial and automates Perchance's current browser/API flow. It depends on upstream internals and may break if Perchance changes them. There is deliberately no fallback to Cloudflare, Pollinations, or another provider on this route.

## SOHAM API usage

Send the normal SOHAM API key to the Node backend:

```http
POST /api/perchance
Authorization: Bearer <SOHAM_API_KEY>
Content-Type: application/json
```

```json
{
  "prompt": "A warm cinematic illustration of a fox beneath a pine tree in snowfall",
  "style": "artistic",
  "shape": "square",
  "negativePrompt": "text, watermark",
  "seed": -1,
  "guidanceScale": 7
}
```

The response is JSON with `success`, `provider: "perchance"`, `imageUrl` (a data URL), `enhancedPrompt`, `contentType`, and Perchance image metadata. A timeout or upstream error is returned explicitly; no other provider is called.

The Python service's `POST /perchance` route is protected by `X-Perchance-Service-Token`. Render Blueprints generate that secret and pass it to the Node backend over Render's private service network. If the Python service is hosted separately, set `PERCHANCE_SERVICE_URL` on the Node service to its HTTPS origin; this overrides the internal host/port. Both services must use the same `PERCHANCE_SERVICE_TOKEN`. `GET /healthz` (also `/api/health`) is a liveness/capability check only and does not make a generation request.

## Render setup

The root `render.yaml` defines both services in Oregon on the Free plan:

- `soham-backend-server` (Node) — the public, SOHAM-authenticated `/api/perchance` route.
- `soham-perchance` (Docker) — a separate Playwright/Chromium runtime, with the internal `/perchance` route.

Deploy the Blueprint in Render. The Docker service installs the package at a pinned Git commit and downloads its matching Chromium browser and Debian libraries during image build. Do not expose `PERCHANCE_SERVICE_TOKEN` to the frontend or commit a copy of it.

**Free-tier caveat:** Render Free web services have 512 MB RAM and 0.1 CPU and spin down after 15 minutes idle. A cold start can add about a minute; Chromium image generation may exceed the available memory or time out. This configuration is a best-effort free-tier deployment, not a guarantee of reliable live image generation. A failed Perchance request stays a Perchance failure; it will not silently invoke another provider. See Render's [free instance limits](https://render.com/docs/free) and [compute plans](https://render.com/docs/compute-plans).

## Browser-client usage

For direct browser generation, `generateSOHAMPrimaryImage` applies SOHAM prompt enhancement and style hints, then uses Perchance's documented JSONP API:

```ts
import { generateSOHAMPrimaryImage } from './image/perchance-browser-client';

const result = await generateSOHAMPrimaryImage({
  prompt: 'A calm watercolor illustration of a small fox under a blue umbrella',
  style: 'artistic',
  timeoutMs: 180_000,
});
imageElement.src = result.url;
```

That path does not use the Python service. It performs Perchance's recommended best-effort origin warm-up, validates the HTTPS result URL, and does not fall back to another provider.

Official Perchance API documentation: <https://perchance.org/perchance-ai-api>
Unofficial package: <https://github.com/eeemoon/perchance>
