/**
 * Token Budget — Token Detector & Dynamic Cost-Aware Chain Shifter
 * ════════════════════════════════════════════════════════════════════════════
 *
 * PURPOSE
 * Every model has a fixed context window, cost tier, and Tokens-Per-Minute
 * (TPM) quota. Sending a large request to a small-TPM model (like Groq's
 * 8,000 TPM limit on gpt-oss-20b) burns its quota and causes 429 failures.
 * Sending a tiny request to a heavy model wastes higher-capacity quota.
 *
 * This module:
 *   1. Detects total request tokens (systemPrompt + prompt + history + output).
 *   2. Tracks live per-model token usage over a 60s sliding window (and syncs
 *      exact usage when a provider reports TPM exhaustion in a 429 response).
 *   3. Dynamically shifts the fallback chain per request so the cheapest
 *      capable model with sufficient TPM headroom runs first — never a fixed
 *      one-size-fits-all order.
 *   4. Drops models whose context windows are too small.
 *
 * The chain passed in is always used as the source of truth for which models
 * are available — this never adds new models, only filters and reorders.
 */

import { getModelRegistry } from './model-registry';
import type { ModelConfig } from './model-config';

// ─── Token estimation ─────────────────────────────────────────────────────────

/**
 * Fast token estimator — no tokenizer dependency.
 * 1 token ≈ 4 chars for English prose; use 3.5 for code/JSON-heavy content.
 * We deliberately round up (÷3.5 → ceiling) to stay conservative.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

export interface TokenBudget {
  /** Estimated tokens from system prompt. */
  systemPromptTokens: number;
  /** Estimated tokens from user prompt + conversation history. */
  promptAndHistoryTokens: number;
  /** Total estimated input tokens (systemPrompt + prompt + history). */
  inputTokens: number;
  /** Desired output tokens from generationParams (may be capped per model). */
  requestedOutputTokens: number;
  /** Total estimated tokens needed (input + requestedOutputTokens). */
  totalEstimated: number;
  /** Named size bucket based on totalEstimated. */
  bucket: 'TINY' | 'SMALL' | 'MEDIUM' | 'LARGE' | 'HUGE';
}

export function computeTokenBudget(
  prompt: string,
  history: Array<{ role: string; content: string | unknown[] }>,
  requestedOutputTokens = 2048,
  systemPrompt = '',
): TokenBudget {
  const historyText = history
    .map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return (m.content as Array<{ text?: string }>)
          .map(c => c?.text ?? '')
          .join('');
      }
      return '';
    })
    .join('\n');

  const systemPromptTokens = estimateTokens(systemPrompt);
  const promptAndHistoryTokens = estimateTokens(prompt) + estimateTokens(historyText);
  const inputTokens = systemPromptTokens + promptAndHistoryTokens;
  const totalEstimated = inputTokens + requestedOutputTokens;

  let bucket: TokenBudget['bucket'];
  if (totalEstimated < 2_500)       bucket = 'TINY';
  else if (totalEstimated < 5_000)  bucket = 'SMALL';
  else if (totalEstimated < 10_000) bucket = 'MEDIUM';
  else if (totalEstimated < 36_000) bucket = 'LARGE';
  else                              bucket = 'HUGE';

  return {
    systemPromptTokens,
    promptAndHistoryTokens,
    inputTokens,
    requestedOutputTokens,
    totalEstimated,
    bucket,
  };
}

// ─── Live 60s per-model TPM sliding window ────────────────────────────────────

const TPM_WINDOW_MS = 60_000;

interface TokenUsageSample {
  ts: number;
  tokens: number;
}

const modelUsageWindow = new Map<string, TokenUsageSample[]>();
const observedTpmLimits = new Map<string, number>();

function pruneWindow(samples: TokenUsageSample[], now: number): TokenUsageSample[] {
  return samples.filter(s => now - s.ts < TPM_WINDOW_MS);
}

/**
 * Record estimated or actual tokens sent to a specific model so consecutive
 * requests in the same 60s window shift away before hitting 429 TPM.
 */
export function recordModelTokenUsage(modelId: string, tokens: number, now = Date.now()): void {
  if (!modelId || tokens <= 0) return;
  const existing = pruneWindow(modelUsageWindow.get(modelId) ?? [], now);
  existing.push({ ts: now, tokens });
  modelUsageWindow.set(modelId, existing);
}

/**
 * Sync observed TPM saturation when a provider returns a 429 detailing
 * `Limit X, Used Y` so the detector immediately routes subsequent calls around it.
 */
export function syncModelTpmFromError(
  modelId: string,
  usedTokens: number,
  tpmLimit?: number,
  now = Date.now(),
): void {
  if (!modelId) return;
  if (tpmLimit && tpmLimit > 0) {
    observedTpmLimits.set(modelId, tpmLimit);
  }
  if (usedTokens > 0) {
    const current = getModelTokensLastMinute(modelId, now);
    if (usedTokens > current) {
      const existing = pruneWindow(modelUsageWindow.get(modelId) ?? [], now);
      existing.push({ ts: now, tokens: usedTokens - current });
      modelUsageWindow.set(modelId, existing);
    }
  }
}

export function getModelTokensLastMinute(modelId: string, now = Date.now()): number {
  const existing = modelUsageWindow.get(modelId);
  if (!existing || existing.length === 0) return 0;
  const pruned = pruneWindow(existing, now);
  if (pruned.length !== existing.length) {
    if (pruned.length === 0) modelUsageWindow.delete(modelId);
    else modelUsageWindow.set(modelId, pruned);
  }
  return pruned.reduce((sum, s) => sum + s.tokens, 0);
}

export function getModelTpmLimit(model: ModelConfig): number {
  const observed = observedTpmLimits.get(model.id);
  if (observed && observed > 0) return observed;
  if (model.rateLimit?.tokensPerMinute && model.rateLimit.tokensPerMinute > 0) {
    return model.rateLimit.tokensPerMinute;
  }
  switch (model.provider) {
    case 'groq':       return 8_000;
    case 'google':     return 250_000;
    case 'openrouter': return 100_000;
    case 'cloudflare': return 100_000;
    default:           return 100_000;
  }
}

/** Clear tracked sliding-window usage (primarily for unit tests). */
export function resetTokenBudgetTracking(): void {
  modelUsageWindow.clear();
  observedTpmLimits.clear();
}

// ─── Model cost tier ──────────────────────────────────────────────────────────

/**
 * Assign a cost tier to a model (lower = cheaper / prefer first for small req).
 * Tier is based on provider + rough parameter count inferred from the model ID.
 */
function costTier(model: ModelConfig): number {
  const id = model.id.toLowerCase();
  const mid = model.modelId.toLowerCase();

  if (model.provider === 'groq') {
    // Check 120b BEFORE 20b because '120b' contains the substring '20b'!
    // Smaller models first: 20b < qwen 27b < 120b
    if (mid.includes('120b')) return 2;
    if (mid.includes('27b'))  return 1;
    if (mid.includes('20b'))  return 0;
    return 1;
  }
  if (model.provider === 'google') {
    // Flash-lite variants are cheaper & lower latency than Flash
    if (id.includes('lite'))  return 3;
    return 4;
  }
  if (model.provider === 'openrouter') return 5;
  if (model.provider === 'cloudflare') return 6; // billed/Neuron-quota opt-in
  return 7;
}

// ─── Minimum context & TPM headroom ──────────────────────────────────────────

/**
 * True if the model's context window can accommodate this request with the
 * requested output tokens, using 90 % of the window as the safety ceiling.
 */
function modelFitsRequest(model: ModelConfig, budget: TokenBudget): boolean {
  const usable = Math.floor((model.contextWindow || 4096) * 0.90);
  return budget.totalEstimated <= usable;
}

/**
 * Rank how well the request fits into the model's TPM budget:
 *   0 = comfortable headroom (used + total <= 90% of tpmLimit)
 *   1 = tight fit (used + total <= tpmLimit)
 *   2 = fits a fresh minute, but current 60s window would exceed tpmLimit
 *   3 = single request alone exceeds tpmLimit
 */
function tpmHeadroomRank(model: ModelConfig, budget: TokenBudget, now = Date.now()): number {
  const tpmLimit = getModelTpmLimit(model);
  if (budget.totalEstimated > tpmLimit) return 3;
  const used = getModelTokensLastMinute(model.id, now);
  if (used + budget.totalEstimated <= Math.floor(tpmLimit * 0.90)) return 0;
  if (used + budget.totalEstimated <= tpmLimit) return 1;
  return 2;
}

// ─── Chain reordering ─────────────────────────────────────────────────────────

export interface BudgetAwareChainResult {
  chain: string[];
  budget: TokenBudget;
  /** IDs removed because their context window was too small. */
  dropped: string[];
}

/**
 * Bucket preference score (how good the cost/capacity fit is — lower = better):
 *  TINY / SMALL (< 5K total)    → prefer small Groq (20b / qwen 27b) to save quota
 *  MEDIUM (5K – 9,999 total)    → prefer Groq Qwen 27B / 120B / Flash-Lite over tiny 20B
 *  LARGE (10K – 35,999 total)   → prefer Google Flash-Lite → Flash → OpenRouter
 *  HUGE (≥ 36K total)           → Google Flash-Lite / Flash (1M ctx) first
 */
function bucketPreferenceScore(model: ModelConfig, bucket: TokenBudget['bucket']): number {
  const tier = costTier(model);
  switch (bucket) {
    case 'TINY':
    case 'SMALL':
      if (tier <= 1) return 0; // gpt-oss-20b, qwen3.8-27b
      if (tier === 2) return 1; // gpt-oss-120b
      if (tier === 3) return 2; // gemini flash-lite
      if (tier === 4) return 3; // gemini flash
      if (tier === 5) return 4; // openrouter free
      return 5;                 // cloudflare
    case 'MEDIUM':
      // Qwen 27B, 120B, and Gemini Flash-Lite handle medium payloads best
      // while preserving 20B's tight 8K TPM slot for short/planner turns.
      if (tier === 1 || tier === 2 || tier === 3) return 0;
      if (tier === 0) return 1;
      if (tier === 4) return 2;
      if (tier === 5) return 3;
      return 4;
    case 'LARGE':
    case 'HUGE':
      if (tier === 3) return 0; // Flash-Lite first (cheapest high-TPM free tier)
      if (tier === 4) return 1; // Gemini Flash
      if (tier === 5) return 2; // OpenRouter free
      if (tier <= 2)  return 3; // Groq (low TPM)
      return 4;                 // Cloudflare (Neuron-billed last)
  }
}

/**
 * Given prompt, history, generation params, and an ordered model chain,
 * return a dynamically reordered chain where the cheapest capable model
 * with available TPM headroom runs first.
 */
export function applyTokenBudget(
  prompt: string,
  history: Array<{ role: string; content: string | unknown[] }>,
  modelChain: string[],
  requestedOutputTokens = 2048,
  systemPrompt = '',
): BudgetAwareChainResult {
  const budget = computeTokenBudget(prompt, history, requestedOutputTokens, systemPrompt);
  const registry = getModelRegistry();
  const now = Date.now();

  const capable: Array<{ id: string; model: ModelConfig; originalIndex: number }> = [];
  const dropped: string[] = [];

  modelChain.forEach((id, originalIndex) => {
    const model = registry.getModel(id);
    if (!model) return; // unknown id — smart-fallback skips it anyway
    if (modelFitsRequest(model, budget)) {
      capable.push({ id, model, originalIndex });
    } else {
      dropped.push(id);
      console.log(
        `[TokenBudget] Skipping ${model.name} — context ${model.contextWindow} < ` +
        `estimated ${budget.totalEstimated} tokens (${budget.bucket})`,
      );
    }
  });

  if (capable.length === 0) {
    console.warn(
      `[TokenBudget] All ${modelChain.length} models dropped for ${budget.bucket} request ` +
      `(~${budget.totalEstimated} tokens) — passing original chain through`,
    );
    return { chain: modelChain, budget, dropped };
  }

  // Dynamic sort:
  //   1. TPM headroom rank (models that fit within remaining TPM first)
  //   2. Bucket preference score (appropriate cost/capacity tier for request size)
  //   3. Cost tier (cheapest first within the same preference band)
  //   4. Original chain index (stable tiebreaker)
  capable.sort((a, b) => {
    const ha = tpmHeadroomRank(a.model, budget, now);
    const hb = tpmHeadroomRank(b.model, budget, now);
    if (ha !== hb) return ha - hb;

    const pa = bucketPreferenceScore(a.model, budget.bucket);
    const pb = bucketPreferenceScore(b.model, budget.bucket);
    if (pa !== pb) return pa - pb;

    const ca = costTier(a.model);
    const cb = costTier(b.model);
    if (ca !== cb) return ca - cb;

    return a.originalIndex - b.originalIndex;
  });

  const chain = capable.map(c => c.id);

  console.log(
    `[TokenBudget] ${budget.bucket} (~${budget.inputTokens} in + ${budget.requestedOutputTokens} out = ~${budget.totalEstimated} tok) ` +
    `→ chain [${chain.slice(0, 4).join(', ')}${chain.length > 4 ? ` +${chain.length - 4} more` : ''}]` +
    (dropped.length ? ` | dropped: [${dropped.join(', ')}]` : ''),
  );

  return { chain, budget, dropped };
}
