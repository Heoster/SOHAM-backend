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
 *   CLOUDFLARE_AI_API_TOKEN — a token with Workers AI Read and Edit permissions
 *
 * Optional env var:
 *   CLOUDFLARE_AI_GATEWAY_ID — AI Gateway slug (e.g. "default") for analytics,
 *                              caching, and gateway policies.
 */

const CF_BASE = 'https://api.cloudflare.com/client/v4/accounts';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CFImageRequest {
  /** Text prompt for the image (FLUX.1 schnell accepts 1–2048 characters). */
  prompt: string;
  /** Diffusion steps; FLUX.1 schnell supports at most 8 (default 4). */
  steps?: number;
}

export interface CFImageResult {
  /** Base64 data URI containing the generated PNG/JPEG image. */
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
  const gatewayId = process.env.CLOUDFLARE_AI_GATEWAY_ID?.trim() || undefined; // optional

  if (!accountId || !apiToken) {
    throw new Error(
      'Cloudflare AI credentials missing. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_API_TOKEN.'
    );
  }

  return { accountId, apiToken, gatewayId };
}

/**
 * Build the direct REST endpoint; AI Gateway routing is selected with its documented header.
 */
function buildEndpoint(accountId: string, model: string): string {
  return `${CF_BASE}/${encodeURIComponent(accountId)}/ai/run/${model}`;
}

function gatewayHeaders(gatewayId?: string): Record<string, string> {
  return gatewayId ? { 'cf-aig-gateway-id': gatewayId } : {};
}

// ── Image Generation ───────────────────────────────────────────────────────────

/**
 * Generate an image using a Cloudflare Workers AI image model.
 *
 * Uses the documented @cf/black-forest-labs/flux-1-schnell model and its
 * `prompt` + `steps` input schema. Returns a base64 data URL for <img src>.
 */
export async function cfGenerateImage(
  request: CFImageRequest,
  model = '@cf/black-forest-labs/flux-1-schnell'
): Promise<CFImageResult> {
  if (process.env.ENABLE_CLOUDFLARE_IMAGE_AI !== 'true') {
    throw new Error('Cloudflare image AI is disabled; set ENABLE_CLOUDFLARE_IMAGE_AI=true to opt in.');
  }
  const { accountId, apiToken, gatewayId } = getCredentials();
  const endpoint = buildEndpoint(accountId, model);

  const prompt = request.prompt.trim();
  if (!prompt || prompt.length > 2048) {
    throw new Error('Cloudflare FLUX prompt must be between 1 and 2048 characters.');
  }
  const steps = request.steps ?? 4;
  if (!Number.isInteger(steps) || steps < 1 || steps > 8) {
    throw new Error('Cloudflare FLUX steps must be an integer from 1 to 8.');
  }
  const body: Record<string, unknown> = { prompt, steps };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...gatewayHeaders(gatewayId),
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
 * Low-level text-generation helper. The routed chat integration uses CloudflareAdapter.
 */
export async function cfGenerateText(
  request: CFTextRequest,
  model = '@cf/ibm-granite/granite-4.0-h-micro'
): Promise<CFTextResult> {
  if (process.env.ENABLE_CLOUDFLARE_TEXT_AI !== 'true') {
    throw new Error('Cloudflare text AI is disabled; set ENABLE_CLOUDFLARE_TEXT_AI=true to opt in.');
  }
  const { accountId, apiToken, gatewayId } = getCredentials();
  const endpoint = buildEndpoint(accountId, model);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...gatewayHeaders(gatewayId),
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
