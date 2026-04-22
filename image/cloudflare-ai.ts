/**
 * Cloudflare Workers AI — REST client
 *
 * The `env.AI.run()` binding is only available inside a Cloudflare Worker
 * runtime.  When running on Next.js (Vercel / Node) we call the same model
 * through Cloudflare's public REST API:
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}
 *
 * Docs: https://developers.cloudflare.com/workers-ai/get-started/rest-api/
 *
 * Required env vars:
 *   CLOUDFLARE_ACCOUNT_ID   — found in the Cloudflare dashboard sidebar
 *   CLOUDFLARE_AI_API_TOKEN — an API token with "Workers AI:Edit" permission
 *
 * Optional env var:
 *   CLOUDFLARE_AI_GATEWAY_ID — AI Gateway slug (e.g. "default") for caching /
 *                              analytics.  When set, requests are routed through
 *                              https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/workers-ai/{model}
 */

const CF_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const CF_GW_BASE = 'https://gateway.ai.cloudflare.com/v1';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CFImageRequest {
  /** Text prompt for the image */
  prompt: string;
  /** Aspect ratio string, e.g. "16:9", "1:1", "9:16" */
  aspect_ratio?: string;
  /** Number of inference steps (higher = better quality, slower) */
  num_steps?: number;
  /** Guidance scale */
  guidance?: number;
}

export interface CFImageResult {
  /** Base64-encoded PNG/JPEG returned by the API */
  imageBase64: string;
  /** MIME type of the returned image */
  contentType: string;
  /** Model that was used */
  model: string;
}

export interface CFTextRequest {
  prompt: string;
  max_tokens?: number;
  temperature?: number;
}

export interface CFTextResult {
  response: string;
  model: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getCredentials() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_AI_API_TOKEN;
  const gatewayId = process.env.CLOUDFLARE_AI_GATEWAY_ID; // optional

  if (!accountId || !apiToken) {
    throw new Error(
      'Cloudflare AI credentials missing. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_API_TOKEN.'
    );
  }

  return { accountId, apiToken, gatewayId };
}

/**
 * Build the endpoint URL.
 * Uses AI Gateway when CLOUDFLARE_AI_GATEWAY_ID is set, otherwise direct API.
 */
function buildEndpoint(accountId: string, model: string, gatewayId?: string): string {
  if (gatewayId) {
    // AI Gateway URL format
    return `${CF_GW_BASE}/${accountId}/${gatewayId}/workers-ai/${model}`;
  }
  return `${CF_BASE}/${accountId}/ai/run/${model}`;
}

// ── Image Generation ───────────────────────────────────────────────────────────

/**
 * Generate an image using a Cloudflare Workers AI image model.
 *
 * Default model: @cf/black-forest-labs/flux-1-schnell
 * Other options:  @cf/stabilityai/stable-diffusion-xl-base-1.0
 *                 @cf/lykon/dreamshaper-8-lcm
 *
 * Returns a base64 data URL ready to embed in <img src="…">.
 */
export async function cfGenerateImage(
  request: CFImageRequest,
  model = '@cf/black-forest-labs/flux-1-schnell'
): Promise<CFImageResult> {
  const { accountId, apiToken, gatewayId } = getCredentials();
  const endpoint = buildEndpoint(accountId, model, gatewayId);

  const body: Record<string, unknown> = {
    prompt: request.prompt,
  };
  if (request.aspect_ratio) body.aspect_ratio = request.aspect_ratio;
  if (request.num_steps !== undefined) body.num_steps = request.num_steps;
  if (request.guidance !== undefined) body.guidance = request.guidance;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`Cloudflare AI image error ${response.status}: ${errText.substring(0, 200)}`);
  }

  const contentType = response.headers.get('content-type') ?? 'image/png';

  // Cloudflare returns raw binary for image models
  if (contentType.startsWith('image/')) {
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return {
      imageBase64: `data:${contentType};base64,${base64}`,
      contentType,
      model,
    };
  }

  // Some models wrap the result in JSON with a base64 field
  const json = await response.json() as any;
  if (json?.result?.image) {
    const b64 = json.result.image as string;
    const mime = 'image/png';
    return {
      imageBase64: b64.startsWith('data:') ? b64 : `data:${mime};base64,${b64}`,
      contentType: mime,
      model,
    };
  }

  throw new Error(`Unexpected Cloudflare AI response format: ${JSON.stringify(json).substring(0, 200)}`);
}

// ── Text / Chat ────────────────────────────────────────────────────────────────

/**
 * Run a text-generation model on Cloudflare Workers AI.
 * Default model: @cf/meta/llama-3.1-8b-instruct
 */
export async function cfGenerateText(
  request: CFTextRequest,
  model = '@cf/meta/llama-3.1-8b-instruct'
): Promise<CFTextResult> {
  const { accountId, apiToken, gatewayId } = getCredentials();
  const endpoint = buildEndpoint(accountId, model, gatewayId);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: request.prompt,
      max_tokens: request.max_tokens ?? 1024,
      temperature: request.temperature ?? 0.7,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`Cloudflare AI text error ${response.status}: ${errText.substring(0, 200)}`);
  }

  const json = await response.json() as any;
  const text: string = json?.result?.response ?? json?.response ?? '';

  return { response: text, model };
}

// ── Token verification (utility) ───────────────────────────────────────────────

/**
 * Verify a Cloudflare API token.
 * Equivalent to: curl https://api.cloudflare.com/client/v4/user/tokens/verify
 */
export async function verifyCFToken(token: string): Promise<{ valid: boolean; message: string }> {
  const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await response.json() as any;
  return {
    valid: json?.success === true,
    message: json?.messages?.[0]?.message ?? (json?.success ? 'Token is valid' : 'Token is invalid'),
  };
}
