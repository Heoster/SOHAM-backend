/**
 * POST /api/image/generate-cf
 * Cloudflare Workers AI image generation only.
 * Body: { prompt: string, aspect_ratio?: string, num_steps?: number, model?: string }
 * Response: { success, imageUrl, model, provider }
 * GET /api/image/generate-cf → health/capability check
 */
import type { Request, Response } from "express";
import { cfGenerateImage } from "../../image/cloudflare-ai";

const ALLOWED_MODELS = new Set([
  "@cf/black-forest-labs/flux-1-schnell",
  "@cf/stabilityai/stable-diffusion-xl-base-1.0",
  "@cf/lykon/dreamshaper-8-lcm",
]);
const DEFAULT_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export async function generateImageCFHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_AI_API_TOKEN) {
      res.status(503).json({ success: false, error: "Cloudflare AI is not configured on this server." });
      return;
    }
    const { prompt, aspect_ratio = "1:1", num_steps = 4, model } = req.body;
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      res.status(400).json({ success: false, error: "prompt is required." });
      return;
    }
    const requestedModel = typeof model === "string" && ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
    const result = await cfGenerateImage({ prompt: prompt.trim(), aspect_ratio, num_steps: Math.min(Math.max(num_steps, 1), 8) }, requestedModel);
    res.json({ success: true, imageUrl: result.imageBase64, model: result.model, provider: "cloudflare" });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : "CF image generation failed" });
  }
}

export function generateImageCFHealthHandler(_req: Request, res: Response): void {
  res.json({
    available: !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_API_TOKEN),
    provider: "cloudflare-workers-ai",
    defaultModel: DEFAULT_MODEL,
    supportedModels: [...ALLOWED_MODELS],
  });
}
