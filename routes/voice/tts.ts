/**
 * POST /api/voice/tts
 * Text-to-Speech using Groq Orpheus TTS with fallback chain.
 * Body: { text: string, voice?: string, speed?: number }
 * Response: { success, audio (base64), provider, model, contentType }
 */
import type { Request, Response } from "express";
import { getUnifiedVoiceService } from "../../voice/unified-voice-service";

export async function ttsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { text, voice, speed } = req.body;
    if (!text) { res.status(400).json({ success: false, error: "Text is required" }); return; }
    const processedText = text.length > 4000 ? text.substring(0, 4000) + "..." : text;
    const voiceService = getUnifiedVoiceService();
    const result = await voiceService.textToSpeech(processedText, { voice: voice || "troy", speed: speed || 1.0 });
    const base64Audio = Buffer.from(result.audio).toString("base64");
    res.json({ success: true, audio: base64Audio, provider: result.provider, model: result.model, contentType: "audio/wav" });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : "TTS generation failed" });
  }
}
