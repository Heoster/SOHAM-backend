/**
 * POST /api/ai/summarize
 * Text summarization with style options.
 * Body: { text: string, style?: "brief"|"detailed"|"bullets"|"eli5", preferredModel? }
 * Response: { summary, modelUsed }
 */
import type { Request, Response } from "express";
import { enhancedSummarize } from "../../flows/enhanced-summarize";

export async function summarizeHandler(req: Request, res: Response): Promise<void> {
  try {
    const { text, style, preferredModel } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "text is required and must be a string" });
      return;
    }
    const result = await enhancedSummarize({ text, style, preferredModel });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Summarize failed" });
  }
}
