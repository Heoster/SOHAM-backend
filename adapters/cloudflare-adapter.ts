/** Cloudflare Workers AI adapter using its OpenAI-compatible chat endpoint. */
import { BaseProviderAdapter, type GenerateRequest, type GenerateResponse, type MessageData } from './types';
import { createUserFriendlyError } from '../routing/model-config';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; delta?: { content?: string } }>;
  error?: { message?: string };
  success?: boolean;
  errors?: Array<{ message?: string }>;
}

export class CloudflareAdapter extends BaseProviderAdapter {
  readonly provider = 'cloudflare' as const;
  private readonly endpoint = 'https://api.cloudflare.com/client/v4/accounts';

  isAvailable(): boolean {
    return process.env.ENABLE_CLOUDFLARE_TEXT_AI === 'true'
      && Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_API_TOKEN);
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const response = await this.request(request, false);
    const data = await response.json() as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!response.ok || !content) {
      throw createUserFriendlyError(new Error(this.errorMessage(data, response.status)), 'cloudflare', request.model.id);
    }
    return this.createResponse(content, request.model.id);
  }

  async *generateStream(request: GenerateRequest): AsyncGenerator<string, void, unknown> {
    const response = await this.request(request, true);
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      throw createUserFriendlyError(new Error(`Cloudflare HTTP ${response.status}: ${body}`), 'cloudflare', request.model.id);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') return;
          try {
            const chunk = JSON.parse(data) as ChatCompletionResponse;
            const token = chunk.choices?.[0]?.delta?.content;
            if (token) yield token;
            if (chunk.error?.message) {
              throw createUserFriendlyError(new Error(chunk.error.message), 'cloudflare', request.model.id);
            }
          } catch (error) {
            if (error instanceof SyntaxError) continue;
            throw error;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async request(request: GenerateRequest, stream: boolean): Promise<Response> {
    if (process.env.ENABLE_CLOUDFLARE_TEXT_AI !== 'true') {
      throw createUserFriendlyError(new Error('Cloudflare Workers AI text is disabled; set ENABLE_CLOUDFLARE_TEXT_AI=true to opt in'), 'cloudflare', request.model.id);
    }
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_AI_API_TOKEN;
    if (!accountId || !apiToken) {
      throw createUserFriendlyError(new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_API_TOKEN are required'), 'cloudflare', request.model.id);
    }

    const { model, prompt, systemPrompt, history, params } = request;
    const merged = this.mergeParams(model, params);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);
    try {
      const gatewayId = process.env.CLOUDFLARE_AI_GATEWAY_ID?.trim();
      return await fetch(`${this.endpoint}/${encodeURIComponent(accountId)}/ai/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          ...(gatewayId ? { 'cf-aig-gateway-id': gatewayId } : {}),
        },
        body: JSON.stringify({
          model: model.modelId,
          messages: this.buildMessages(prompt, systemPrompt, history),
          temperature: merged.temperature,
          top_p: merged.topP,
          max_tokens: merged.maxOutputTokens,
          stream,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw createUserFriendlyError(new Error('Cloudflare request timeout'), 'cloudflare', model.id);
      }
      throw createUserFriendlyError(error, 'cloudflare', model.id);
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildMessages(prompt: string, systemPrompt?: string, history?: MessageData[]) {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    for (const item of history ?? []) {
      messages.push({
        role: item.role === 'user' ? 'user' : 'assistant',
        content: typeof item.content === 'string' ? item.content : item.content.map(part => part.text).join(''),
      });
    }
    messages.push({ role: 'user', content: prompt });
    return messages;
  }

  private errorMessage(data: ChatCompletionResponse, status: number): string {
    return `Cloudflare HTTP ${status}: ${data.error?.message ?? data.errors?.map(e => e.message).filter(Boolean).join('; ') ?? 'empty model response'}`;
  }
}

let instance: CloudflareAdapter | null = null;
export function getCloudflareAdapter(): CloudflareAdapter {
  if (!instance) instance = new CloudflareAdapter();
  return instance;
}
