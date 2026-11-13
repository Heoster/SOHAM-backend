# Perchance image generation in SOHAM

SOHAM includes a browser-only client at `image/perchance-browser-client.ts` for Perchance's documented Image API. Perchance's documented integration is an iframe plus `postMessage`; it is not a backend REST provider. The SOHAM backend must not fetch Perchance pages or use reverse-engineered private endpoints.

## Frontend usage

Import `generatePerchanceImage` into the browser-side image-generation flow:

```ts
import { generatePerchanceImage } from './image/perchance-browser-client';

const controller = new AbortController();
try {
  const result = await generatePerchanceImage({
    prompt: 'A calm watercolor illustration of a small fox under a blue umbrella',
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  imageElement.src = result.url;
} catch (error) {
  // Show an error and let the user explicitly retry or select a different provider.
  // Do not silently invoke a potentially billable provider.
}
```

The helper validates Perchance's message origin, API marker, matching request ID, and HTTPS result URL. It removes its hidden iframe/listeners on success, failure, abort, or timeout, and caps concurrent requests at two. It does not automatically fall back to Cloudflare or another image provider.

## UI requirements

- Add a Perchance option to the frontend's image-provider control; it runs in the browser, unlike `/api/image/generate`.
- Show loading/cancel/error states. Perchance may be unavailable, change its message protocol, or block iframe requests.
- Display the returned `url` directly. If SOHAM should copy it into its own storage, implement an explicit, server-validated upload flow separately; do not send service-role credentials to the browser.
- Keep the existing Cloudflare image route and its opt-in/cost gate unchanged.
- The backend health report exposes `image.perchanceBrowser` as an integration capability. It is not a live Perchance reachability probe.

Official documentation: <https://perchance.org/perchance-ai-api>
