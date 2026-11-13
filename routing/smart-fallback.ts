/**
 * Smart Fallback Engine
 * Automatically falls back between models when one fails.
 * Includes circuit breaker to skip repeatedly-failing models.
 */

import { getModelRegistry } from './model-registry';
import { AIServiceError, type ModelConfig, type ModelCategory, type ProviderType } from './model-config';
import { getAdapter } from '../adapters';
import type { GenerateRequest, GenerateResponse } from '../adapters/types';

// ── Circuit breaker ───────────────────────────────────────────────────────────
// Tracks consecutive failures per model. After CIRCUIT_THRESHOLD failures
// within CIRCUIT_WINDOW_MS, the model is skipped for CIRCUIT_COOLDOWN_MS.

const CIRCUIT_THRESHOLD  = 3;
const CIRCUIT_WINDOW_MS  = 5 * 60_000;   // 5 minutes
const CIRCUIT_COOLDOWN_MS = 2 * 60_000;  // 2 minutes cooldown

interface CircuitState {
  failures: number[];   // timestamps of recent failures
  openUntil: number;    // epoch ms — model is skipped until this time
}

const circuitBreakers = new Map<string, CircuitState>();
const providerCooldowns = new Map<ProviderType, number>();
const PROVIDER_COOLDOWN_MS = 30_000;

function isCircuitOpen(modelId: string): boolean {
  const state = circuitBreakers.get(modelId);
  if (!state) return false;
  if (Date.now() < state.openUntil) return true;
  // Cooldown expired — reset
  state.openUntil = 0;
  state.failures = [];
  return false;
}

function recordFailure(modelId: string): void {
  const now = Date.now();
  let state = circuitBreakers.get(modelId);
  if (!state) {
    state = { failures: [], openUntil: 0 };
    circuitBreakers.set(modelId, state);
  }
  // Slide the window
  state.failures = state.failures.filter(t => now - t < CIRCUIT_WINDOW_MS);
  state.failures.push(now);
  if (state.failures.length >= CIRCUIT_THRESHOLD) {
    state.openUntil = now + CIRCUIT_COOLDOWN_MS;
    console.warn(`[Circuit] ${modelId} tripped — skipping for ${CIRCUIT_COOLDOWN_MS / 1000}s`);
  }
}

function recordSuccess(modelId: string): void {
  const state = circuitBreakers.get(modelId);
  if (state) { state.failures = []; state.openUntil = 0; }
}

function isProviderCoolingDown(provider: ProviderType): boolean {
  const until = providerCooldowns.get(provider) ?? 0;
  if (Date.now() >= until) {
    providerCooldowns.delete(provider);
    return false;
  }
  return true;
}

function recordProviderFailure(provider: ProviderType, error: unknown): void {
  if (!(error instanceof AIServiceError)) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (/fetch failed|network|timeout|econn|etimedout/.test(message)) {
      providerCooldowns.set(provider, Date.now() + PROVIDER_COOLDOWN_MS);
    }
    return;
  }
  if (error.code === 'AUTH_ERROR') {
    // Bad credentials affect every model for this provider. Re-check during the
    // registry's periodic refresh rather than sending a request per model.
    getModelRegistry().markProviderUnavailable(provider);
  } else if (error.code === 'RATE_LIMIT' || error.code === 'NETWORK_ERROR') {
    providerCooldowns.set(provider, Date.now() + PROVIDER_COOLDOWN_MS);
  }
}


function modelSupportsRequestedGroqTools(model: ModelConfig, request: Pick<GenerateRequest, 'groqBuiltinTools' | 'enableLocalToolCalling'>): boolean {
  const hasBuiltins = Boolean(request.groqBuiltinTools?.length);
  const hasLocalTools = request.enableLocalToolCalling === true;
  if (!hasBuiltins && !hasLocalTools) return true;
  if (model.provider !== 'groq') return false;
  if (hasBuiltins && !['openai/gpt-oss-120b', 'openai/gpt-oss-20b'].includes(model.modelId)) return false;
  if (hasLocalTools && !['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'].includes(model.modelId)) return false;
  return true;
}

interface FallbackAttempt {
  modelId: string;
  error: string;
  timestamp: number;
}

interface FallbackResult {
  response: GenerateResponse;
  modelUsed: string;
  attempts: FallbackAttempt[];
  fallbackTriggered: boolean;
}

/**
 * Exponential backoff delay calculator
 */
function getBackoffDelay(attemptNumber: number): number {
  const baseDelay = 1000; // 1 second
  const maxDelay = 10000; // 10 seconds
  const delay = Math.min(baseDelay * Math.pow(2, attemptNumber), maxDelay);
  return delay;
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if error is a critical failure that should trigger immediate fallback
 */
function isCriticalFailure(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  
  // Critical failures that should trigger immediate fallback
  const criticalPatterns = [
    'Model is currently loading',
    'Service Unavailable',
    '503',
    '502',
    '504',
    'timeout',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'fetch failed',
    'Network error',
    'Model.*is currently loading',
    'estimated_time',
    // Token/payload limits — fall back to a model with higher limits
    '413',
    'Payload Too Large',
    'Request too large',
    'tokens per minute',
    'rate_limit_exceeded',
    'TPM',
  ];
  
  return criticalPatterns.some(pattern => 
    errorMessage.toLowerCase().includes(pattern.toLowerCase())
  );
}

/**
 * Get fallback models for a given category.
 * Spreads fallback attempts across the supported providers before retrying
 * another model at the same provider. Highest-priority models come first.
 */
function getFallbackModels(category: ModelCategory): ModelConfig[] {
  const registry = getModelRegistry();

  // Prefer Groq for low latency, then Google, Cloudflare, and OpenRouter.
  const providerOrder = ['groq', 'google', 'openrouter'];

  const categoryModels = registry.getModelsByCategory(category);
  const allModels = registry.getAvailableModels();

  // Use category models if available, otherwise fall back to all models
  const pool = categoryModels.length > 0 ? categoryModels : allModels;

  // Group by provider (already sorted by priority within each group from registry)
  const byProvider = new Map<string, ModelConfig[]>();
  for (const m of pool) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider)!.push(m);
  }

  // Interleave: take top models from each provider in rotation order
  // This ensures fallback attempts cover each configured provider
  const result: ModelConfig[] = [];
  const maxPerProvider = 3;

  for (let slot = 0; slot < maxPerProvider; slot++) {
    for (const provider of providerOrder) {
      const models = byProvider.get(provider) ?? [];
      if (models[slot]) result.push(models[slot]);
    }
  }

  // Append any remaining models not yet included
  for (const m of pool) {
    if (!result.find(r => r.id === m.id)) result.push(m);
  }

  return result;
}

/**
 * Validate context window size
 * Returns true if the content fits within the model's context window
 */
function validateContextWindow(
  prompt: string,
  history: any[],
  model: ModelConfig
): boolean {
  // Rough token estimation (4 chars ≈ 1 token)
  const promptTokens = Math.ceil(prompt.length / 4);
  
  const historyTokens = history.reduce((sum, msg) => {
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map((c: any) => c.text || '').join('');
    }
    return sum + Math.ceil(content.length / 4);
  }, 0);
  
  const totalTokens = promptTokens + historyTokens;
  const maxTokens = model.contextWindow * 0.8; // Use 80% of limit for safety
  
  if (totalTokens > maxTokens) {
    console.warn(
      `Context too large (${totalTokens} tokens) for ${model.name} (${model.contextWindow} limit, using ${maxTokens} max)`
    );
    return false;
  }
  
  return true;
}

/**
 * Try to generate with a specific model with retry logic
 */
async function tryGenerateWithModel(
  model: ModelConfig,
  request: Omit<GenerateRequest, 'model'>,
  maxRetries: number = 0
): Promise<GenerateResponse> {
  const adapter = getAdapter(model.provider);
  
  // Validate context window before attempting
  if (!validateContextWindow(request.prompt, request.history || [], model)) {
    throw new Error(
      `Context exceeds model's capacity. Please start a new conversation or reduce message history.`
    );
  }
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await adapter.generate({
        ...request,
        model,
      });
      return response;
    } catch (error) {
      const isCritical = isCriticalFailure(error);
      const isLastAttempt = attempt === maxRetries;
      
      // If critical failure or last attempt, throw immediately
      if (isCritical || isLastAttempt) {
        throw error;
      }
      
      // Otherwise, wait with exponential backoff and retry
      const delay = getBackoffDelay(attempt);
      console.warn(`Attempt ${attempt + 1} failed for ${model.id}, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  
  throw new Error('Max retries exceeded');
}

/**
 * Smart fallback generation with automatic model switching
 */
export async function generateWithSmartFallback(
  request: Omit<GenerateRequest, 'model'> & { 
    preferredModelId?: string;
    modelChain?: string[];       // ordered list from auto-router — tried before category pool
    category?: ModelCategory;
  }
): Promise<FallbackResult> {
  const registry = getModelRegistry();
  const attempts: FallbackAttempt[] = [];
  let fallbackTriggered = false;
  const startTime = Date.now();
  const MAX_TOTAL_TIME = 55000;

  // ── Build ordered model list ──────────────────────────────────────────────
  // Priority: modelChain (auto-router order) → preferredModelId → category pool → all models
  const seen = new Set<string>();
  const modelsToTry: ModelConfig[] = [];

  const addModel = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const m = registry.getModel(id);
    if (m && registry.isModelAvailable(id) && modelSupportsRequestedGroqTools(m, request)) modelsToTry.push(m);
  };

  // 1. Walk the custom chain first (respects auto-router intent order)
  if (request.modelChain?.length) {
    request.modelChain.forEach(addModel);
  }

  // 2. Preferred model (manual selection or single override)
  if (request.preferredModelId) addModel(request.preferredModelId);

  // 3. Category pool as safety net
  if (request.category) {
    getFallbackModels(request.category).forEach(m => addModel(m.id));
  }

  // Always add the remaining providers as cross-category fallbacks. Restricting
  // to a non-empty category pool previously hid Google/vision models from chat.
  registry.getAvailableModels().forEach(m => addModel(m.id));

  if (modelsToTry.length === 0) {
    throw new Error('No models available. Please check your API key configuration.');
  }

  const maxModelsToTry = Math.min(modelsToTry.length, 12);

  for (let i = 0; i < maxModelsToTry; i++) {
    const model = modelsToTry[i];

    if (Date.now() - startTime > MAX_TOTAL_TIME) {
      throw new Error('Request timeout - exceeded maximum processing time');
    }

    // Skip providers with invalid credentials or a temporary provider-wide outage.
    if (!registry.isProviderAvailable(model.provider) || isProviderCoolingDown(model.provider)) {
      console.log(`[Fallback] Skipping ${model.provider} — provider unavailable or cooling down`);
      continue;
    }

    // Skip models whose circuit breaker is open
    if (isCircuitOpen(model.id)) {
      console.log(`[Fallback] Skipping ${model.id} — circuit open`);
      continue;
    }

    try {
      console.log(`Attempting generation with ${model.name} (${model.id})...`);
      const response = await tryGenerateWithModel(model, request);
      recordSuccess(model.id);
      return { response, modelUsed: model.id, attempts, fallbackTriggered: i > 0 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      attempts.push({ modelId: model.id, error: errorMessage, timestamp: Date.now() });
      console.error(`Failed to generate with ${model.name}:`, errorMessage);
      recordFailure(model.id);
      recordProviderFailure(model.provider, error);

      if (isCriticalFailure(error) && i < maxModelsToTry - 1) {
        fallbackTriggered = true;
        continue;
      }
      if (i === maxModelsToTry - 1) {
        throw new Error(`All models failed. Last error: ${errorMessage}. Attempted: ${attempts.map(a => a.modelId).join(', ')}`);
      }
      fallbackTriggered = true;
    }
  }

  const lastAttempt = attempts[attempts.length - 1];
  throw new Error(lastAttempt
    ? `All models failed. Last error: ${lastAttempt.error}. Attempted: ${attempts.map(a => a.modelId).join(', ')}`
    : 'No available model remained after provider and circuit-breaker checks.');
}

/**
 * Streaming smart fallback — yields tokens from the first model that supports streaming.
 * Falls back to non-streaming models if needed, yielding the full text as one chunk.
 * Returns metadata (modelUsed, fallbackTriggered) via the returned promise.
 */
export async function* streamWithSmartFallback(
  request: Omit<GenerateRequest, 'model'> & {
    preferredModelId?: string;
    modelChain?: string[];       // ordered list from auto-router
    category?: ModelCategory;
  },
  onModelSelected?: (modelId: string) => void
): AsyncGenerator<string, { modelUsed: string; fallbackTriggered: boolean; toolsUsed?: string[] }, unknown> {
  const registry = getModelRegistry();
  const startTime = Date.now();
  const MAX_TOTAL_TIME = 55000;

  // ── Build ordered model list (same logic as generateWithSmartFallback) ────
  const seen = new Set<string>();
  const modelsToTry: ModelConfig[] = [];

  const addModel = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const m = registry.getModel(id);
    if (m && registry.isModelAvailable(id) && modelSupportsRequestedGroqTools(m, request)) modelsToTry.push(m);
  };

  if (request.modelChain?.length) request.modelChain.forEach(addModel);
  if (request.preferredModelId) addModel(request.preferredModelId);
  if (request.category) getFallbackModels(request.category).forEach(m => addModel(m.id));
  registry.getAvailableModels().forEach(m => addModel(m.id));

  if (modelsToTry.length === 0) {
    throw new Error('No models available. Please check your API key configuration.');
  }

  const maxModelsToTry = Math.min(modelsToTry.length, 12);
  const failures: string[] = [];

  for (let i = 0; i < maxModelsToTry; i++) {
    const model = modelsToTry[i];

    if (Date.now() - startTime > MAX_TOTAL_TIME) {
      throw new Error('Request timeout - exceeded maximum processing time');
    }

    if (!validateContextWindow(request.prompt, request.history || [], model)) {
      continue;
    }

    // Skip providers with invalid credentials or a temporary provider-wide outage.
    if (!registry.isProviderAvailable(model.provider) || isProviderCoolingDown(model.provider)) {
      console.log(`[Fallback] Skipping ${model.provider} — provider unavailable or cooling down`);
      continue;
    }

    // Skip models whose circuit breaker is open
    if (isCircuitOpen(model.id)) {
      console.log(`[Stream] Skipping ${model.id} — circuit open`);
      continue;
    }

    const adapter = getAdapter(model.provider);
    let streamedTokens = 0;

    try {
      console.log(`[Stream] Attempting ${model.name} (${model.id})...`);
      onModelSelected?.(model.id);

      if (request.groqBuiltinTools?.length || request.enableLocalToolCalling) {
        const response = await adapter.generate({ ...request, model });
        if (!response.text?.trim()) throw new Error(`${model.provider} returned an empty completion`);
        streamedTokens++;
        yield response.text;
        recordSuccess(model.id);
        return { modelUsed: model.id, fallbackTriggered: i > 0, toolsUsed: response.toolsUsed };
      } else if (adapter.generateStream) {
        const subGen = adapter.generateStream({ ...request, model });
        let next = await subGen.next();
        while (!next.done) {
          streamedTokens++;
          yield next.value;
          next = await subGen.next();
        }
      } else {
        const response = await adapter.generate({ ...request, model });
        if (!response.text?.trim()) throw new Error(`${model.provider} returned an empty completion`);
        streamedTokens++;
        yield response.text;
      }
      if (streamedTokens === 0) throw new Error(`${model.provider} returned an empty stream`);

      recordSuccess(model.id);
      return { modelUsed: model.id, fallbackTriggered: i > 0 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const diagnostic = error && typeof error === 'object' && 'diagnostic' in error
        ? String((error as { diagnostic: unknown }).diagnostic)
        : errorMessage;
      console.error(`[Stream] Failed with ${model.name} (${model.provider}/${model.modelId}):`, diagnostic);
      failures.push(`${model.provider}/${model.modelId}: ${diagnostic}`);
      recordFailure(model.id);
      recordProviderFailure(model.provider, error);
      // Once any token has been sent, switching providers would splice two answers
      // together. Only retry failures that occur before output begins.
      if (streamedTokens > 0) throw new Error(`Stream interrupted by ${model.provider}; retry the request.`);
      if (i < maxModelsToTry - 1) continue;
      throw new Error(`All models failed. Last error: ${errorMessage}`);
    }
  }

  throw new Error(failures.length
    ? `All models failed. Last error: ${failures[failures.length - 1]}. Attempted: ${failures.length}`
    : 'No available model remained after provider and circuit-breaker checks.');
}

/**
 * Get a user-friendly error message
 */
export function getFriendlyErrorMessage(error: unknown): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  
  if (errorMessage.toLowerCase().includes('no models available')) {
    return 'No enabled free-plan provider credentials are configured. Set GOOGLE_API_KEY or OPENROUTER_API_KEY, or provide GROQ_API_KEY with GROQ_FREE_PLAN_ONLY=true for a confirmed Groq Free-plan account.';
  }

  if (errorMessage.toLowerCase().includes('stream interrupted')) {
    return 'The provider connection dropped during the response. Please retry your message.';
  }
  
  if (errorMessage.includes('Model is currently loading')) {
    return 'The AI model is loading. This usually takes 20-30 seconds. Please try again in a moment.';
  }
  
  if (errorMessage.includes('rate') || errorMessage.includes('quota')) {
    return 'The service is temporarily busy. Please try again in a moment.';
  }
  
  if (errorMessage.includes('timeout') || errorMessage.includes('network') || errorMessage.includes('fetch failed')) {
    return 'Network error. Please check your internet connection and API key configuration.';
  }
  
  if (errorMessage.includes('All models failed')) {
    return 'All configured AI providers (Groq, Google Gemini, Cloudflare Workers AI, and OpenRouter) are currently unavailable. Check provider credentials and model access, then try again.';
  }
  
  return 'An unexpected error occurred. Please try again.';
}
