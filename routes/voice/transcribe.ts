/**
 * POST /api/voice/transcribe
 * Speech-to-Text using Groq Whisper V3 Turbo.
 * Body: multipart/form-data with file (audio) and optional language
 * Response: { success, text, language, provider, model, duration }
 */
import type { Request, Response } from "express";
import { getUnifiedVoiceService } from "../../voice/unified-voice-service";

export async function transcribeHandler(req: Request, res: Response): Promise<void> {
  try {
    const file = (req as any).file;
    const language = req.body?.language;
    if (!file) { res.status(400).json({ success: false, error: "No audio file provided" }); return; }
    const voiceService = getUnifiedVoiceService();
    const audioFile = new File([file.buffer], file.originalname, { type: file.mimetype });
    const result = await voiceService.speechToText(audioFile, { language: language || "en" });
    res.json({ success: true, text: result.text, language: language || "auto", provider: result.provider, model: result.model, duration: result.duration });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Transcription failed" });
  }
}
