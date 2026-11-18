/**
 * SOHAM Agent — planner/executor regression checks (offline).
 * Run: node -r ts-node/register/transpile-only scripts/test-agent.ts
 */
import assert from 'node:assert/strict';
import {
  CAPABILITY_MANIFEST,
  KNOWN_TOOL_NAMES,
  DEFAULT_RUNNERS,
  normalizePlan,
  planToolCalls,
  executeAgentPlan,
  runSohamAgent,
  type AgentPlan,
} from '../core/soham-agent';
import { runToolByName, type SohamToolResult } from '../tools/agent-tools';

async function main() {
  // ── 1) Manifest integrity ────────────────────────────────────────────────────
  const names = CAPABILITY_MANIFEST.map(c => c.name);
  assert.equal(new Set(names).size, names.length, 'manifest tool names must be unique');
  for (const name of KNOWN_TOOL_NAMES) {
    assert.equal(typeof DEFAULT_RUNNERS[name], 'function', `missing runner for ${name}`);
  }
  for (const name of Object.keys(DEFAULT_RUNNERS)) {
    assert.ok(KNOWN_TOOL_NAMES.has(name as any), `runner exists for unknown tool ${name}`);
  }
  console.log(`manifest ok — ${names.length} tools, all dispatchable`);

  // ── 2) normalizePlan: fences stripped, unknown tools dropped, dedupe, cap ────
  const messy = normalizePlan({
    tools: [
      { tool: 'web_search', args: { query: 'latest ipl score' }, why: 'live match' },
      { tool: 'not_a_tool', args: { query: 'x' } },
      { tool: 'weather', args: { query: 'weather in delhi' } },   // unknown name → dropped
      { tool: 'WEATHER_SEARCH', args: { query: 'weather in delhi' } }, // case mismatch → dropped
      { tool: 'web_search', args: { query: 'latest ipl score' } },  // duplicate → dropped
      { tool: 'play_video', args: 'despacito' },                   // bare string args → ok
      { tool: 'joke', args: {} },                                   // no query → dropped
    ] as any,
    memory_extract: false,
  } as any);
  assert.ok(messy);
  assert.deepEqual(messy!.tools.map(t => t.tool), ['web_search', 'play_video']);
  assert.equal(messy!.memoryExtract, false);
  console.log('normalizePlan ok — unknown dropped, deduped, flags parsed');

  // Over-long plan (7 steps) → first 6 kept, no throw
  const longPlan = normalizePlan({
    tools: Array.from({ length: 7 }, (_, i) => ({ tool: 'joke', args: { query: `topic ${i}` } })),
  } as any);
  assert.equal(longPlan!.tools.length, 6);
  console.log('normalizePlan ok — 7-step plan truncated to 6');

  // ── 3) Planner: model JSON (fenced, with prose) → plan ──────────────────────
  const fenced = await planToolCalls('latest ipl score and weather in Delhi', [], {
    generateText: async () => 'Sure! Here is my plan:\n```json\n{"tools":[{"tool":"sports_search","args":{"query":"IPL latest score"}},{"tool":"weather_search","args":{"query":"weather in Delhi"}}],"memory_extract":true}\n```',
  });
  assert.deepEqual(fenced!.tools.map(t => t.tool), ['sports_search', 'weather_search']);
  assert.equal(fenced!.memoryExtract, true);
  console.log('planner ok — fenced JSON with prose parsed');

  // Garbage / empty / throwing generator → null (caller falls back)
  assert.equal(await planToolCalls('hi', [], { generateText: async () => 'not json at all' }), null);
  assert.equal(await planToolCalls('hi', [], { generateText: async () => '' }), null);
  assert.equal(await planToolCalls('hi', [], { generateText: async () => { throw new Error('no models'); } }), null);
  console.log('planner ok — garbage/failure → null fallback');

  // Greeting with zero-tool plan → empty results, still model-planned
  const chitchat = await planToolCalls('hey soham, good morning', [], {
    generateText: async () => '{"tools":[],"memory_extract":false}',
  });
  assert.deepEqual(chitchat!.tools, []);
  assert.equal(chitchat!.memoryExtract, false);
  console.log('planner ok — empty plan honoured');

  // ── 4) Executor: parallel, timeouts, failures isolated, output capped ────────
  const runners = {
    web_search: async () => ({ tool: 'web_search', query: 'q', ok: true, output: 'x'.repeat(5000) }) as SohamToolResult,
    joke: async () => { throw new Error('boom'); },
    weather_search: async () => new Promise<SohamToolResult>(() => {}), // never resolves
  };
  const executed = await executeAgentPlan(
    { tools: [
      { tool: 'web_search', query: 'q' },
      { tool: 'joke', query: 'q' },
      { tool: 'weather_search', query: 'q' },
    ], memoryExtract: true },
    { history: [] },
    { runners: runners as any, timeoutMs: 100 },
  );
  assert.equal(executed.length, 3);
  assert.equal(executed[0].ok, true);
  assert.ok(executed[0].output.length <= 2200, 'output must be capped at 2200 chars');
  assert.equal(executed[1].ok, false);
  assert.match(executed[1].output, /boom/);
  assert.equal(executed[2].ok, false);
  assert.match(executed[2].output, /timed out/);
  console.log('executor ok — isolation, timeout, output cap');

  // ── 5) runSohamAgent: model plan end-to-end (stubbed model + stubbed runner) ─
  const run = await runSohamAgent('play despacito', [], {
    deps: { generateText: async () => '{"tools":[{"tool":"play_video","args":{"query":"despacito"}}]}' },
    runners: {
      play_video: async (q: string) => ({ tool: 'play_video', query: q, ok: true, output: `ANTIJALII resolved: ${q}` }),
    },
  });
  assert.equal(run.plannedBy, 'model');
  assert.deepEqual(run.plannedTools, ['play_video']);
  assert.equal(run.results[0].output.includes('despacito'), true);
  console.log('runSohamAgent ok — model-planned path');

  // Planner failure → legacy regex fallback. Stub fetch to reject instantly —
  // without keys every provider would otherwise block on connection timeouts.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('offline test'); }) as typeof fetch;
  try {
    const fallback = await runSohamAgent('xyzzy quux blorp nonsense', [], {
      deps: { generateText: async () => { throw new Error('no models configured'); } },
    });
    assert.equal(fallback.plannedBy, 'fallback');
    // gibberish matches no regex tool — empty result set, crucially no crash/hang offline
    assert.equal(fallback.results.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('runSohamAgent ok — regex fallback when the planner fails (no crash, no hang)');

  // Zero-tool model plan → no tools, plannedBy model
  const none = await runSohamAgent('hello there', [], {
    deps: { generateText: async () => '{"tools":[],"memory_extract":false}' },
  });
  assert.equal(none.plannedBy, 'model');
  assert.equal(none.results.length, 0);
  assert.equal(none.memoryExtract, false);
  console.log('runSohamAgent ok — zero-tool plan honoured');

  // ── 6) runToolByName never throws, even for junk ─────────────────────────────
  const junk = await runToolByName('web_read' as any, '', []);
  assert.equal(junk.ok, false);
  console.log('runToolByName ok — structured failure, no throw');

  console.log('agent checks passed ✔');
}

main().catch(err => { console.error(err); process.exit(1); });
