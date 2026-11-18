/**
 * SOHAM Agent — model-driven tool planning & multi-step execution
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOT the regex intent detector. The MODEL decides which SOHAM tools this
 * user request needs — web search (which already reads the top pages),
 * Wikipedia, playback, charts, image generation, memory extraction, … —
 * using the capability manifest below, then the executor runs the plan and
 * the synthesis model answers from grounded tool output.
 *
 * Flow per message:
 *   user message + short history
 *     → planToolCalls()   (model, strict JSON, ≤6 tools, 10s cap)
 *     → executeAgentPlan() (parallel, per-tool 30s cap, never throws)
 *     → synthesis          (existing streamed generation)
 *
 * Degradation contract: ANY planner failure (no models, bad JSON, timeout)
 * falls back to the legacy regex tool (executeSohamTool). SOHAM_AGENT_DISABLED=1
 * disables the agent entirely (instant rollback lever).
 *
 * Callers that want to act on the plan BEFORE building context (e.g. the
 * image/chart short-circuits in the chat routes) call planToolCalls() once
 * and pass the plan into buildSohamPromptContext({ agentPlan }).
 */

import { z } from 'zod';
import { generateWithSmartFallback } from '../routing/smart-fallback';
import {
  executeSohamTool,
  runToolByName,
  type SohamToolName,
  type SohamToolResult,
  type ConversationTurnLike,
} from '../tools/agent-tools';
import { logger } from '../utils/logger';

// ─── Capability manifest — what SOHAM can do (kept next to the tools) ─────────

export interface CapabilityEntry {
  name: SohamToolName;
  does: string;
  when: string;
}

export const CAPABILITY_MANIFEST: CapabilityEntry[] = [
  { name: 'web_search',     does: 'Search the live web (Tavily/Wikipedia/DDG) and READ the top 3 pages in full', when: 'current events, prices, facts, prices of things, anything that changes or that you are not sure about' },
  { name: 'web_read',       does: 'Read one specific page URL in full', when: 'the user pastes/links a URL or asks about a specific page' },
  { name: 'wikipedia',      does: 'Look up an encyclopedic article (title + extract)', when: 'definitions, history, biographies, well-known facts — quick verified background' },
  { name: 'news_search',    does: 'Latest news on a topic', when: 'breaking news, "latest", "what happened", headlines' },
  { name: 'weather_search', does: 'Live weather & forecast', when: 'temperature, rain, humidity, forecast for a place' },
  { name: 'sports_search',  does: 'Live scores & match updates', when: 'IPL, cricket, football, scores, fixtures, tournaments' },
  { name: 'finance_search', does: 'Stock/crypto/forex/commodity/index prices', when: 'prices of stocks, BTC/ETH, nifty, sensex, gold, usd/inr' },
  { name: 'fact_check',     does: 'Verify a specific claim', when: '"is it true that…", fact-check, verify' },
  { name: 'dictionary',     does: 'Define a word', when: 'define X, meaning of X' },
  { name: 'translate',      does: 'Translate text between languages', when: 'translate X to Y' },
  { name: 'sentiment',      does: 'Analyze tone/sentiment of given text', when: 'sentiment/tone of a review, message, comment' },
  { name: 'grammar',        does: 'Fix grammar & proofread', when: 'fix/correct my English, proofread' },
  { name: 'quiz',           does: 'Generate a quiz/flashcards on a topic', when: 'quiz me, test me on, make flashcards' },
  { name: 'recipe',         does: 'Find a recipe', when: 'how to make/cook X, ingredients for X' },
  { name: 'joke',           does: 'Tell a joke', when: 'joke, pun, roast, riddle' },
  { name: 'play_video',     does: 'Play a video/song on YouTube inside the chat', when: 'play X, watch X — including "play them/it" referring to a previous list' },
  { name: 'chart',          does: 'Draw a deterministic SVG data chart + markdown table', when: 'chart/graph/plot/visualise NUMBERS (real data or well-known published figures)' },
  { name: 'image_generate', does: 'Generate artwork/illustration/poster', when: 'draw me / generate an image / a picture / poster — NEVER for charts or data' },
  { name: 'summarize',      does: 'Summarize a long text', when: 'summarize THIS text (paste), or condense provided content' },
];

export const KNOWN_TOOL_NAMES = new Set<SohamToolName>(CAPABILITY_MANIFEST.map(c => c.name));

// ─── Plan types + validation ──────────────────────────────────────────────────

export interface AgentPlanTool {
  tool: SohamToolName;
  query: string;
  why?: string;
}

export interface AgentPlan {
  tools: AgentPlanTool[];
  /** false when the model judged the turn has nothing durable to remember */
  memoryExtract: boolean;
}

const MAX_TOOLS_PER_PLAN = 6;

const PlanStepSchema = z.object({
  tool: z.string(),
  args: z.union([z.string(), z.object({ query: z.string().optional() }).passthrough()]).optional(),
  query: z.string().optional(),
  why: z.string().optional(),
});

// tools array deliberately uncapped here — normalizePlan slices to the cap,
// so an over-eager model degrades to "first N valid steps", not a total fallback
const PlanSchema = z.object({
  tools: z.array(PlanStepSchema).default([]),
  memory_extract: z.boolean().optional(),
});

function parsePlanJson(raw: string): z.infer<typeof PlanSchema> | null {
  // Strip markdown fences the model may add despite instructions
  let text = raw.trim().replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return PlanSchema.parse(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

/** Normalize a raw parsed plan: known tools only, deduped, capped. */
export function normalizePlan(raw: z.infer<typeof PlanSchema> | null): AgentPlan | null {
  if (!raw) return null;
  const seen = new Set<string>();
  const tools: AgentPlanTool[] = [];
  for (const step of raw.tools) {
    const name = step.tool as SohamToolName;
    if (!KNOWN_TOOL_NAMES.has(name)) continue;
    const query = String(
      (typeof step.args === 'string' ? step.args : step.args?.query) ?? step.query ?? '',
    ).trim().slice(0, 500);
    if (!query) continue;
    const key = `${name}:${query.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tools.push({ tool: name, query, why: step.why?.slice(0, 200) });
    if (tools.length >= MAX_TOOLS_PER_PLAN) break;
  }
  return { tools, memoryExtract: raw.memory_extract !== false };
}

// ─── Planner ──────────────────────────────────────────────────────────────────

/**
 * Planner-worthiness gate — the cheap question "is this message worth a
 * planner round at all?" that the codebase previously never asked (the model
 * was consulted on literally every message, including "hi").
 *
 * Returns FALSE only for pure pleasantries/acknowledgements/goodbyes with no
 * URLs and no digits — the model could not possibly select a tool there.
 * Anything with a URL, a digit, or any non-pleasantry word goes to the
 * planner. Skipping returns the zero-tool plan with memory_extract:false,
 * which is also the correct verdict for those turns.
 */
const PLEASANTRY_PHRASES: readonly string[] = [
  // multi-word first (longest match wins during stripping)
  'how are you doing today', 'how are you doing', 'how are you today', 'how are you',
  'how is it going', "how's it going", "hows it going", 'how are things', 'how you doing',
  'good morning', 'good afternoon', 'good evening', 'good night', 'good day',
  'thank you so much', 'thank you very much', 'thanks so much', 'thanks a lot', 'thank you', 'thanks',
  'see you later', 'see you soon', 'see you around', 'see ya', 'see you', 'bye bye',
  'what is up', "what's up", "whats up", "wassup", 'how do you do',
  'sounds good', 'sure thing', 'got it', 'take care', 'good to see you',
  'you there', 'are you ok', 'are you there',
  // single words
  'hi', 'hii', 'hiii', 'hey', 'heyy', 'hello', 'helloo', 'hiya', 'yo', 'sup',
  'morning', 'afternoon', 'evening',
  'thx', 'ty',
  'ok', 'okay', 'k', 'kk', 'alright', 'all right', 'cool', 'great', 'nice', 'awesome', 'amazing', 'perfect', 'brilliant', 'wonderful', 'good', 'fine',
  'yes', 'yep', 'yeah', 'yup', 'sure', 'no', 'nope', 'nah', 'right',
  'bye', 'goodbye', 'later', 'goodnight', 'night', 'there',
  'who are you', 'what are you', 'test', 'ping',
].sort((a, b) => b.length - a.length);

const PLEASANTRY_RE = new RegExp(
  `\\b(?:${PLEASANTRY_PHRASES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'gi',
);

function escapeRemnant(text: string): string {
  return text.replace(PLEASANTRY_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** True when the message should go through the planner model; false to skip straight to the zero-tool plan. */
export function isPlannerWorthy(message: string): boolean {
  if (!message || !message.trim()) return false;
  if (/https?:\/\//i.test(message)) return true; // URLs → web_read
  const normalized = message.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false; // emoji-only / punctuation-only
  if (/\d/.test(normalized)) return true; // scores, prices, dates, math
  return escapeRemnant(normalized).length > 0;
}

const PLANNER_SYSTEM = `You are SOHAM's tool planner. SOHAM is a Self-Organising Hyper-Adaptive Machine.
Given the user's message and the recent conversation, decide which tools (if any) are needed to answer perfectly.

Return JSON ONLY — no prose:
{"tools":[{"tool":"<name>","args":{"query":"<exact query or the user's phrasing>"},"why":"<short reason>"}],"memory_extract":true|false}

Rules:
- Empty tools [] is CORRECT for greetings, chit-chat, opinions, jokes-without-request, and anything you know confidently.
- Use the FEWEST tools that fully answer. Max ${MAX_TOOLS_PER_PLAN}.
- web_search already READS the top 3 pages — do not add web_read for the same topic. web_read is ONLY for explicit URLs/pages the user wants opened.
- Wikipedia is for quick encyclopedic background; pair it with web_search when freshness matters.
- play_video for any "play"/"watch" request — including "them"/"it", which may reference a previous list.
- chart ONLY for real numbers or well-known published figures. image_generate ONLY for artwork — never for data.
- memory_extract=false ONLY when the turn has nothing durable to remember (greeting, thanks, one-word reply).
- Never invent tool names. Use the exact names from the list.

Available tools:
${CAPABILITY_MANIFEST.map(c => `- ${c.name}: ${c.does} — call when: ${c.when}`).join('\n')}`;

export interface PlannerDeps {
  /** Test seam — defaults to the smart-fallback generator. Returns the model's raw text. */
  generateText?: (args: { prompt: string; systemPrompt: string }) => Promise<string | null>;
}

async function defaultGenerateText(args: { prompt: string; systemPrompt: string }): Promise<string | null> {
  const result = await generateWithSmartFallback({
    prompt: args.prompt,
    systemPrompt: args.systemPrompt,
    history: [],
    params: { temperature: 0, maxOutputTokens: 512 },
    category: 'general',
  });
  return result?.response?.text ?? null;
}

/**
 * Ask the model what this request needs. Returns null on ANY failure —
 * callers must then fall back to the legacy deterministic tool detection.
 */
export async function planToolCalls(
  userMessage: string,
  history: ConversationTurnLike[] = [],
  deps: PlannerDeps = {},
): Promise<AgentPlan | null> {
  const historyBlock = history.slice(-4)
    .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${String(t.content).slice(0, 400)}`)
    .join('\n');

  // Planner-worthiness gate — pure pleasantries skip the model entirely and
  // get the correct verdict for free (no tools, nothing worth remembering).
  if (!isPlannerWorthy(userMessage)) {
    logger.info('[Agent] Planner skipped — trivial pleasantry, no tools needed');
    return { tools: [], memoryExtract: false };
  }
  const prompt =
    (historyBlock ? `Recent conversation:\n${historyBlock}\n\n` : '') +
    `User's message: ${userMessage.slice(0, 2000)}\n\nPlan the tools (JSON only):`;

  let plannerTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const generateText = deps.generateText ?? defaultGenerateText;
    const raw = await Promise.race([
      generateText({ prompt, systemPrompt: PLANNER_SYSTEM }),
      new Promise<null>(resolve => { plannerTimer = setTimeout(() => resolve(null), 10_000); }),
    ]);
    if (!raw) { logger.warn('[Agent] Planner timed out or returned nothing'); return null; }
    const plan = normalizePlan(parsePlanJson(raw));
    if (!plan) logger.warn('[Agent] Planner returned unparseable plan', { raw: raw.slice(0, 200) });
    return plan;
  } catch (err) {
    logger.warn('[Agent] Planner failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    if (plannerTimer) clearTimeout(plannerTimer);
  }
}

// ─── Executor ─────────────────────────────────────────────────────────────────

export type ToolRunner = (query: string, ctx: ToolRunContext) => Promise<SohamToolResult>;

export interface ToolRunContext {
  history: ConversationTurnLike[];
  userId?: string;
}

const TOOL_TIMEOUT_MS = 30_000;
const RESULT_OUTPUT_CAP = 2_200;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

export const DEFAULT_RUNNERS: Record<SohamToolName, ToolRunner> = Object.fromEntries(
  CAPABILITY_MANIFEST.map(({ name }) => [name, (query: string, ctx: ToolRunContext) => runToolByName(name, query, ctx.history)]),
) as Record<SohamToolName, ToolRunner>;

/**
 * Run a plan in parallel. Never throws — every step resolves to a
 * SohamToolResult (ok:false on error/timeout). Output capped per step.
 */
export async function executeAgentPlan(
  plan: AgentPlan,
  ctx: ToolRunContext,
  opts: { runners?: Partial<Record<SohamToolName, ToolRunner>>; timeoutMs?: number } = {},
): Promise<SohamToolResult[]> {
  const timeoutMs = opts.timeoutMs ?? TOOL_TIMEOUT_MS;
  const steps = plan.tools.slice(0, MAX_TOOLS_PER_PLAN);
  const settled = await Promise.allSettled(steps.map(step => {
    const runner = opts.runners?.[step.tool] ?? DEFAULT_RUNNERS[step.tool];
    return withTimeout(
      runner(step.query, ctx),
      timeoutMs,
      { tool: step.tool, query: step.query, ok: false, output: `${step.tool} timed out.` } as SohamToolResult,
    );
  }));
  return settled.map((r, i) => {
    const tool = steps[i].tool;
    if (r.status === 'fulfilled') return { ...r.value, output: r.value.output.slice(0, RESULT_OUTPUT_CAP) };
    return { tool, query: steps[i].query, ok: false, output: `${tool} failed: ${String(r.reason)}` };
  });
}

export interface AgentRunResult {
  results: SohamToolResult[];
  plannedBy: 'model' | 'fallback';
  plannedTools: string[];
  memoryExtract: boolean;
}

/** Ops kill-switch: SOHAM_AGENT_DISABLED=1 bypasses the model planner entirely. */
export function isSohamAgentDisabled(): boolean {
  return process.env.SOHAM_AGENT_DISABLED === '1';
}

/**
 * Plan + execute. Pass `opts.plan` when the caller already planned (e.g. to
 * inspect short-circuits first) — otherwise planning happens here.
 */
export async function runSohamAgent(
  userMessage: string,
  history: ConversationTurnLike[] = [],
  opts: { plan?: AgentPlan | null; deps?: PlannerDeps; userId?: string; runners?: Partial<Record<SohamToolName, ToolRunner>> } = {},
): Promise<AgentRunResult> {
  if (isSohamAgentDisabled()) {
    const legacy = await executeSohamTool(userMessage, history).catch(() => null);
    return { results: legacy ? [legacy] : [], plannedBy: 'fallback', plannedTools: legacy ? [legacy.tool] : [], memoryExtract: true };
  }

  const plan = opts.plan !== undefined ? opts.plan : await planToolCalls(userMessage, history, opts.deps);

  if (!plan) {
    // Legacy safety net — the pre-agent behavior, unchanged
    const legacy = await executeSohamTool(userMessage, history).catch(() => null);
    return { results: legacy ? [legacy] : [], plannedBy: 'fallback', plannedTools: legacy ? [legacy.tool] : [], memoryExtract: true };
  }

  if (plan.tools.length === 0) {
    return { results: [], plannedBy: 'model', plannedTools: [], memoryExtract: plan.memoryExtract };
  }

  const results = await executeAgentPlan(plan, { history, userId: opts.userId }, { runners: opts.runners });
  return {
    results,
    plannedBy: 'model',
    plannedTools: plan.tools.map(t => t.tool),
    memoryExtract: plan.memoryExtract,
  };
}
