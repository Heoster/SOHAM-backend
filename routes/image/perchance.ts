/**
 * POST /api/perchance
 * SOHAM-authenticated proxy to the isolated Render Perchance/Playwright service.
 * Returns { success, provider, imageUrl, enhancedPrompt, contentType, seed, width, height }.
 * No other image provider is used if Perchance is unavailable.
 */
import type { Request, Response } from 'express';
import { engineerImagePrompt } from '../../image/image-prompt-engineer';

const STYLE_GUIDES: Record<string, string> = {
  realistic: 'Photorealistic, high detail, natural lighting, professional photography.',
  artistic: 'Artistic, painterly, expressive brushstrokes, vibrant colors.',
  anime: 'Anime art style, clean lines, cel-shaded, vibrant colors, Japanese animation aesthetic.',
  sketch: 'Pencil sketch, hand-drawn, artistic linework, monochrome or light shading.',
};
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 350_000;

export async function perchanceImageHandler(req: Request, res: Response): Promise<void> {
  const prompt = req.body?.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    res.status(400).json({ error: 'MISSING_PROMPT', message: 'prompt is required and must be a non-empty string' });
    return;
  }
  if (prompt.trim().length > 1500) {
    res.status(400).json({ error: 'PROMPT_TOO_LONG', message: 'prompt must be 1500 characters or fewer' });
    return;
  }
  const allowedShapes = new Set(['portrait', 'square', 'landscape']);
  if (req.body.shape !== undefined && !allowedShapes.has(req.body.shape)) {
    res.status(400).json({ error: 'INVALID_SHAPE', message: 'shape must be portrait, square, or landscape' });
    return;
  }
  if (req.body.negativePrompt !== undefined && (typeof req.body.negativePrompt !== 'string' || req.body.negativePrompt.length > 500)) {
    res.status(400).json({ error: 'INVALID_NEGATIVE_PROMPT', message: 'negativePrompt must be a string of 500 characters or fewer' });
    return;
  }
  if (req.body.seed !== undefined && (!Number.isInteger(req.body.seed) || req.body.seed < -1 || req.body.seed > 2 ** 31 - 1)) {
    res.status(400).json({ error: 'INVALID_SEED', message: 'seed must be -1 or a non-negative 32-bit integer' });
    return;
  }
  if (req.body.guidanceScale !== undefined && (typeof req.body.guidanceScale !== 'number' || req.body.guidanceScale < 1 || req.body.guidanceScale > 30)) {
    res.status(400).json({ error: 'INVALID_GUIDANCE_SCALE', message: 'guidanceScale must be between 1 and 30' });
    return;
  }
  if (req.body.style !== undefined && (typeof req.body.style !== 'string' || !Object.prototype.hasOwnProperty.call(STYLE_GUIDES, req.body.style))) {
    res.status(400).json({ error: 'INVALID_STYLE', message: 'style must be realistic, artistic, anime, or sketch' });
    return;
  }

  const engineered = engineerImagePrompt(prompt.trim());
  const enhancedPrompt = req.body.style
    ? `${engineered.positive}. ${STYLE_GUIDES[req.body.style]}`
    : engineered.positive;
  if (enhancedPrompt.length > 1500) {
    res.status(400).json({ error: 'ENHANCED_PROMPT_TOO_LONG', message: 'SOHAM-enhanced prompt exceeds the Perchance service limit' });
    return;
  }
  const [ratioWidth, ratioHeight] = engineered.aspectRatio.split(':').map(Number);
  const inferredShape = ratioWidth > ratioHeight ? 'landscape'
    : ratioHeight > ratioWidth ? 'portrait' : 'square';

  const hostport = process.env.PERCHANCE_SERVICE_HOSTPORT;
  const token = process.env.PERCHANCE_SERVICE_TOKEN;
  if (!hostport || !token) {
    res.status(503).json({ error: 'PERCHANCE_NOT_CONFIGURED', message: 'Perchance service is not configured' });
    return;
  }

  let serviceUrl: URL;
  try {
    serviceUrl = new URL('/perchance', `http://${hostport}`);
  } catch {
    res.status(503).json({ error: 'PERCHANCE_NOT_CONFIGURED', message: 'Perchance service address is invalid' });
    return;
  }

  try {
    const upstream = await fetch(serviceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Perchance-Service-Token': token,
      },
      body: JSON.stringify({
        prompt: enhancedPrompt,
        shape: req.body.shape ?? inferredShape,
        negativePrompt: req.body.negativePrompt ?? engineered.negative,
        seed: req.body.seed,
        guidanceScale: req.body.guidanceScale,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!upstream.ok) {
      const status = upstream.status === 429 || upstream.status === 504 ? upstream.status : 502;
      const errorCode = upstream.status === 429 ? 'PERCHANCE_BUSY'
        : upstream.status === 504 ? 'PERCHANCE_TIMEOUT'
          : 'PERCHANCE_UPSTREAM_FAILED';
      res.status(status).json({
        error: errorCode,
        message: upstream.status === 429
          ? 'Perchance is busy; retry in a moment.'
          : upstream.status === 504
            ? 'Perchance image generation timed out. No alternate provider was used.'
            : 'Perchance image generation failed. No alternate provider was used.',
        requestId: req.requestId,
      });
      return;
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      res.status(502).json({ error: 'INVALID_PERCHANCE_RESPONSE', message: 'Perchance did not return an image' });
      return;
    }
    const contentLength = Number(upstream.headers.get('content-length') ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      res.status(502).json({ error: 'PERCHANCE_IMAGE_TOO_LARGE', message: 'Generated image exceeds the size limit' });
      return;
    }

    const imageBuffer = Buffer.from(await upstream.arrayBuffer());
    if (imageBuffer.length === 0 || imageBuffer.length > MAX_RESPONSE_BYTES) {
      res.status(502).json({ error: 'INVALID_PERCHANCE_IMAGE', message: 'Perchance returned an empty or oversized image' });
      return;
    }

    res.json({
      success: true,
      provider: 'perchance',
      imageUrl: `data:${contentType};base64,${imageBuffer.toString('base64')}`,
      enhancedPrompt,
      contentType,
      seed: upstream.headers.get('x-perchance-seed'),
      width: Number(upstream.headers.get('x-perchance-width')) || undefined,
      height: Number(upstream.headers.get('x-perchance-height')) || undefined,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? 'PERCHANCE_TIMEOUT' : 'PERCHANCE_UNAVAILABLE',
      message: isTimeout
        ? 'Perchance request timed out. No alternate provider was used.'
        : 'Perchance service is unavailable. No alternate provider was used.',
      requestId: req.requestId,
    });
  }
}
