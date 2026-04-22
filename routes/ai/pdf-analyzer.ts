/**
 * POST /api/ai/pdf-analyzer
 * Analyze PDF documents and answer questions about them.
 * Body: { pdfDataUri: string, question: string, preferredModel? }
 * Response: { answer, modelUsed }
 */
import type { Request, Response } from "express";
import { enhancedPdfAnalyzer } from "../../flows/enhanced-pdf-analyzer";

export async function pdfAnalyzerHandler(req: Request, res: Response): Promise<void> {
  try {
    const { pdfDataUri, question, preferredModel } = req.body;
    if (!pdfDataUri || typeof pdfDataUri !== "string") {
      res.status(400).json({ error: "pdfDataUri is required" });
      return;
    }
    if (!question || typeof question !== "string") {
      res.status(400).json({ error: "question is required" });
      return;
    }
    const result = await enhancedPdfAnalyzer({ pdfDataUri, question, preferredModel });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "PDF analyzer failed" });
  }
}
