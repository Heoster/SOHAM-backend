/**
 * Pinecone Knowledge Service — Public Suggestions & Corrections
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Stores AI suggestions, corrections, and curated knowledge in Pinecone Vector
 * under a SHARED namespace (no user_id filter) so they are available to ALL
 * users when semantically relevant.
 *
 * Use cases:
 *   - When SOHAM corrects a factual error, store the correction
 *   - When a user provides a better answer, store it as a suggestion
 *   - Curated knowledge snippets that improve future responses
 *   - Common Q&A pairs that are useful across users
 *
 * Namespace strategy:
 *   - User memories  → id prefix: `{userId}:...`   (private, filtered by user_id)
 *   - Public knowledge → id prefix: `public:...`   (shared, no user filter)
 *
 * Scoring for public knowledge:
 *   - Semantic similarity: 70%
 *   - Confidence score:    20%
 *   - Recency:             10%
 */

import { randomUUID } from 'crypto';
import { generateEmbedding } from './enhanced-rag';


// ─── Types ────────────────────────────────────────────────────────────────────

export type KnowledgeType =
  | 'CORRECTION'    // Factual correction to a wrong answer
  | 'SUGGESTION'    // Better way to answer a question
  | 'FACT'          // Verified public fact
  | 'DEFINITION'    // Term definition
  | 'EXAMPLE'       // Code or concept example
  | 'BEST_PRACTICE' // Best practice recommendation
  | 'FAQ';          // Frequently asked question + answer

export interface PublicKnowledgeEntry {
  id: string;
  type: KnowledgeType;
  question?: string;   // The query/question this knowledge answers
  content: string;     // The knowledge content
  source?: string;     // Where this came from (user correction, admin, etc.)
  confidence: number;  // 0–1, how confident we are in this knowledge
  usageCount: number;  // How many times this has been retrieved
  createdAt: string;
  tags?: string[];
}

export interface KnowledgeSearchResult {
  entry: PublicKnowledgeEntry;
  similarity: number;
  score: number;
}

// ─── Pinecone helpers ──────────────────────────────────────────────────────────

import { isPineconeReady, vectorRequest as vectorFetch } from './pinecone-vector';

// ─── Service ──────────────────────────────────────────────────────────────────

export class PineconeKnowledgeService {

  // ── Store a public knowledge entry ────────────────────────────────────────

  async storeKnowledge(entry: Omit<PublicKnowledgeEntry, 'id' | 'createdAt' | 'usageCount'>): Promise<string | null> {
    if (!isPineconeReady()) {
      console.warn('[Knowledge] Pinecone not configured — knowledge not stored');
      return null;
    }

    // Short text for dedup check and embedding — keep under 512 chars
    const dedupText = entry.question
      ? `Q: ${entry.question.slice(0, 200)}\nA: ${entry.content.slice(0, 200)}`
      : entry.content.slice(0, 400);

    // Dedup check — skip if very similar entry already exists
    try {
      const existing = await this.searchKnowledge(dedupText, 1, 0.92);
      if (existing.length > 0) {
        console.log('[Knowledge] Near-duplicate found, skipping store');
        return existing[0].entry.id;
      }
    } catch {
      // Proceed with store if dedup check fails
    }

    const id = `public:${entry.type.toLowerCase()}:${Date.now()}:${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    // Keep text short — embedding vector is ~24KB, so data must stay small
    const storeText = entry.question
      ? `Q: ${entry.question.slice(0, 200)}\nA: ${entry.content.slice(0, 400)}`
      : entry.content.slice(0, 500);

    const vector = await generateEmbedding(storeText.slice(0, 512));

    try {
      await vectorFetch('/upsert', {
        vectors: [{
          id,
          vector,
          metadata: {
            type: entry.type,
            question: (entry.question ?? '').slice(0, 200),
            source: entry.source ?? 'system',
            confidence: entry.confidence,
            usage_count: 0,
            created_at: now,
            tags: (entry.tags ?? []).join(','),
            namespace: 'public',
            // Store content in metadata to avoid data field size issues
            content_preview: entry.content.slice(0, 400),
          },
        }],
      });

      console.log(`[Knowledge] Stored ${entry.type}: ${storeText.slice(0, 80)}...`);
      return id;
    } catch (err) {
      console.warn('[Knowledge] Store failed:', err);
      return null;
    }
  }

  // ── Search public knowledge ────────────────────────────────────────────────

  async searchKnowledge(
    queryText: string,
    topK = 4,
    minSimilarity = 0.50
  ): Promise<KnowledgeSearchResult[]> {
    if (!isPineconeReady()) return [];

    const semantic = { vector: await generateEmbedding(queryText.slice(0, 1500)) };

    let payload: any;
    try {
      // Try with namespace filter first
      payload = await vectorFetch('/query', {
        ...semantic,
        topK: topK * 3,
        includeMetadata: true,
        includeData: true,
        filter: { namespace: { $eq: 'public' } },
      });
    } catch {
      return [];
    }

    const matches: any[] = payload?.result ?? payload?.matches ?? [];
    const now = Date.now();

    const results: KnowledgeSearchResult[] = matches
      .filter((m: any) => {
        // Only public entries (id starts with "public:" or namespace metadata)
        const ns = m.metadata?.namespace as string | undefined;
        const id = String(m.id);
        return ns === 'public' || id.startsWith('public:');
      })
      .map((m: any) => {
        const similarity = m.score ?? 0;
        const confidence = (m.metadata?.confidence as number | undefined) ?? 0.5;
        const createdAt = m.metadata?.created_at as string | undefined;
        const ageHours = createdAt
          ? (now - new Date(createdAt).getTime()) / 3_600_000
          : 720;
        const recency = Math.exp(-ageHours / (30 * 24)); // half-life 30 days for public knowledge

        const score = similarity * 0.70 + confidence * 0.20 + recency * 0.10;

        const rawText = typeof m.data === 'string' && m.data.length > 0
          ? m.data
          : typeof m.metadata?.content_preview === 'string'
          ? m.metadata.content_preview
          : '';
        const tagsRaw = m.metadata?.tags as string | undefined;

        const entry: PublicKnowledgeEntry = {
          id: m.id,
          type: (m.metadata?.type as KnowledgeType) ?? 'FACT',
          question: m.metadata?.question as string | undefined,
          content: rawText,
          source: m.metadata?.source as string | undefined,
          confidence,
          usageCount: (m.metadata?.usage_count as number | undefined) ?? 0,
          createdAt: createdAt ?? new Date().toISOString(),
          tags: tagsRaw ? tagsRaw.split(',').filter(Boolean) : [],
        };

        return { entry, similarity, score };
      })
      .filter(r => r.similarity >= minSimilarity && r.entry.content.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // Increment usage counts non-blocking
    if (results.length > 0) {
      this.incrementUsageCounts(results.map(r => r.entry.id)).catch(() => {});
    }

    return results;
  }

  // ── Increment usage count (best-effort) ───────────────────────────────────

  private async incrementUsageCounts(ids: string[]): Promise<void> {
    // Pinecone Vector doesn't support atomic increments on metadata,
    // so we do a best-effort re-fetch + re-upsert for the top result only.
    // This is intentionally lightweight.
    if (ids.length === 0 || !isPineconeReady()) return;

    try {
      const data = await vectorFetch('/fetch', { ids: [ids[0]] }, 4000);
      const vectors: any[] = data?.result ?? data?.vectors ?? [];
      if (vectors.length === 0) return;

      const v = vectors[0];
      const currentCount = (v.metadata?.usage_count as number | undefined) ?? 0;

      await vectorFetch('/update', {
        id: ids[0],
        metadata: {
          ...v.metadata,
          usage_count: currentCount + 1,
        },
      });
    } catch {
      // Fail silently — usage count is non-critical
    }
  }

  // ── Store a correction (convenience wrapper) ───────────────────────────────

  async storeCorrection(
    originalQuery: string,
    correctedAnswer: string,
    source = 'user-correction'
  ): Promise<string | null> {
    return this.storeKnowledge({
      type: 'CORRECTION',
      question: originalQuery,
      content: correctedAnswer,
      source,
      confidence: 0.85,
      tags: ['correction'],
    });
  }

  // ── Store a suggestion (convenience wrapper) ───────────────────────────────

  async storeSuggestion(
    context: string,
    suggestion: string,
    source = 'user-suggestion'
  ): Promise<string | null> {
    return this.storeKnowledge({
      type: 'SUGGESTION',
      question: context,
      content: suggestion,
      source,
      confidence: 0.75,
      tags: ['suggestion'],
    });
  }

  // ── Format results for prompt injection ───────────────────────────────────

  formatForPrompt(results: KnowledgeSearchResult[]): string {
    if (results.length === 0) return '';

    return results
      .map((r, i) => {
        const label = r.entry.type === 'CORRECTION'
          ? '⚠ Correction'
          : r.entry.type === 'SUGGESTION'
          ? '💡 Suggestion'
          : r.entry.type === 'BEST_PRACTICE'
          ? '✅ Best Practice'
          : r.entry.type === 'FAQ'
          ? '❓ FAQ'
          : 'ℹ Knowledge';

        return `${i + 1}. [${label}] ${r.entry.content}`;
      })
      .join('\n');
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: PineconeKnowledgeService | null = null;

export function getPineconeKnowledgeService(): PineconeKnowledgeService {
  if (!_instance) _instance = new PineconeKnowledgeService();
  return _instance;
}
