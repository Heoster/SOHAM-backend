/**
 * Token Budget — cost-aware chain reordering
 * ════════════════════════════════════════════════════════════════════════════
 *
 * PURPOSE
 * Every model has a fixed context window and TPM quota. Sending a large
 * request to the cheapest model wastes one of its limited TPM slots and
 * always fails with 429. Sending a tiny request to the largest model burns
 * quota that could serve harder tasks later.
 *
 * This module:
 *   1. Estimates input tokens (prompt + history) quickly — no external call.
 *   2. Scores each model in the chain by how well the request "fits" it.
 *   3. Re-orders the chain so the cheapest capable model runs first.
 *   4. Removes models whose context windows are too small.
 *
 * The chain passed in is always used as the source of truth for which models
 * are available — this never adds new models, only filters and reorders.
 *
 * COST TIERS (lower = cheaper / more conservative quota use)
 * ──────────────────────────────────────────────────────────
 *  0  groq small   — 20B and below                 fast, tiny TPM quota
 *  1  groq large   — 27B–120B                      fast, still free-tier
 *  2  google flash — Gemini Flash family            free-tier, good context
 *  3  openrouter   — free router (shared quota)     slowest free option
 *  4  cloudflare   — Workers AI (Neuron quota)      opt-in, billed
 *
 * REQUEST SIZE BUCKETS
 * ────────────────────
 *  TINY   < 500 tokens   → prefer tier 0 (small Groq)
 *  SMALL  < 2 000        → prefer tier 0–1
 *  MEDIUM < 8 000        → prefer tier 1–2
 *  LARGE  < 32 000       → prefer tier 2 (Google has 1M context)
 *  HUGE   ≥ 32 000       → Google only (Groq context cap is 131K but TPM too low)
 */

import { getModelRegistry } from './model-registry';
import type { ModelConfig } from './model-config';

// ─── Token estimation ─────────────────────────────────────────────────────────

/**
 * Fast token estimator — no tokenizer dependency.
 * 1 token ≈ 4 chars for English prose; use 3.5 for code-heavy content.
 * We deliberately round up (÷3.5 → ceiling) to stay conservative.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

export interface TokenBudget {
  /** Estimated input tokens (prompt + history). */
  inputTokens: number;
  /** Desired output tokens from generationParams (may be capped per model). */
  requestedOutputTokens: number;
  /** Total estimated tokens needed. */
  totalEstimated: number;
  /** Named size bucket. */
  bucket: 'TINY' | 'SMALL' | 'MEDIUM' | 'LARGE' | 'HUGE';
}

export function computeTokenBudget(
  prompt: string,
  history: Array<{ role: string; content: string | unknown[] }>,
  requestedOutputTokens = 2048,
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

  const inputTokens = estimateTokens(prompt) + estimateTokens(historyText);
  const totalEstimated = inputTokens + requestedOutputTokens;

  let bucket: TokenBudget['bucket'];
  if (inputTokens < 500)        bucket = 'TINY';
  else if (inputTokens < 2_000) bucket = 'SMALL';
  else if (inputTokens < 8_000) bucket = 'MEDIUM';
  else if (inputTokens < 32_000) bucket = 'LARGE';
  else                           bucket = 'HUGE';

  return { inputTokens, requestedOutputTokens, totalEstimated, bucket };
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
    // Smaller models first: 20b < qwen 27b < 120b
    if (mid.includes('20b'))  return 0;
    if (mid.includes('27b'))  return 1;
    if (mid.includes('120b')) return 2;
    return 1; // unknown groq model — treat as mid-tier
  }
  if (model.provider === 'google') {
    // Flash-lite variants are cheaper than Flash
    if (id.includes('lite'))  return 3;
    return 4;
  }
  if (model.provider === 'openrouter') return 5;
  if (model.provider === 'cloudflare') return 6;
  return 7;
}

// ─── Minimum context needed ───────────────────────────────────────────────────

/**
 * True if the model's context window can accommodate this request with the
 * requested output tokens, using 90 % of the window as the safety ceiling
 * (the remaining 10 % covers system prompt overhead not counted here).
 */
function modelFitsRequest(model: ModelConfig, budget: TokenBudget): boolean {
  const usable = Math.floor((model.contextWindow || 4096) * 0.90);
  return budget.totalEstimated <= usable;
}

// ─── Chain reordering ─────────────────────────────────────────────────────────

export interface BudgetAwareChainResult {
  chain: string[];
  budget: TokenBudget;
  /** IDs removed because their context window was too small. */
  dropped: string[];
}

/**
 * Re-order and filter `modelChain` so the cheapest capable model runs first.
 *
 * Rules:
 *  - Models whose context window < totalEstimated are dropped entirely.
 *  - Remaining models are sorted by:
 *      1. Bucket preference score (see below) — lower is better
 *      2. Cost tier — cheaper first within the same preference band
 *  - If all models are dropped (request too large for every model in chain),
 *    the original chain is returned unchanged so smart-fallback can at least
 *    try (it will hit the "context too large" guard per model).
 *
 * Bucket preference score (how good the fit is — lower = better fit):
 *  TINY/SMALL  → score 0 for tier 0–1 (small Groq), score 2 for tier 2+
 *  MEDIUM      → score 0 for tier 1–2 (Groq large / Google), score 2 for tier 0 or 3+
 *  LARGE/HUGE  → score 0 for tier 3–4 (Google Flash), score 2 for Groq
 */
function bucketPreferenceScore(model: ModelConfig, bucket: TokenBudget['bucket']): number {
  const tier = costTier(model);
  switch (bucket) {
    case 'TINY':
    case 'SMALL':
      // Prefer the smallest Groq models; penalise large models
      if (tier <= 1) return 0;
      if (tier === 2) return 1;
      return 2;
    case 'MEDIUM':
      // Groq 27B and Google Flash are ideal
      if (tier === 1 || tier === 3 || tier === 4) return 0;
      if (tier === 0 || tier === 2) return 1;
      return 2;
    case 'LARGE':
    case 'HUGE':
      // Only Google really fits; Groq context is fine but TPM too low for large bodies
      if (tier === 3 || tier === 4) return 0;
      if (tier === 5) return 1;
      return 2;
  }
}

/**
 * Given a prompt, history, generation params, and an ordered model chain,
 * return a reordered chain that tries the cheapest capable model first.
 *
 * This is the single call site added to chat-stream.ts — everything else
 * (circuit breakers, provider cooldowns) stays in smart-fallback.ts.
 */
export function applyTokenBudget(
  prompt: string,
  history: Array<{ role: string; content: string | unknown[] }>,
  modelChain: string[],
  requestedOutputTokens = 2048,
): BudgetAwareChainResult {
  const budget = computeTokenBudget(prompt, history, requestedOutputTokens);
  const registry = getModelRegistry();

  const capable: Array<{ id: string; model: ModelConfig }> = [];
  const dropped: string[] = [];

  for (const id of modelChain) {
    const model = registry.getModel(id);
    if (!model) continue; // unknown id — smart-fallback will skip it anyway
    if (modelFitsRequest(model, budget)) {
      capable.push({ id, model });
    } else {
      dropped.push(id);
      console.log(
        `[TokenBudget] Skipping ${model.name} — context ${model.contextWindow} < ` +
        `estimated ${budget.totalEstimated} tokens (${budget.bucket})`,
      );
    }
  }

  if (capable.length === 0) {
    // Every model was dropped — return original chain so smart-fallback can
    // try and report its own "context too large" per-model error.
    console.warn(
      `[TokenBudget] All ${modelChain.length} models dropped for ${budget.bucket} request ` +
      `(~${budget.totalEstimated} tokens) — passing original chain through`,
    );
    return { chain: modelChain, budget, dropped };
  }

  // Sort: primary = bucket preference, secondary = cost tier (ascending)
  capable.sort((a, b) => {
    const pa = bucketPreferenceScore(a.model, budget.bucket);
    const pb = bucketPreferenceScore(b.model, budget.bucket);
    if (pa !== pb) return pa - pb;
    return costTier(a.model) - costTier(b.model);
  });

  const chain = capable.map(c => c.id);

  console.log(
    `[TokenBudget] ${budget.bucket} request (~${budget.inputTokens} input tokens) ` +
    `→ chain [${chain.slice(0, 4).join(', ')}${chain.length > 4 ? ` +${chain.length - 4} more` : ''}]` +
    (dropped.length ? ` | dropped: [${dropped.join(', ')}]` : ''),
  );

  return { chain, budget, dropped };
}
