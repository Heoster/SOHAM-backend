import type { GroqBuiltinTool } from '../adapters/types';

export interface GroqToolOptions {
  groqBuiltinTools?: GroqBuiltinTool[];
  enableLocalToolCalling?: boolean;
}

const BUILTIN_TOOLS = new Set<GroqBuiltinTool>(['browser_search', 'code_interpreter']);

/** Validate the small, explicit client-facing Groq tool allowlist. */
export function parseGroqToolOptions(settings: unknown): GroqToolOptions {
  if (!settings || typeof settings !== 'object') return {};
  const values = settings as Record<string, unknown>;
  const rawTools = values.groqBuiltinTools;
  if (rawTools !== undefined && !Array.isArray(rawTools)) {
    throw new Error('settings.groqBuiltinTools must be an array of browser_search/code_interpreter');
  }
  const selected = [...new Set((rawTools as unknown[] | undefined) ?? [])];
  if (selected.some(tool => typeof tool !== 'string' || !BUILTIN_TOOLS.has(tool as GroqBuiltinTool))) {
    throw new Error('Supported Groq built-in tools are browser_search and code_interpreter');
  }
  if (selected.length > 2) throw new Error('At most two Groq built-in tools may be enabled');

  return {
    ...(selected.length > 0 && { groqBuiltinTools: selected as GroqBuiltinTool[] }),
    ...(values.enableLocalToolCalling === true && { enableLocalToolCalling: true }),
  };
}
