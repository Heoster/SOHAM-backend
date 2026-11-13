/**
 * Browser-only client for Perchance's documented Image API.
 *
 * This must run in the SOHAM frontend. Perchance's public API is an iframe +
 * postMessage protocol, not a backend REST/image endpoint; never fetch the
 * Perchance page from Node or reverse-engineer its private generator endpoints.
 */

const PERCHANCE_ORIGIN = 'https://perchance.org';
const PERCHANCE_API_URL = `${PERCHANCE_ORIGIN}/perchance-ai-api`;
const MAX_CONCURRENT_REQUESTS = 2;
let activeRequests = 0;

export interface PerchanceImageOptions {
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PerchanceImageResult {
  ok: true;
  url: string;
  seed?: number | string;
}

interface PerchanceMessage {
  api?: string;
  result?: {
    id?: string;
    ok?: boolean;
    url?: string;
    seed?: number | string;
    error?: string;
  };
}

/**
 * Request an image from Perchance in a browser, resolving only messages from
 * Perchance's origin with the matching request ID. This function does not
 * silently invoke another image provider if Perchance fails.
 */
export function generatePerchanceImage(options: PerchanceImageOptions): Promise<PerchanceImageResult> {
  const prompt = options.prompt.trim();
  if (!prompt) return Promise.reject(new Error('Perchance image prompt is required'));
  if (prompt.length > 2000) return Promise.reject(new Error('Perchance image prompt must be 2000 characters or fewer'));
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('Perchance image generation is browser-only'));
  }
  if (options.signal?.aborted) return Promise.reject(new Error('Perchance image request was cancelled'));
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    return Promise.reject(new Error('Perchance is busy; wait for an image to finish before starting another'));
  }

  activeRequests++;
  return new Promise<PerchanceImageResult>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const params = new URLSearchParams({ prompt, format: 'json', id: requestId });
    const iframe = document.createElement('iframe');
    iframe.src = `${PERCHANCE_API_URL}?${params.toString()}`;
    iframe.title = 'Perchance image generation';
    iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.position = 'absolute';
    iframe.style.width = '1px';
    iframe.style.height = '1px';
    iframe.style.left = '-10000px';
    iframe.style.border = '0';

    const timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? 60_000, 120_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      options.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      iframe.remove();
      activeRequests = Math.max(0, activeRequests - 1);
    };
    const finish = (error?: Error, result?: PerchanceImageResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error('Perchance returned an empty response'));
    };
    const onAbort = () => finish(new Error('Perchance image request was cancelled'));
    const onMessage = (event: MessageEvent<PerchanceMessage>) => {
      if (event.origin !== PERCHANCE_ORIGIN) return;
      const message = event.data;
      if (message?.api !== 'perchance-image-api' || message.result?.id !== requestId) return;
      const result = message.result;
      if (!result.ok || !result.url) {
        finish(new Error(result.error || 'Perchance could not generate the image'));
        return;
      }
      try {
        const imageUrl = new URL(result.url);
        if (imageUrl.protocol !== 'https:') throw new Error('Perchance returned a non-HTTPS image URL');
        finish(undefined, { ok: true, url: imageUrl.href, seed: result.seed });
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Perchance returned an invalid image URL'));
      }
    };

    window.addEventListener('message', onMessage);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new Error('Perchance image generation timed out')), timeoutMs);
    try {
      document.body.appendChild(iframe);
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Could not start the Perchance iframe'));
    }
  });
}
