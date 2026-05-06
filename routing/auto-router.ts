/**
 * Auto Router — Intent-to-Model Mapping
 * ──────────────────────────────────────────────────────────────────────────────
 * Maps each detected intent to an ordered list of models to try, from best to
 * fallback. The first available model in the list wins.
 *
 * All 26 registered models are used across the fallback chains.
 *
 * Model pool (by provider, priority order):
 *
 *   CEREBRAS (fastest hardware)
 *     cerebras-deepseek-v3-0324   — Z.ai GLM 4.7, best coder        (coding,  p100)
 *     cerebras-llama-4-scout-17b  — Llama 3.1 8B, fastest chat      (general, p95)
 *     cerebras-gpt-oss-120b       — GPT-OSS 120B, strong reasoning   (coding,  p95)
 *     cerebras-llama-3.3-70b      — Qwen 3 235B, deep reasoning      (general, p90)
 *
 *   GROQ (fast inference)
 *     groq-llama-3.3-70b          — Llama 3.3 70B Versatile, chat    (general, p92)
 *     groq-gpt-oss-120b           — GPT-OSS 120B, coding             (coding,  p88)
 *     groq-llama-4-scout-17b      — Llama 4 Scout 17B, multimodal    (multimodal, p85)
 *     groq-mistral-saba-24b       — Qwen3 32B, multilingual          (general, p80)
 *     groq-llama-3.2-3b           — Llama 3.1 8B Instant, fast       (general, p90)
 *
 *   GOOGLE (high accuracy)
 *     gemini-3-pro-preview        — Gemini 2.5 Pro, best accuracy    (multimodal, p100)
 *     gemini-2.5-pro              — Gemini 2.5 Pro                   (multimodal, p95)
 *     gemini-2.5-flash            — Gemini 2.5 Flash, fast           (multimodal, p90)
 *
 *   HUGGINGFACE (free fallback)
 *     hf-llama-3.3-70b-instruct   — Llama 3.3 70B                    (general, p65)
 *     hf-deepseek-r1-distill-llama-70b — DeepSeek R1 reasoning       (coding,  p63)
 *     hf-qwen2.5-72b-instruct     — Qwen 2.5 72B                     (general, p62)
 *     hf-qwen2.5-7b-instruct      — Qwen 2.5 7B, fast                (general, p61)
 *     hf-llama-3.1-8b-instruct    — Llama 3.1 8B                     (general, p60)
 *
 *   OPENROUTER (free tier)
 *     openrouter-gpt-oss-120b-free     — GPT-OSS 120B                (coding,  p59)
 *     openrouter-gpt-oss-20b-free      — GPT-OSS 20B                 (general, p58)
 *     openrouter-nvidia-nemotron-super-free — NVIDIA 120B            (general, p57)
 *     openrouter-gemma-3-27b-free      — Gemma 3 27B                 (general, p56)
 *     openrouter-elephant-alpha        — Elephant 100B               (general, p56)
 *     openrouter-gemma-3-12b-free      — Gemma 3 12B                 (general, p55)
 *     openrouter-arcee-trinity-free    — Arcee 400B MoE              (general, p54)
 *     openrouter-minimax-m2.5-free     — MiniMax M2.5                (coding,  p53)
 */

import type { IntentType } from '../core/intent-detector';
import type { ModelCategory } from './model-config';
import { getModelRegistry } from './model-registry';

export interface AutoRouteResult {
  /** Ordered list of model IDs to try — first available wins */
  modelChain: string[];
  /** The first available model from the chain (ready to pass to smart-fallback) */
  preferredModelId: string;
  /** Registry category for ultimate fallback if all chain models fail */
  category: ModelCategory;
  /** Generation params tuned for this task */
  params: {
    temperature: number;
    topP: number;
    topK: number;
    maxOutputTokens: number;
  };
}

// ── Shared fallback tails ─────────────────────────────────────────────────────
// These are appended to every chain so no request ever has nowhere to go.

/** General-purpose fallback tail — covers all providers */
const GENERAL_TAIL = [
  'hf-llama-3.3-70b-instruct',
  'hf-qwen2.5-72b-instruct',
  'openrouter-gpt-oss-20b-free',
  'openrouter-nvidia-nemotron-super-free',
  'openrouter-gemma-3-27b-free',
  'openrouter-elephant-alpha',
  'openrouter-gemma-3-12b-free',
  'openrouter-arcee-trinity-free',
  'hf-qwen2.5-7b-instruct',
  'hf-llama-3.1-8b-instruct',
];

/** Coding-specific fallback tail */
const CODING_TAIL = [
  'hf-deepseek-r1-distill-llama-70b',
  'openrouter-gpt-oss-120b-free',
  'openrouter-minimax-m2.5-free',
  ...GENERAL_TAIL,
];

/** Multimodal fallback tail */
const MULTIMODAL_TAIL = [
  'groq-llama-4-scout-17b',
  ...GENERAL_TAIL,
];

// ── Intent routing table ──────────────────────────────────────────────────────

const INTENT_ROUTING: Record<IntentType, {
  chain: string[];
  category: ModelCategory;
  temp: number;
  tokens: number;
}> = {

  // ── CHAT ──────────────────────────────────────────────────────────────────
  // Groq 70B first — fast, smart, great conversationalist.
  // Cerebras 8B as immediate fallback for speed.
  CHAT: {
    chain: [
      'groq-llama-3.3-70b',           // Llama 3.3 70B Versatile — primary chat model
      'cerebras-llama-4-scout-17b',   // Llama 3.1 8B on Cerebras — fastest fallback
      'groq-llama-3.2-3b',            // Llama 3.1 8B Instant on Groq
      'cerebras-llama-3.3-70b',       // Qwen 3 235B — if 8B is busy
      'groq-mistral-saba-24b',        // Qwen3 32B
      ...GENERAL_TAIL,
    ],
    category: 'general',
    temp: 0.8,
    tokens: 2048,
  },

  // ── CODE GENERATION ───────────────────────────────────────────────────────
  // GLM 4.7 on Cerebras is the strongest coder. GPT-OSS 120B as backup.
  CODE_GENERATION: {
    chain: [
      'cerebras-deepseek-v3-0324',    // Z.ai GLM 4.7 — best coder on Cerebras
      'cerebras-gpt-oss-120b',        // GPT-OSS 120B on Cerebras
      'groq-gpt-oss-120b',            // GPT-OSS 120B on Groq
      'groq-llama-3.3-70b',           // Llama 3.3 70B — strong coder
      ...CODING_TAIL,
    ],
    category: 'coding',
    temp: 0.3,
    tokens: 8192,
  },

  // ── EXPLANATION ───────────────────────────────────────────────────────────
  // Qwen 235B for deep reasoning. Groq 70B as fast fallback.
  EXPLANATION: {
    chain: [
      'cerebras-llama-3.3-70b',       // Qwen 3 235B — best for thorough explanations
      'groq-llama-3.3-70b',           // Llama 3.3 70B — fast + smart
      'gemini-3-pro-preview',         // Gemini 2.5 Pro — high accuracy
      'cerebras-gpt-oss-120b',        // GPT-OSS 120B
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      ...GENERAL_TAIL,
    ],
    category: 'general',
    temp: 0.6,
    tokens: 4096,
  },

  // ── WEB SEARCH ────────────────────────────────────────────────────────────
  // Speed matters — context is already injected by the tool layer.
  // Use fast models that can synthesise search results quickly.
  WEB_SEARCH: {
    chain: [
      'cerebras-llama-4-scout-17b',   // Fastest — 8B on Cerebras hardware
      'groq-llama-3.2-3b',            // Llama 3.1 8B Instant on Groq
      'groq-llama-3.3-70b',           // 70B if 8B is rate-limited
      'cerebras-llama-3.3-70b',       // Qwen 235B
      'groq-mistral-saba-24b',        // Qwen3 32B
      ...GENERAL_TAIL,
    ],
    category: 'general',
    temp: 0.5,
    tokens: 2048,
  },

  // ── TRANSLATION ───────────────────────────────────────────────────────────
  // Qwen3 32B is the best multilingual model in the pool.
  TRANSLATION: {
    chain: [
      'groq-mistral-saba-24b',        // Qwen3 32B — multilingual specialist
      'cerebras-llama-3.3-70b',       // Qwen 3 235B — also multilingual
      'groq-llama-3.3-70b',           // Llama 3.3 70B
      'gemini-2.5-flash',             // Gemini — strong multilingual
      'gemini-3-pro-preview',
      'hf-qwen2.5-72b-instruct',      // Qwen 2.5 72B — multilingual
      ...GENERAL_TAIL,
    ],
    category: 'general',
    temp: 0.3,
    tokens: 2048,
  },

  // ── FACT CHECK ────────────────────────────────────────────────────────────
  // Accuracy over speed. Gemini Pro is the most reliable.
  FACT_CHECK: {
    chain: [
      'gemini-3-pro-preview',         // Gemini 2.5 Pro — highest accuracy
      'gemini-2.5-pro',
      'cerebras-llama-3.3-70b',       // Qwen 3 235B — strong reasoning
      'groq-llama-3.3-70b',           // Llama 3.3 70B
      'gemini-2.5-flash',
      'cerebras-gpt-oss-120b',
      ...GENERAL_TAIL,
    ],
    category: 'multimodal',
    temp: 0.2,
    tokens: 2048,
  },

  // ── GRAMMAR CHECK ─────────────────────────────────────────────────────────
  // Language precision. Qwen3 32B excels at language tasks.
  GRAMMAR_CHECK: {
    chain: [
      'groq-mistral-saba-24b',        // Qwen3 32B — language specialist
      'groq-llama-3.3-70b',           // Llama 3.3 70B
      'cerebras-llama-3.3-70b',       // Qwen 3 235B
      'hf-qwen2.5-72b-instruct',      // Qwen 2.5 72B
      ...GENERAL_TAIL,
    ],
    category: 'general',
    temp: 0.2,
    tokens: 2048,
  },

  // ── SENTIMENT ANALYSIS ────────────────────────────────────────────────────
  // Simple classification — fast 8B is more than enough.
  SENTIMENT_ANALYSIS: {
    chain: [
      'cerebras-llama-4-scout-17b',   // Fastest
      'groq-llama-3.2-3b',            // Llama 3.1 8B Instant
      'groq-llama-3.3-70b',           // 70B fallback
      'groq-mistral-saba-24b',
      ...GENERAL_TAIL,
    ],
    category: 'general',
    temp: 0.3,
    tokens: 512,
  },

  // ── QUIZ GENERATION ───────────────────────────────────────────────────────
  // Structured long output — needs a capable model.
  QUIZ_GENERATION: {
    chain: [
      'cerebras-llama-3.3-70b',       // Qwen 3 235B — best for structured output
      'groq-llama-3.3-70b',           // Llama 3.3 70B
      'cerebras-gpt-oss-120b',        // GPT-OSS 120B
      'gemini-2.5-flash',
      'groq-mistral-saba-24b',
      ...GENERAL_TAIL,
    ],
    category: 'general',
    temp: 0.7,
    tokens: 4096,
  },

  // ── RECIPE ────────────────────────────────────────────────────────────────
  // Creative + structured. Fast models handle this well.
  RECIPE: {
    chain: [
      'groq-llama-3.3-70b',           // Llama 3.3 70B — good at structured creative
      'cerebras-llama-4-scout-17b',   // Fast 8B
      'groq-llama-3.2-3b',            // Llama 3.1 8B Instant
      'cerebras-llama-3.3-70b',
      'groq-mistral-saba-24b',
      ...GENERAL_TAIL,
    ],
    category: 'general',
    temp: 0.7,
    tokens: 2048,
  },

  // ── JOKE ──────────────────────────────────────────────────────────────────
  // Creative, short. Groq 70B has great personality.
  JOKE: {
    chain: [
      'groq-llama-3.3-70b',           // Llama 3.3 70B — witty and fast
      'cerebras-llama-4-scout-17b',   // Fast 8B
      'groq-llama-3.2-3b',
      'groq-mistral-saba-24b',
      ...GENERAL_TAIL,
    ],
    category: 'general',
    temp: 0.9,
    tokens: 512,
  },

  // ── DICTIONARY ────────────────────────────────────────────────────────────
  // Precise, short. Fast models are ideal.
  DICTIONARY: {
    chain: [
      'cerebras-llama-4-scout-17b',   // Fastest
      'groq-llama-3.2-3b',            // Llama 3.1 8B Instant
      'groq-llama-3.3-70b',
      'groq-mistral-saba-24b',
      ...GENERAL_TAIL,
    ],
    category: 'general',
    temp: 0.2,
    tokens: 512,
  },

  // ── IMAGE GENERATION ──────────────────────────────────────────────────────
  // Intercepted before routing — this is a safety fallback only.
  IMAGE_GENERATION: {
    chain: [
      'cerebras-llama-4-scout-17b',
      'groq-llama-3.3-70b',
      ...GENERAL_TAIL,
    ],
    category: 'general',
    temp: 0.7,
    tokens: 512,
  },
};

// ── Resolver ──────────────────────────────────────────────────────────────────

/**
 * Resolve the best available model + params for a given intent in Auto mode.
 *
 * Walks the model chain and returns the first model that is actually available
 * (API key present, model enabled, lifecycle ACTIVE).
 * Falls back to the category pool if the entire chain is unavailable.
 */
export function resolveAutoRoute(intent: IntentType): AutoRouteResult {
  const route = INTENT_ROUTING[intent] ?? INTENT_ROUTING['CHAT'];
  const registry = getModelRegistry();

  // Find the first available model in the chain
  const firstAvailable = route.chain.find(id => registry.isModelAvailable(id));

  return {
    modelChain: route.chain,
    preferredModelId: firstAvailable ?? getFirstAvailableInCategory(route.category),
    category: route.category,
    params: {
      temperature: route.temp,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: route.tokens,
    },
  };
}

function getFirstAvailableInCategory(category: ModelCategory): string {
  const registry = getModelRegistry();
  const models = registry.getModelsByCategory(category);
  return models[0]?.id ?? '';
}
