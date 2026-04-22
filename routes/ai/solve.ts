/**
 * POST /api/ai/solve
 * Math / problem solver with step-by-step solutions.
 * Body: { problem: string, tone?, technicalLevel?, preferredModel? }
 * Response: { solution, modelUsed }
 */
import type { Request, Response } from "express";
import { enhancedSolve } from "../../flows/enhanced-solve";

export async function solveHandler(req: Request, res: Response): Promise<void> {
  try {
    const { problem, tone, technicalLevel, preferredModel } = req.body;
    if (!problem || typeof problem !== "string") {
      res.status(400).json({ error: "problem is required and must be a string" });
      return;
    }
    const result = await enhancedSolve({ problem, tone, technicalLevel, preferredModel });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Solve failed" });
  }
}
