/**
 * SOHAM Image Generation Pipeline
 *
 * Fallback chain:
 *   1. Cloudflare Workers AI / flux-1-schnell  — needs CF token, ~3s
 *   2. Pollinations.ai/flux                    — free, no key, ~2s
 *   3. HF Router/FLUX.1-schnell                — needs HF key, ~7s
 *
 * After generation, the image is uploaded to Supabase Storage and the
 * permanent public HTTPS URL is returned — no base64 blobs in responses.
 */

import { cfGenerateImage } from './cloudflare-ai';
import { uploadImageToSupabase } from './supabase-storage';
import { engineerImagePrompt } from './image-prompt-engineer';

export interface SOHAMImageRequest {
  userPrompt: string;
  userId: string;
  style?: 'realistic' | 'artistic' | 'anime' | 'sketch';
  /** Override aspect ratio, e.g. "16:9". Defaults to "1:1". */
  aspectRatio?: string;
}

export interface SOHAMImageResult {
  url: string;
  path: string;
  enhancedPrompt: string;
  provider: 'cloudflare' | 'pollinations';
  model: string;
  generationTime: number;
}

export class SOHAMImagePipeline {

  // ─── PROMPT BUILDER ───────────────────────────────────────────────────────────

  /**
   * Transforms a natural language image request into a rich visual prompt.
   * Uses the ImagePromptEngineer for structured classification + enrichment,
   * then optionally appends a style guide.
   */
  private buildPrompt(raw: string, style?: string): { prompt: string; aspectRatio: string } {
    // Run through the prompt engineer first
    const engineered = engineerImagePrompt(raw);
    let prompt = engineered.positive;

    // If user explicitly specified a style override, append it
    const styleGuides: Record<string, string> = {
      realistic: 'Photorealistic, high detail, natural lighting, professional photography.',
      artistic:  'Artistic, painterly, expressive brushstrokes, vibrant colors.',
      anime:     'Anime art style, clean lines, cel-shaded, vibrant colors, Japanese animation aesthetic.',
      sketch:    'Pencil sketch, hand-drawn, artistic linework, monochrome or light shading.',
    };
    if (style && styleGuides[style]) {
      prompt = `${prompt}. ${styleGuides[style]}`;
    }

    return { prompt, aspectRatio: engineered.aspectRatio };
  }

  // ─── PROVIDER 1: Cloudflare Workers AI (flux-1-schnell) ───────────────────────

  private async tryCloudflare(
    prompt: string
  ): Promise<{ url: string; model: string }> {
    const result = await cfGenerateImage(
      { prompt, steps: 4 },
      '@cf/black-forest-labs/flux-1-schnell'
    );
    return { url: result.imageBase64, model: 'flux-1-schnell' };
  }

  // ─── PROVIDER 2: Pollinations.ai (free, no key) ───────────────────────────────

  private buildPollinationsUrl(prompt: string): string {
    const seed = Math.floor(Math.random() * 1_000_000);
    return (
      `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
      `?model=flux&width=1024&height=1024&seed=${seed}&nologo=true&enhance=true`
    );
  }

  private async tryPollinations(prompt: string): Promise<{ url: string; model: string }> {
    const url = this.buildPollinationsUrl(prompt);

    // Download the image so we can upload it to Supabase Storage
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Pollinations HTTP ${res.status}`);
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.startsWith('image/')) throw new Error(`Pollinations returned non-image: ${ct}`);

      const buf = await res.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      const dataUrl = `data:${ct.split(';')[0]};base64,${b64}`;
      return { url: dataUrl, model: 'flux' };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ─── MAIN ────────────────────────────────────────────────────────────────────

  async generate(request: SOHAMImageRequest): Promise<SOHAMImageResult> {
    const startTime = Date.now();
    const { prompt: enhancedPrompt, aspectRatio: engineeredAspectRatio } = this.buildPrompt(request.userPrompt, request.style);
    // User-specified aspect ratio overrides the engineered one
    const aspectRatio = request.aspectRatio ?? engineeredAspectRatio;

    let dataUrl: string | null = null;
    let provider: 'cloudflare' | 'pollinations' = 'pollinations';
    let model = 'flux';

    // 1. Cloudflare Workers AI (primary — fast, high quality)
    if (process.env.ENABLE_CLOUDFLARE_IMAGE_AI === 'true' && process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_API_TOKEN) {
      try {
        const result = await this.tryCloudflare(enhancedPrompt);
        dataUrl = result.url;
        provider = 'cloudflare';
        model = result.model;
      } catch (err) {
        console.warn('[Image] Cloudflare AI failed:', err instanceof Error ? err.message : err);
      }
    }

    // 2. Pollinations (free, no key)
    if (!dataUrl) {
      try {
        const result = await this.tryPollinations(enhancedPrompt);
        dataUrl = result.url;
        provider = 'pollinations';
        model = result.model;
      } catch (err) {
        console.warn('[Image] Pollinations failed:', err instanceof Error ? err.message : err);
      }
    }

    if (!dataUrl) {
      throw new Error('All image providers failed. Please try again.');
    }

    // Upload to Supabase Storage → get permanent public HTTPS URL
    // This avoids passing large base64 blobs through API responses
    let publicUrl: string;
    try {
      publicUrl = await uploadImageToSupabase(dataUrl, request.userId);
      console.log(`[Image] Stored at: ${publicUrl}`);
    } catch (uploadErr) {
      console.warn('[Image] Supabase upload failed, using direct URL:', uploadErr instanceof Error ? uploadErr.message : uploadErr);
      // Graceful fallback: use the data URL or Pollinations URL directly
      publicUrl = dataUrl;
    }

    return {
      url: publicUrl,
      path: publicUrl,
      enhancedPrompt,
      provider,
      model,
      generationTime: Date.now() - startTime,
    };
  }
}

let pipeline: SOHAMImagePipeline | null = null;

export function getSOHAMPipeline(): SOHAMImagePipeline {
  if (!pipeline) pipeline = new SOHAMImagePipeline();
  return pipeline;
}
