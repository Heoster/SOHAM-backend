/**
 * Groq Provider Adapter
 * Implements Groq chat completions, built-in tools, and an allowlisted local function loop.
 * Calls are disabled unless GROQ_FREE_PLAN_ONLY confirms a $0 Free-plan account.
 */

import { BaseProviderAdapter, type GenerateRequest, type GenerateResponse, type MessageData, type GroqBuiltinTool } from './types';
import { executeSohamTool } from '../tools/agent-tools';
import { createUserFriendlyError } from '../routing/model-config';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

interface GroqToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface GroqMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: GroqToolCall[];
  executed_tools?: Array<string | { type?: string; name?: string }>;
}

interface GroqResponse {
  choices: Array<{
    message: GroqMessage;
    finish_reason: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: {
    message: string;
    type: string;
  };
}

const MAX_LOCAL_TOOL_ROUNDS = 3;
const GPT_OSS_MODELS = new Set(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
const LOCAL_TOOL_MODELS = new Set([...GPT_OSS_MODELS, 'qwen/qwen3.8-27b']);
const LOCAL_FUNCTION_TOOLS = [
  { type: 'function', function: { name: 'search_web', description: 'Search the web for current information.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'A concise web search query.' } }, required: ['query'], additionalProperties: false } } },
  { type: 'function', function: { name: 'search_news', description: 'Search recent news articles using the configured news providers, including GNews.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'A concise news query.' } }, required: ['query'], additionalProperties: false } } },
  { type: 'function', function: { name: 'get_weather', description: 'Get current weather or forecast information.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'A city or weather question.' } }, required: ['query'], additionalProperties: false } } },
  { type: 'function', function: { name: 'search_sports', description: 'Look up current sports and cricket scores or match information.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'A team, match, or sports query.' } }, required: ['query'], additionalProperties: false } } },
  { type: 'function', function: { name: 'search_finance', description: 'Look up financial, stock, or cryptocurrency information.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'A stock, ticker, crypto, or finance query.' } }, required: ['query'], additionalProperties: false } } },
] as const;

const LOCAL_TOOL_COMMANDS: Record<string, string> = {
  search_web: 'search',
  search_news: 'news',
  get_weather: 'weather',
  search_sports: 'sports',
  search_finance: 'finance',
};

function builtInToolPayload(tools: GroqBuiltinTool[]): Array<{ type: GroqBuiltinTool }> {
  return tools.map(type => ({ type }));
}

interface GroqStreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
}

export class GroqAdapter extends BaseProviderAdapter {
  readonly provider = 'groq' as const;
  
  isAvailable(): boolean {
    return process.env.GROQ_FREE_PLAN_ONLY === 'true' && !!process.env.GROQ_API_KEY;
  }
  
  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const { model, prompt, systemPrompt, history, params } = request;
    const mergedParams = this.mergeParams(model, params);
    const apiKey = process.env.GROQ_API_KEY;
    if (process.env.GROQ_FREE_PLAN_ONLY !== 'true') {
      throw createUserFriendlyError(new Error('Groq inference is disabled unless GROQ_FREE_PLAN_ONLY=true confirms a $0 Free-plan account'), 'groq', model.id);
    }
    if (!apiKey) throw createUserFriendlyError(new Error('GROQ_API_KEY not configured'), 'groq', model.id);

    const builtinTools = request.groqBuiltinTools ?? [];
    if (builtinTools.length > 0 && !GPT_OSS_MODELS.has(model.modelId)) {
      throw createUserFriendlyError(new Error('Groq browser_search/code_interpreter built-ins require a GPT-OSS model'), 'groq', model.id);
    }
    const localToolsEnabled = request.enableLocalToolCalling === true;
    if (localToolsEnabled && !LOCAL_TOOL_MODELS.has(model.modelId)) {
      throw createUserFriendlyError(new Error('Local function calling requires Groq GPT-OSS or Qwen 3.8 27B'), 'groq', model.id);
    }
    const tools = [
      ...builtInToolPayload(builtinTools),
      ...(localToolsEnabled ? LOCAL_FUNCTION_TOOLS : []),
    ];
    const messages = this.buildMessages(prompt, systemPrompt, history);
    const toolsUsed = new Set<string>();

    try {
      for (let round = 0; round <= MAX_LOCAL_TOOL_ROUNDS; round++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        let response: Response;
        try {
          response = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: model.modelId,
              messages,
              temperature: mergedParams.temperature,
              top_p: mergedParams.topP,
              max_completion_tokens: mergedParams.maxOutputTokens,
              ...(tools.length > 0 && { tools, tool_choice: 'auto' }),
              stream: false,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw createUserFriendlyError(new Error(`Groq API error ${response.status}: ${errorText.slice(0, 400)}`), 'groq', model.id);
        }
        const data = await response.json() as GroqResponse;
        if (data.error) throw createUserFriendlyError(new Error(data.error.message), 'groq', model.id);
        const choice = data.choices?.[0];
        if (!choice?.message) throw createUserFriendlyError(new Error('No response generated'), 'groq', model.id);

        for (const executed of choice.message.executed_tools ?? []) {
          const name = typeof executed === 'string' ? executed : executed.type ?? executed.name;
          if (name) toolsUsed.add(name);
        }

        const calls = choice.message.tool_calls ?? [];
        if (calls.length > 0) {
          if (!localToolsEnabled) {
            throw createUserFriendlyError(new Error('Model requested local functions, but enableLocalToolCalling was not enabled'), 'groq', model.id);
          }
          if (round === MAX_LOCAL_TOOL_ROUNDS) {
            throw createUserFriendlyError(new Error('Groq tool-calling turn limit reached'), 'groq', model.id);
          }
          messages.push({ role: 'assistant', content: choice.message.content, tool_calls: calls });
          const results = await Promise.all(calls.map(async call => {
            const command = LOCAL_TOOL_COMMANDS[call.function.name];
            if (!command) throw createUserFriendlyError(new Error(`Tool is not allowed: ${call.function.name}`), 'groq', model.id);
            let args: unknown;
            try { args = JSON.parse(call.function.arguments || '{}'); }
            catch { throw createUserFriendlyError(new Error(`Invalid JSON arguments for ${call.function.name}`), 'groq', model.id); }
            const query = args && typeof args === 'object' && 'query' in args
              ? String((args as { query: unknown }).query).trim().slice(0, 240)
              : '';
            if (!query) throw createUserFriendlyError(new Error(`A non-empty query is required for ${call.function.name}`), 'groq', model.id);
            const result = await executeSohamTool(`/${command} ${query}`);
            toolsUsed.add(call.function.name);
            const content = result
              ? JSON.stringify({ ok: result.ok, output: result.output.slice(0, 6000), sources: result.sources ?? [] })
              : JSON.stringify({ ok: false, output: 'Tool did not return a result.' });
            return { role: 'tool' as const, tool_call_id: call.id, name: call.function.name, content };
          }));
          messages.push(...results);
          continue;
        }

        const text = choice.message.content?.trim();
        if (!text) throw createUserFriendlyError(new Error('No response generated'), 'groq', model.id);
        return {
          text,
          modelUsed: model.id,
          ...(data.usage && { usage: { promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0 } }),
          ...(toolsUsed.size > 0 && { toolsUsed: [...toolsUsed] }),
        };
      }
      throw createUserFriendlyError(new Error('Groq tool-calling loop ended without a final response'), 'groq', model.id);
    } catch (error) {
      if (error instanceof Error && error.name === 'AIServiceError') throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw createUserFriendlyError(new Error('Groq request timed out'), 'groq', model.id);
      }
      throw createUserFriendlyError(error, 'groq', model.id);
    }
  }

  /**
   * Stream tokens from Groq using SSE (OpenAI-compatible stream=true)
   */
  async *generateStream(request: GenerateRequest): AsyncGenerator<string, void, unknown> {
    if (request.enableLocalToolCalling || request.groqBuiltinTools?.length) {
      const response = await this.generate(request);
      yield response.text;
      return;
    }
    if (process.env.GROQ_FREE_PLAN_ONLY !== 'true') {
      throw createUserFriendlyError(new Error('Groq inference is disabled unless GROQ_FREE_PLAN_ONLY=true confirms a $0 Free-plan account'), 'groq', request.model.id);
    }
    const { model, prompt, systemPrompt, history, params } = request;
    const mergedParams = this.mergeParams(model, params);

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw createUserFriendlyError(new Error('GROQ_API_KEY not configured'), 'groq', model.id);

    const messages = this.buildMessages(prompt, systemPrompt, history);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55000);

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model.modelId,
        messages,
        temperature: mergedParams.temperature,
        top_p: mergedParams.topP,
        max_completion_tokens: mergedParams.maxOutputTokens,
        stream: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => '');
      throw createUserFriendlyError(new Error(`API error: ${response.status} - ${errorText}`), 'groq', model.id);
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
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;
          let chunk: GroqStreamChunk;
          try {
            chunk = JSON.parse(data) as GroqStreamChunk;
          } catch {
            continue;
          }
          if (chunk.error?.message) {
            throw createUserFriendlyError(new Error(chunk.error.message), 'groq', model.id);
          }
          const token = chunk.choices?.[0]?.delta?.content;
          if (token) yield token;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Build messages array for OpenAI-compatible format
   */
  private buildMessages(prompt: string, systemPrompt?: string, history?: MessageData[]): GroqMessage[] {
    const messages: GroqMessage[] = [];
    
    // Add system prompt if provided
    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt,
      });
    }
    
    // Add conversation history
    if (history && history.length > 0) {
      for (const msg of history) {
        const content = typeof msg.content === 'string' 
          ? msg.content 
          : msg.content.map(c => c.text).join('');
        
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content,
        });
      }
    }
    
    // Add current user message
    messages.push({
      role: 'user',
      content: prompt,
    });
    
    return messages;
  }
  
  /**
   * Check if error indicates critical Groq failure
   */
  private isCriticalFailure(error: unknown): boolean {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    return (
      errorMessage.includes('service unavailable') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('rate limit') ||
      errorMessage.includes('overloaded') ||
      errorMessage.includes('503') ||
      errorMessage.includes('502') ||
      errorMessage.includes('504')
    );
  }
}

// Singleton instance
let instance: GroqAdapter | null = null;

export function getGroqAdapter(): GroqAdapter {
  if (!instance) {
    instance = new GroqAdapter();
  }
  return instance;
}