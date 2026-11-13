/**
 * Model Configuration Types and Schema
 * Defines the structure for AI model configurations across multiple providers
 */

import { z } from 'zod';

// Model category types
export type ModelCategory = 'general' | 'coding' | 'math' | 'conversation' | 'multimodal';

// Provider types - Only working providers
export type ProviderType = 'groq' | 'google' | 'openrouter' | 'cloudflare' | 'elevenlabs';

// Model parameters interface
export interface ModelParams {
  temperature: number;
  topP: number;
  topK?: number;
  maxOutputTokens: number;
}

// Model configuration interface
export interface ModelConfig {
  id: string;
  name: string;
  provider: ProviderType;
  modelId: string;
  category: ModelCategory;
  description: string;
  contextWindow: number;
  supportsStreaming: boolean;
  maxOutputTokens?: number;
  defaultParams: ModelParams;
  enabled: boolean;
  /** Higher = preferred in auto-routing. Used to rank models within a category. */
  priority?: number;
  lifecycle?: {
    status: 'ACTIVE' | 'DEAD' | 'DEPRECATED';
    deprecationDate?: string;
    replacementModelId?: string;
  };
  capabilities?: Array<{
    type: 'TEXT' | 'VISION' | 'AUDIO_IN' | 'AUDIO_OUT' | 'IMAGE_GEN' | 'VIDEO_GEN';
    supportedFormats?: string[];
  }>;
  rateLimit?: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
}

// Provider configuration interface
export interface ProviderConfig {
  type: ProviderType;
  apiKeyEnvVar: string;
  baseUrl?: string;
  enabled: boolean;
}

// Full configuration store interface
export interface ModelsConfigStore {
  providers: Record<string, ProviderConfig>;
  models: ModelConfig[];
}

// Zod schemas for validation
export const ModelCategorySchema = z.enum(['general', 'coding', 'math', 'conversation', 'multimodal']);

export const ProviderTypeSchema = z.enum(['groq', 'google', 'openrouter', 'cloudflare', 'elevenlabs']);

export const ModelParamsSchema = z.object({
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  topK: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive(),
});

export const ModelConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional().default(''),
  provider: ProviderTypeSchema,
  modelId: z.string().min(1),
  category: ModelCategorySchema,
  description: z.string().optional().default(''),
  contextWindow: z.number().int().nonnegative(),
  supportsStreaming: z.boolean(),
  maxOutputTokens: z.number().int().nonnegative().optional(),
  defaultParams: ModelParamsSchema,
  enabled: z.boolean(),
  priority: z.number().optional(),
  lifecycle: z.object({
    status: z.enum(['ACTIVE', 'DEAD', 'DEPRECATED']),
    deprecationDate: z.string().optional(),
    replacementModelId: z.string().optional(),
  }).optional(),
  capabilities: z.array(z.object({
    type: z.enum(['TEXT', 'VISION', 'AUDIO_IN', 'AUDIO_OUT', 'IMAGE_GEN', 'VIDEO_GEN']),
    supportedFormats: z.array(z.string()).optional(),
  })).optional(),
  rateLimit: z.object({
    requestsPerMinute: z.number(),
    requestsPerDay: z.number(),
  }).optional(),
});

export const ProviderConfigSchema = z.object({
  type: ProviderTypeSchema,
  apiKeyEnvVar: z.string().min(1),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean(),
});

export const ModelsConfigStoreSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema),
  models: z.array(ModelConfigSchema),
});

// Validation functions
export function validateModelConfig(config: unknown): ModelConfig {
  return ModelConfigSchema.parse(config) as ModelConfig;
}

export function validateProviderConfig(config: unknown): ProviderConfig {
  return ProviderConfigSchema.parse(config) as ProviderConfig;
}

export function validateModelsConfigStore(config: unknown): ModelsConfigStore {
  return ModelsConfigStoreSchema.parse(config) as ModelsConfigStore;
}

// Serialization functions
export function serializeModelConfig(config: ModelConfig): string {
  return JSON.stringify(config);
}

export function parseModelConfig(json: string): ModelConfig {
  const parsed = JSON.parse(json);
  return validateModelConfig(parsed);
}

export function serializeModelsConfigStore(store: ModelsConfigStore): string {
  return JSON.stringify(store, null, 2);
}

export function parseModelsConfigStore(json: string): ModelsConfigStore {
  const parsed = JSON.parse(json);
  return validateModelsConfigStore(parsed);
}

// AI Error types for standardized error handling
export type AIErrorCode = 
  | 'AUTH_ERROR' 
  | 'RATE_LIMIT' 
  | 'NETWORK_ERROR' 
  | 'INVALID_RESPONSE' 
  | 'MODEL_UNAVAILABLE';

export interface AIError {
  code: AIErrorCode;
  message: string;
  provider?: ProviderType;
  modelId?: string;
  retryable: boolean;
}

export class AIServiceError extends Error {
  public readonly code: AIErrorCode;
  public readonly provider?: ProviderType;
  public readonly modelId?: string;
  public readonly retryable: boolean;
  public readonly diagnostic: string;

  constructor(error: AIError) {
    super(error.message);
    this.name = 'AIServiceError';
    this.code = error.code;
    this.provider = error.provider;
    this.modelId = error.modelId;
    this.retryable = error.retryable;
    this.diagnostic = error.message;
  }

  toJSON(): AIError {
    return {
      code: this.code,
      message: this.message,
      provider: this.provider,
      modelId: this.modelId,
      retryable: this.retryable,
    };
  }
}

// Helper to create user-friendly error messages
export function createUserFriendlyError(error: unknown, provider?: ProviderType, modelId?: string): AIServiceError {
  const detail = error instanceof Error ? error.message : String(error);
  const message = detail.toLowerCase();
  const status = Number(message.match(/(?:http(?: status)?|status|error)\s*[:=]?\s*(\d{3})/i)?.[1] ?? 0);
  let code: AIErrorCode = 'INVALID_RESPONSE';
  let userMessage = 'An unexpected error occurred. Please try again.';
  let retryable = true;

  if (status === 401 || status === 403 || /api key not configured|authentication failed|unauthorized|invalid api key/.test(message)) {
    code = 'AUTH_ERROR';
    userMessage = `Authentication failed for ${provider ?? 'AI provider'}. Check the configured API credentials.`;
    retryable = false;
  } else if (status === 429 || /rate.?limit|quota|too many requests|resource exhausted/.test(message)) {
    code = 'RATE_LIMIT';
    userMessage = `${provider ?? 'AI provider'} is rate limited. Trying another provider.`;
  } else if (status === 404 || /model.{0,40}(not found|unavailable|does not exist)|no endpoints found|selected model.{0,40}unavailable/.test(message)) {
    code = 'MODEL_UNAVAILABLE';
    userMessage = `${provider ?? 'AI provider'} model ${modelId ?? ''} is unavailable. Trying another model.`.trim();
  } else if (status === 408 || status >= 500 || /network|fetch failed|econnrefused|etimedout|timeout|temporarily unavailable|overloaded|service unavailable/.test(message)) {
    code = 'NETWORK_ERROR';
    userMessage = `${provider ?? 'AI provider'} is temporarily unreachable. Trying another provider.`;
  } else if (status >= 400) {
    code = 'INVALID_RESPONSE';
    userMessage = `${provider ?? 'AI provider'} rejected the request (HTTP ${status}). Check model settings and request limits.`;
  }

  const result = new AIServiceError({ code, message: userMessage, provider, modelId, retryable });
  // Keep provider diagnostics for server logs while keeping the client-facing message safe.
  Object.defineProperty(result, 'diagnostic', { value: detail.slice(0, 500), enumerable: false });
  return result;
}
