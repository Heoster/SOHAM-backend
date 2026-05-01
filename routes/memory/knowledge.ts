/**
 * Public Knowledge Routes (Upstash Vector)
 *
 * POST /api/memory/knowledge          → Store a new public knowledge entry
 * POST /api/memory/knowledge/search   → Search public knowledge
 * POST /api/memory/knowledge/correction → Store a correction
 * POST /api/memory/knowledge/suggestion → Store a suggestion
 */

import type { Request, Response } from 'express';
import { getUpstashKnowledgeService } from '../../memory/upstash-knowledge-service';
import type { KnowledgeType } from '../../memory/upstash-knowledge-service';

const VALID_TYPES: KnowledgeType[] = [
  'CORRECTION', 'SUGGESTION', 'FACT', 'DEFINITION', 'EXAMPLE', 'BEST_PRACTICE', 'FAQ',
];

// ── POST /api/memory/knowledge ────────────────────────────────────────────────

export async function storeKnowledgeHandler(req: Request, res: Response): Promise<void> {
  try {
    const { type, question, content, source, confidence, tags } = req.body ?? {};

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      res.status(400).json({ error: 'MISSING_CONTENT', message: 'content is required' });
      return;
    }
    if (type && !VALID_TYPES.includes(type)) {
      res.status(400).json({ error: 'INVALID_TYPE', message: `type must be one of: ${VALID_TYPES.join(', ')}` });
      return;
    }

    const service = getUpstashKnowledgeService();
    const id = await service.storeKnowledge({
      type: type ?? 'FACT',
      question: question ?? undefined,
      content: content.trim(),
      source: source ?? 'api',
      confidence: typeof confidence === 'number' ? Math.min(1, Math.max(0, confidence)) : 0.75,
      tags: Array.isArray(tags) ? tags : [],
    });

    res.json({ success: true, id, message: 'Knowledge stored successfully' });
  } catch (error) {
    console.error('[Knowledge API] Store error:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ── POST /api/memory/knowledge/search ────────────────────────────────────────

export async function searchKnowledgeHandler(req: Request, res: Response): Promise<void> {
  try {
    const { query, topK = 5, minSimilarity = 0.50 } = req.body ?? {};

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      res.status(400).json({ error: 'MISSING_QUERY', message: 'query is required' });
      return;
    }

    const service = getUpstashKnowledgeService();
    const results = await service.searchKnowledge(
      query.trim(),
      Math.min(20, Math.max(1, Number(topK) || 5)),
      Math.min(1, Math.max(0, Number(minSimilarity) || 0.50))
    );

    res.json({
      success: true,
      results: results.map(r => ({
        id: r.entry.id,
        type: r.entry.type,
        question: r.entry.question,
        content: r.entry.content,
        confidence: r.entry.confidence,
        usageCount: r.entry.usageCount,
        similarity: Math.round(r.similarity * 1000) / 1000,
        score: Math.round(r.score * 1000) / 1000,
        tags: r.entry.tags,
        createdAt: r.entry.createdAt,
      })),
      total: results.length,
    });
  } catch (error) {
    console.error('[Knowledge API] Search error:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ── POST /api/memory/knowledge/correction ────────────────────────────────────

export async function storeCorrectionHandler(req: Request, res: Response): Promise<void> {
  try {
    const { originalQuery, correctedAnswer, source } = req.body ?? {};

    if (!originalQuery || !correctedAnswer) {
      res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'originalQuery and correctedAnswer are required',
      });
      return;
    }

    const service = getUpstashKnowledgeService();
    const id = await service.storeCorrection(
      String(originalQuery).trim(),
      String(correctedAnswer).trim(),
      source ?? 'user-correction'
    );

    res.json({ success: true, id, message: 'Correction stored successfully' });
  } catch (error) {
    console.error('[Knowledge API] Correction error:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ── POST /api/memory/knowledge/suggestion ────────────────────────────────────

export async function storeSuggestionHandler(req: Request, res: Response): Promise<void> {
  try {
    const { context, suggestion, source } = req.body ?? {};

    if (!context || !suggestion) {
      res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'context and suggestion are required',
      });
      return;
    }

    const service = getUpstashKnowledgeService();
    const id = await service.storeSuggestion(
      String(context).trim(),
      String(suggestion).trim(),
      source ?? 'user-suggestion'
    );

    res.json({ success: true, id, message: 'Suggestion stored successfully' });
  } catch (error) {
    console.error('[Knowledge API] Suggestion error:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
