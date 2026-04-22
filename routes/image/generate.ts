/**
 * POST /api/image/generate
 * Image generation with rate limiting (10/day per user).
 * Fallback chain: Cloudflare Workers AI -> Pollinations.ai -> HuggingFace FLUX
 * Body: { prompt: string, userId: string, style?: "realistic"|"artistic"|"anime"|"sketch" }
 * Response: { success, url, enhancedPrompt, provider, model, generationTime, rateLimitInfo }
 */
import type { Request, Response } from "express";
import { getSOHAMPipeline } from "../../image/soham-image-pipeline";

const DAILY_LIMIT = 10;
const memStore = new Map<string, number>();

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function getNextMidnightUTC(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000);
}

async function checkAndIncrement(userId: string): Promise<{ allowed: boolean; used: number; remaining: number }> {
  const date = todayUTC();
  const key = `${userId}:${date}`;
  const current = memStore.get(key) ?? 0;
  if (current >= DAILY_LIMIT) return { allowed: false, used: current, remaining: 0 };
  const newCount = current + 1;
  memStore.set(key, newCount);
  return { allowed: true, used: newCount, remaining: DAILY_LIMIT - newCount };
}

export async function generateImageHandler(req: Request, res: Response): Promise<void> {
  try {
    const { prompt, userId, style } = req.body;
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      res.status(400).json({ success: false, error: "Prompt is required" });
      return;
    }
    if (!userId || typeof userId !== "string") {
      res.status(400).json({ success: false, error: "User ID is required" });
      return;
    }
    const validStyles = ["realistic", "artistic", "anime", "sketch"];
    if (style && !validStyles.includes(style)) {
      res.status(400).json({ success: false, error: `Invalid style. Must be one of: ${validStyles.join(", ")}` });
      return;
    }
    const { allowed, used, remaining } = await checkAndIncrement(userId);
    if (!allowed) {
      res.status(429).json({
        success: false,
        error: `Daily limit reached. You can generate up to ${DAILY_LIMIT} images per day.`,
        rateLimitInfo: { used, limit: DAILY_LIMIT, remaining: 0, resetsAt: "midnight UTC" },
      });
      return;
    }
    const pipeline = getSOHAMPipeline();
    const result = await pipeline.generate({ userPrompt: prompt.trim(), userId, style });
    res.json({ success: true, ...result, rateLimitInfo: { used, limit: DAILY_LIMIT, remaining } });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Image generation failed" });
  }
}
