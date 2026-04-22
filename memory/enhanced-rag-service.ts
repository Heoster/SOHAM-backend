/**
 * Enhanced RAG Service with MCP Integration
 * 
 * Combines:
 * - Upstash Vector for semantic search
 * - Supabase for structured memory storage
 * - MCP tools for real-world knowledge (web, weather, news, etc.)
 * - Hybrid retrieval: semantic similarity + recency + relevance scoring
 * 
 * Memory types:
 * - SHORT_TERM: Recent conversation context (Upstash Vector)
 * - LONG_TERM: Extracted facts, preferences, skills (Supabase + Vector)
 * - REAL_WORLD: Live data from MCP tools (web search, weather, news, etc.)
 */

import { Index } from '@upstash/vector';

// ============================================================================
// Types
// ============================================================================

export interface MemoryChunk {
  id: string;
  content: string;
  type: 'SHORT_TERM' | 'LONG_TERM' | 'REAL_WORLD';
  category?: 'fact' | 'preference' | 'skill' | 'context' | 'knowledge';
  userId: string;
  timestamp: string;
  metadata: {
    source?: string;
    relevanceScore?: number;
    recencyScore?: number;
    semanticScore?: number;
    combinedScore?: number;
  };
}

export interface RAGQuery {
  query: string;
  userId: string;
  topK?: number;
  includeRealWorld?: boolean;
  minSimilarity?: number;
}

export interface RAGResult {
  chunks: MemoryChunk[];
  totalRetrieved: number;
  retrievalTimeMs: number;
  sources: {
    shortTerm: number;
    longTerm: number;
    realWorld: number;
  };
}

// ============================================================================
// Upstash Vector Client
// ============================================================================

function getUpstashClient(): Index | null {
  const url = process.env.UPSTASH_VECTOR_REST_URL;
  const token = process.env.UPSTASH_VECTOR_REST_TOKEN;
  
  if (!url || !token) {
    console.warn('[RAG] Upstash Vector not configured');
    return null;
  }
  
  return new Index({ url, token });
}

// ============================================================================
// Supabase Client
// ============================================================================

async function querySupabaseMemories(
  userId: string,
  query: string,
  limit: number = 5
): Promise<MemoryChunk[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !serviceKey) {
    console.warn('[RAG] Supabase not configured');
    return [];
  }
  
  try {
    // Simple keyword search in memories table
    const res = await fetch(
      `${supabaseUrl}/rest/v1/memories?user_id=eq.${userId}&select=*&order=created_at.desc&limit=${limit}`,
      {
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
        },
        signal: AbortSignal.timeout(5000),
      }
    );
    
    if (!res.ok) {
      console.warn(`[RAG] Supabase query failed: ${res.status}`);
      return [];
    }
    
    const data = await res.json();
    
    return data.map((row: any) => ({
      id: row.id,
      content: row.content,
      type: 'LONG_TERM' as const,
      category: row.category || 'fact',
      userId: row.user_id,
      timestamp: row.created_at,
      metadata: {
        source: 'supabase',
        relevanceScore: row.relevance || 0.5,
      },
    }));
  } catch (error) {
    console.warn('[RAG] Supabase query error:', error);
    return [];
  }
}

// ============================================================================
// MCP Real-World Knowledge Integration
// ============================================================================

/**
 * Query real-world knowledge via MCP tools
 * This would integrate with MCP servers for:
 * - Web search (Tavily, DuckDuckGo)
 * - Weather (Open-Meteo)
 * - News (GNews)
 * - Wikipedia
 * - etc.
 */
async function queryRealWorldKnowledge(
  query: string
): Promise<MemoryChunk[]> {
  const chunks: MemoryChunk[] = [];
  
  // TODO: Integrate with MCP servers here
  // For now, return empty array
  // Future: Call MCP tools based on query intent
  
  return chunks;
}

// ============================================================================
// Hybrid Retrieval with Scoring
// ============================================================================

/**
 * Calculate recency score (0-1, exponential decay)
 * Recent memories get higher scores
 */
function calculateRecencyScore(timestamp: string): number {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const ageMs = now - then;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  
  // Exponential decay: score = e^(-age/halfLife)
  // halfLife = 7 days (memories lose 50% relevance after 1 week)
  const halfLife = 7;
  return Math.exp(-ageDays / halfLife);
}

/**
 * Combine semantic similarity, recency, and relevance into a single score
 */
function calculateCombinedScore(
  semanticScore: number,
  recencyScore: number,
  relevanceScore: number
): number {
  // Weighted combination:
  // - Semantic similarity: 60%
  // - Recency: 25%
  // - Relevance: 15%
  return (
    semanticScore * 0.6 +
    recencyScore * 0.25 +
    relevanceScore * 0.15
  );
}

// ============================================================================
// Main RAG Service
// ============================================================================

export class EnhancedRAGService {
  private upstashClient: Index | null;
  
  constructor() {
    this.upstashClient = getUpstashClient();
  }
  
  /**
   * Query all memory sources and return ranked results
   */
  async query(request: RAGQuery): Promise<RAGResult> {
    const startTime = Date.now();
    const {
      query,
      userId,
      topK = 10,
      includeRealWorld = true,
      minSimilarity = 0.4,
    } = request;
    
    // Parallel retrieval from all sources
    const [shortTermChunks, longTermChunks, realWorldChunks] = await Promise.all([
      this.queryShortTerm(userId, query, topK, minSimilarity),
      this.queryLongTerm(userId, query, topK),
      includeRealWorld ? queryRealWorldKnowledge(query) : Promise.resolve([]),
    ]);
    
    // Combine and rank all chunks
    const allChunks = [...shortTermChunks, ...longTermChunks, ...realWorldChunks];
    
    // Calculate combined scores
    for (const chunk of allChunks) {
      const recencyScore = calculateRecencyScore(chunk.timestamp);
      const semanticScore = chunk.metadata.semanticScore || 0.5;
      const relevanceScore = chunk.metadata.relevanceScore || 0.5;
      
      chunk.metadata.recencyScore = recencyScore;
      chunk.metadata.combinedScore = calculateCombinedScore(
        semanticScore,
        recencyScore,
        relevanceScore
      );
    }
    
    // Sort by combined score (highest first)
    allChunks.sort((a, b) => 
      (b.metadata.combinedScore || 0) - (a.metadata.combinedScore || 0)
    );
    
    // Take top K
    const topChunks = allChunks.slice(0, topK);
    
    return {
      chunks: topChunks,
      totalRetrieved: allChunks.length,
      retrievalTimeMs: Date.now() - startTime,
      sources: {
        shortTerm: shortTermChunks.length,
        longTerm: longTermChunks.length,
        realWorld: realWorldChunks.length,
      },
    };
  }
  
  /**
   * Query short-term memory (Upstash Vector)
   */
  private async queryShortTerm(
    userId: string,
    query: string,
    topK: number,
    minSimilarity: number
  ): Promise<MemoryChunk[]> {
    if (!this.upstashClient) return [];
    
    try {
      // Query Upstash Vector with metadata filtering
      const results = await this.upstashClient.query({
        data: query,
        topK,
        includeMetadata: true,
        filter: `user_id = '${userId}'`,
      });
      
      return results
        .filter(r => r.score >= minSimilarity)
        .map(r => ({
          id: r.id as string,
          content: (r.metadata as any)?.content || '',
          type: 'SHORT_TERM' as const,
          userId,
          timestamp: (r.metadata as any)?.timestamp || new Date().toISOString(),
          metadata: {
            source: 'upstash',
            semanticScore: r.score,
          },
        }));
    } catch (error) {
      console.warn('[RAG] Upstash query error:', error);
      return [];
    }
  }
  
  /**
   * Query long-term memory (Supabase)
   */
  private async queryLongTerm(
    userId: string,
    query: string,
    limit: number
  ): Promise<MemoryChunk[]> {
    return querySupabaseMemories(userId, query, limit);
  }
  
  /**
   * Store a new memory chunk
   */
  async store(chunk: Omit<MemoryChunk, 'id' | 'timestamp'>): Promise<void> {
    const id = `${chunk.userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = new Date().toISOString();
    
    // Store in Upstash Vector for semantic search
    if (this.upstashClient && chunk.type === 'SHORT_TERM') {
      try {
        await this.upstashClient.upsert({
          id,
          data: chunk.content,
          metadata: {
            user_id: chunk.userId,
            type: chunk.type,
            category: chunk.category,
            timestamp,
            ...chunk.metadata,
          },
        });
      } catch (error) {
        console.warn('[RAG] Upstash upsert error:', error);
      }
    }
    
    // Store long-term memories in Supabase
    if (chunk.type === 'LONG_TERM') {
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      
      if (supabaseUrl && serviceKey) {
        try {
          await fetch(`${supabaseUrl}/rest/v1/memories`, {
            method: 'POST',
            headers: {
              'apikey': serviceKey,
              'Authorization': `Bearer ${serviceKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify({
              id,
              user_id: chunk.userId,
              content: chunk.content,
              category: chunk.category || 'fact',
              relevance: chunk.metadata.relevanceScore || 0.5,
              created_at: timestamp,
            }),
            signal: AbortSignal.timeout(5000),
          });
        } catch (error) {
          console.warn('[RAG] Supabase insert error:', error);
        }
      }
    }
  }
}

// Singleton
let ragService: EnhancedRAGService | null = null;

export function getEnhancedRAGService(): EnhancedRAGService {
  if (!ragService) {
    ragService = new EnhancedRAGService();
  }
  return ragService;
}
