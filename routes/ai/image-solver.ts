/**
 * POST /api/ai/image-solver
 * Solve equations / problems from images (visual math solver).
 * Body: { imageDataUri: string, problemType?: string, preferredModel? }
 * Response: { recognizedContent, solution, isSolvable }
 */
import type { Request, Response } from "express";
import { enhancedImageSolver } from "../../flows/enhanced-image-solver";

export async function imageSolverHandler(req: Request, res: Response): Promise<void> {
  try {
    const { imageDataUri, problemType, preferredModel } = req.body;
    if (!imageDataUri || typeof imageDataUri !== "string") {
      res.status(400).json({ error: "imageDataUri is required and must be a string" });
      return;
    }
    const result = await enhancedImageSolver({ imageDataUri, problemType, preferredModel });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Image solver failed" });
  }
}
