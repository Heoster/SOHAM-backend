/**
 * Cloudflare Workers AI image generation (FLUX.1 schnell).
 * POST /api/image/generate-cf: { prompt: string, steps?: 1..8 }
 * GET /api/image/generate-cf: non-generative capability/configuration info.
 */
import type { Request, Response } from 'express';
import { cfGenerateImage } from '../../image/cloudflare-ai';

const MODEL = '@cf/black-forest-labs/flux-1-schnell';

function isEnabled(): boolean {
  return process.env.ENABLE_CLOUDFLARE_IMAGE_AI === 'true'
    && Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_API_TOKEN);
}

export async function generateImageCFHandler(req: Request, res: Response): Promise<void> {
  if (!isEnabled()) {
    res.status(503).json({
      success: false,
      error: 'Cloudflare image AI is disabled or not configured. Explicitly enable it with ENABLE_CLOUDFLARE_IMAGE_AI=true.',
    });
    return;
  }

  const prompt = req.body?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 2048) {
    res.status(400).json({ success: false, error: 'prompt must contain 1–2048 characters.' });
    return;
  }
  const steps = req.body?.steps ?? 4;
  if (!Number.isInteger(steps) || steps < 1 || steps > 8) {
    res.status(400).json({ success: false, error: 'steps must be an integer from 1 to 8.' });
    return;
  }
  if (req.body?.model !== undefined && req.body.model !== MODEL) {
    res.status(400).json({ success: false, error: `Unsupported Cloudflare image model. Use ${MODEL}.` });
    return;
  }

  try {
    const result = await cfGenerateImage({ prompt: prompt.trim(), steps }, MODEL);
    res.json({ success: true, imageUrl: result.imageBase64, model: result.model, provider: 'cloudflare' });
  } catch (error) {
    console.error('[Image] Cloudflare Workers AI failed:', error instanceof Error ? error.message : error);
    res.status(502).json({
      success: false,
      error: 'Cloudflare Workers AI image generation failed. Check the account token, model access, and Workers AI quota.',
    });
  }
}

export function generateImageCFHealthHandler(_req: Request, res: Response): void {
  res.json({
    available: isEnabled(),
    provider: 'cloudflare-workers-ai',
    defaultModel: MODEL,
    supportedModels: [MODEL],
    inputs: { prompt: '1–2048 characters', steps: 'integer 1–8, default 4' },
    billing: 'Workers AI Neurons are account-wide; check the Cloudflare dashboard for current quota and charges.',
  });
}
