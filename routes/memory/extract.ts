/**
 * POST /api/memory/extract
 * Extract and store memories from a conversation turn.
 * Body: { userMessage: string, assistantResponse: string, userId: string }
 * Response: { success, extracted, message }
 */
import type { Request, Response } from "express";
import { getMemoryExtractionService } from "../../memory/memory-extraction-service";

export async function extractMemoriesHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userMessage, assistantResponse, userId } = req.body;
    if (!userMessage || !assistantResponse || !userId) {
      res.status(400).json({ error: "Missing required fields: userMessage, assistantResponse, userId" });
      return;
    }
    const memoryService = getMemoryExtractionService();
    if (!memoryService.isEnabled()) {
      res.json({ success: true, message: "Memory extraction is disabled", extracted: 0 });
      return;
    }
    const extractedCount = await memoryService.extractAndStore({ userMessage, assistantResponse, userId });
    res.json({ success: true, extracted: extractedCount, message: `Extracted and stored ${extractedCount} memories` });
  } catch (error) {
    res.json({ success: true, extracted: 0, message: "Memory extraction skipped due to error", details: error instanceof Error ? error.message : "Unknown error" });
  }
}
