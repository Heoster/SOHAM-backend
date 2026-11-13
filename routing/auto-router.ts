/** Intent-aware model selection backed only by the validated, enabled provider catalog. */
import type { IntentType } from '../core/intent-detector';
import type { ModelCategory } from './model-config';
import { getModelRegistry } from './model-registry';

export interface AutoRouteResult {
  modelChain: string[];
  preferredModelId: string;
  category: ModelCategory;
  params: { temperature: number; topP: number; topK: number; maxOutputTokens: number };
}

interface IntentPolicy {
  category: ModelCategory;
  preferred: string[];
  temperature: number;
  maxOutputTokens: number;
}

const DEFAULT: IntentPolicy = {
  category: 'general',
  preferred: ['groq-gpt-oss-20b', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'openrouter-free-router'],
  temperature: 0.7,
  maxOutputTokens: 2048,
};

const POLICIES: Partial<Record<IntentType, IntentPolicy>> = {
  CHAT: DEFAULT,
  WEB_SEARCH: { ...DEFAULT, temperature: 0.5 },
  IMAGE_GENERATION: DEFAULT,
  CODE_GENERATION: {
    category: 'coding',
    preferred: ['groq-gpt-oss-120b', 'groq-qwen3.8-27b', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'openrouter-free-router'],
    temperature: 0.25,
    maxOutputTokens: 4096,
  },
  EXPLANATION: {
    category: 'general',
    preferred: ['groq-gpt-oss-120b', 'groq-qwen3.8-27b', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    temperature: 0.55,
    maxOutputTokens: 4096,
  },
  TRANSLATION: { ...DEFAULT, temperature: 0.25, maxOutputTokens: 2048 },
  SENTIMENT_ANALYSIS: { ...DEFAULT, temperature: 0.2, maxOutputTokens: 512 },
  GRAMMAR_CHECK: { ...DEFAULT, temperature: 0.2, maxOutputTokens: 2048 },
  QUIZ_GENERATION: { ...DEFAULT, temperature: 0.65, maxOutputTokens: 4096 },
  RECIPE: { ...DEFAULT, temperature: 0.65, maxOutputTokens: 3072 },
  JOKE: { ...DEFAULT, temperature: 0.9, maxOutputTokens: 1024 },
  DICTIONARY: { ...DEFAULT, temperature: 0.2, maxOutputTokens: 1024 },
  FACT_CHECK: {
    category: 'general',
    preferred: ['groq-gpt-oss-120b', 'groq-gpt-oss-20b', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    temperature: 0.15,
    maxOutputTokens: 2048,
  },
};

export function resolveAutoRoute(intent: IntentType): AutoRouteResult {
  const policy = POLICIES[intent] ?? DEFAULT;
  const registry = getModelRegistry();
  const available = registry.getAvailableModels();
  const preferred = policy.preferred.filter(id => registry.isModelAvailable(id));
  const categoryModels = registry.getModelsByCategory(policy.category).map(model => model.id);
  const providerOrder = ['groq', 'google', 'openrouter'];
  const providerFallback = providerOrder.flatMap(provider =>
    available.filter(model => model.provider === provider).map(model => model.id)
  );
  const modelChain = [...new Set([...preferred, ...categoryModels, ...providerFallback])];

  return {
    modelChain,
    preferredModelId: modelChain[0] ?? '',
    category: policy.category,
    params: { temperature: policy.temperature, topP: 0.9, topK: 40, maxOutputTokens: policy.maxOutputTokens },
  };
}
