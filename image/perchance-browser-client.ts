/**
 * Browser-only client for Perchance's documented Image API.
 *
 * This must run in a browser. It uses Perchance's documented JSONP callback
 * mode to avoid iframe postMessage handshakes; never call this from Node or
 * reverse-engineer private generator endpoints.
 */

import { engineerImagePrompt } from './image-prompt-engineer';

const PERCHANCE_ORIGIN = 'https://perchance.org';
const PERCHANCE_API_URL = `${PERCHANCE_ORIGIN}/perchance-ai-api`;
const MAX_CONCURRENT_REQUESTS = 2;
const WARMUP_TIMEOUT_MS = 15_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;
let activeRequests = 0;
let warmupPromise: Promise<boolean> | undefined;

/**
 * Perchance recommends opening its origin once before generation so its
 * Cloudflare challenge can complete. This is best-effort: a warm-up timeout
 * does not prevent the actual generation attempt.
 */
export function warmUpPerchance(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(false);
  }
  if (warmupPromise) return warmupPromise;

  warmupPromise = new Promise<boolean>(resolve => {
    const iframe = document.createElement('iframe');
    iframe.src = PERCHANCE_ORIGIN;
    iframe.title = 'Connect to Perchance';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.position = 'absolute';
    iframe.style.width = '1px';
    iframe.style.height = '1px';
    iframe.style.left = '-10000px';
    iframe.style.border = '0';

    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      iframe.remove();
      if (!loaded) warmupPromise = undefined;
      resolve(loaded);
    };
    const timer = setTimeout(() => finish(false), WARMUP_TIMEOUT_MS);
    iframe.onload = () => setTimeout(() => finish(true), 500);
    iframe.onerror = () => finish(false);
    try {
      document.body.appendChild(iframe);
    } catch {
      finish(false);
    }
  });
  return warmupPromise;
}

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

export interface SOHAMPerchanceImageOptions extends PerchanceImageOptions {
  style?: 'realistic' | 'artistic' | 'anime' | 'sketch';
}

export interface SOHAMPerchanceImageResult extends PerchanceImageResult {
  enhancedPrompt: string;
  aspectRatio: string;
}

interface PerchanceJSONPResponse {
  ok?: boolean;
  url?: string;
  seed?: number | string;
  error?: string;
  id?: string;
  result?: PerchanceJSONPResponse;
}

/**
 * Request an image using Perchance's documented JSONP mode. A unique callback
 * avoids CORS and postMessage handshakes, with no fallback to other providers.
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
  return warmUpPerchance().then(() => new Promise<PerchanceImageResult>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const callbackName = `__soham_perchance_${requestId.replace(/-/g, '')}`;
    const params = new URLSearchParams({ prompt, format: 'json', id: requestId, callback: callbackName });
    const script = document.createElement('script');
    script.src = `${PERCHANCE_API_URL}?${params.toString()}`;
    script.async = true;

    const timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS, DEFAULT_GENERATION_TIMEOUT_MS));
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const callbackWindow = window as unknown as Record<string, (response: PerchanceJSONPResponse) => void>;

    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      script.remove();
      delete callbackWindow[callbackName];
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
    callbackWindow[callbackName] = response => {
      const result = response?.result ?? response;
      if (result?.id && result.id !== requestId) return;
      if (!result?.ok || !result.url) {
        finish(new Error(result?.error || 'Perchance could not generate the image'));
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
    script.onerror = () => finish(new Error('Could not load Perchance JSONP response; check browser network/CSP or Perchance availability'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new Error('Perchance image generation timed out')), timeoutMs);
    try {
      document.body.appendChild(script);
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Could not start the Perchance JSONP request'));
    }
  }));
}

/**
 * SOHAM's primary browser image-generation entry point. It keeps SOHAM's prompt
 * enhancement and style hints, then generates through Perchance first-party API.
 */
export async function generateSOHAMPrimaryImage(options: SOHAMPerchanceImageOptions): Promise<SOHAMPerchanceImageResult> {
  const engineered = engineerImagePrompt(options.prompt);
  const styleGuides: Record<NonNullable<SOHAMPerchanceImageOptions['style']>, string> = {
    realistic: 'Photorealistic, high detail, natural lighting, professional photography.',
    artistic: 'Artistic, painterly, expressive brushstrokes, vibrant colors.',
    anime: 'Anime art style, clean lines, cel-shaded, vibrant colors, Japanese animation aesthetic.',
    sketch: 'Pencil sketch, hand-drawn, artistic linework, monochrome or light shading.',
  };
  const enhancedPrompt = options.style
    ? `${engineered.positive}. ${styleGuides[options.style]}`
    : engineered.positive;
  const result = await generatePerchanceImage({
    prompt: enhancedPrompt,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  return { ...result, enhancedPrompt, aspectRatio: engineered.aspectRatio };
}
