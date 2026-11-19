/**
 * Detect raw action-JSON a weak free model emitted instead of answering.
 *
 * Production example (openrouter-free-router, 2026-11-19): asked "is merrut a
 * metro city", the model replied with only
 *
 *   { "action": "web_search", "query": "Is Meerut a metro city in India" }
 *
 * — its internal ReAct-style tool call, printed verbatim into the chat. The
 * backend executes tools BEFORE the model writes its answer, so this text is
 * never a valid reply. This module parses it so the routes can (a) run the
 * requested tool for real, (b) re-ask the model with the result, and
 * (c) never show the user the raw JSON.
 */

export type RescueTool =
  | 'web_search' | 'web_read' | 'wikipedia' | 'news_search' | 'weather_search'
  | 'sports_search' | 'finance_search' | 'fact_check' | 'dictionary';

export interface ActionRequest {
  tool: RescueTool;
  query: string;
}

const TOOL_NAMES = new Set<RescueTool>([
  'web_search', 'web_read', 'wikipedia', 'news_search', 'weather_search',
  'sports_search', 'finance_search', 'fact_check', 'dictionary',
]);

// Small models improvise tool names — map the obvious ones onto real tools.
const ALIASES: Record<string, RescueTool> = {
  search: 'web_search', websearch: 'web_search', web: 'web_search', google: 'web_search',
  internet_search: 'web_search', web_search_tool: 'web_search', browser: 'web_search',
  news: 'news_search', news_search_tool: 'news_search', latest_news: 'news_search',
  weather: 'weather_search', weather_search_tool: 'weather_search',
  sports: 'sports_search', scores: 'sports_search',
  finance: 'finance_search', stock: 'finance_search', stocks: 'finance_search', crypto: 'finance_search',
  wiki: 'wikipedia', wiki_search: 'wikipedia', encyclopedia: 'wikipedia',
  factcheck: 'fact_check', fact_check_tool: 'fact_check', verify: 'fact_check',
  define: 'dictionary', dict: 'dictionary', definition: 'dictionary',
  url: 'web_read', read_url: 'web_read', read_page: 'web_read', open_url: 'web_read',
};

/**
 * Strict WHOLE-output match: optional code fence, one flat JSON object with an
 * action/tool/name string plus a query/input/args. Returns null for anything
 * else — prose, partial JSON, non-flat objects, non-text tools (image/chart/
 * play have their own server-side short-circuits and no text-answer rescue).
 */
export function parseActionJson(text: string): ActionRequest | null {
  if (!text) return null;
  let t = text.trim();

  // Strip a wrapping code fence: ```json … ``` or ``` … ```
  const fence = t.match(/^```[a-z]*\s*\n?([\s\S]*?)\n?\s*```$/i);
  if (fence) t = fence[1].trim();

  if (!t.startsWith('{') || !t.endsWith('}')) return null;

  let parsed: unknown;
  try { parsed = JSON.parse(t); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const pick = (k: string): string => {
    const v = obj[k];
    return typeof v === 'string' ? v.trim().toLowerCase() : '';
  };
  const action = pick('action') || pick('tool') || pick('name') || pick('function');
  if (!action) return null;

  let tool = TOOL_NAMES.has(action as RescueTool) ? (action as RescueTool) : ALIASES[action];
  if (!tool) return null;

  // query can be a top-level string, or args/arguments as an object/array/string
  let query = '';
  const direct = obj.query ?? obj.input ?? obj.q ?? obj.search;
  if (typeof direct === 'string') query = direct.trim();
  else {
    const nested = (obj.args ?? obj.arguments ?? obj.parameters ?? obj.params) as unknown;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const nq = (nested as Record<string, unknown>).query ?? (nested as Record<string, unknown>).q ?? (nested as Record<string, unknown>).search;
      if (typeof nq === 'string') query = nq.trim();
    } else if (typeof nested === 'string') {
      query = nested.trim();
    }
  }
  if (!query) return null;
  if (query.length > 500) query = query.slice(0, 500);

  return { tool, query };
}
