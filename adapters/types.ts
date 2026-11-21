/**
 * Provider Adapter Types
 * ──────────────────────
 * Common interface for all AI provider adapters.
 * Providers: Groq, Google Gemini, OpenRouter, Cloudflare Workers AI
 */

import type { ModelConfig, ModelParams, ProviderType } from '../routing/model-config';

export interface MessageData {
  role: 'user' | 'model' | 'assistant';
  content: string | Array<{ text: string }>;
}

export type GroqBuiltinTool = 'browser_search' | 'code_interpreter';

export interface GenerateRequest {
  model: ModelConfig;
  prompt: string;
  systemPrompt?: string;
  history?: MessageData[];
  params?: Partial<ModelParams>;
  /** Groq-hosted tools available on GPT-OSS only; not sent to other providers. */
  groqBuiltinTools?: GroqBuiltinTool[];
  /** Enable the server-side allowlisted local tool loop for Groq function-calling models. */
  enableLocalToolCalling?: boolean;
  /** Optional abort signal from the caller/fallback watchdog to cancel stalled requests immediately. */
  signal?: AbortSignal;
}

export interface GenerateResponse {
  text: string;
  modelUsed: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  toolsUsed?: string[];
}

export interface ProviderAdapter {
  readonly provider: ProviderType;
  isAvailable(): boolean;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  /** Optional: stream tokens as they arrive. Falls back to generate() if not implemented. */
  generateStream?(request: GenerateRequest): AsyncGenerator<string, void, unknown>;
}

export abstract class BaseProviderAdapter implements ProviderAdapter {
  abstract readonly provider: ProviderType;
  abstract isAvailable(): boolean;
  abstract generate(request: GenerateRequest): Promise<GenerateResponse>;

  protected normalizeHistory(history?: MessageData[]): MessageData[] {
    if (!history) return [];
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : msg.role,
      content: typeof msg.content === 'string' ? msg.content : msg.content.map(c => c.text).join(''),
    }));
  }

  protected mergeParams(model: ModelConfig, overrides?: Partial<ModelParams>): ModelParams {
    return { ...model.defaultParams, ...overrides };
  }

  protected createResponse(text: string, modelId: string, usage?: { promptTokens: number; completionTokens: number }): GenerateResponse {
    return { text, modelUsed: modelId, usage };
  }

  /**
   * Combine an internal timeout with an optional caller AbortSignal so
   * watchdogs or client disconnects abort in-flight fetch/stream calls cleanly.
   */
  protected createAttemptAbort(externalSignal?: AbortSignal, timeoutMs = 55_000): {
    signal: AbortSignal;
    cleanup: () => void;
  } {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timeoutId);
        externalSignal?.removeEventListener('abort', onExternalAbort);
      },
    };
  }
}
