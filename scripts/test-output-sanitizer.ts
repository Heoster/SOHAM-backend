/**
 * Output sanitizer checks — reproduces the exact production failure
 * (openrouter-free-router leaking dots_function_call markup into chat).
 * Run: node -r ts-node/register/transpile-only scripts/test-output-sanitizer.ts
 */
import assert from 'node:assert';
import { sanitizeModelOutput, TokenOutputSanitizer } from '../utils/sanitize-model-output';

// ─── Byte-for-byte reproduction of the observed assistant message ────────────
const OBSERVED = '<dots_function_call>\n<think>\n<invoke name="web_search">\n< latest phones under ₹22000 India 2026\n</parameter>\n<parameter name="count">10</parameter>\n</invoke>\n</dots_function_call>\n<';

assert.equal(sanitizeModelOutput(OBSERVED), '', 'leaked tool-call payload must be fully removed');
console.log('✔ observed payload sanitizes to empty');

// ─── Same payload, streamed token-by-token — nothing junk may be emitted ────
for (const size of [1, 3, 7, 16, 64]) {
  const s = new TokenOutputSanitizer();
  let out = '';
  for (let i = 0; i < OBSERVED.length; i += size) out += s.push(OBSERVED.slice(i, i + size));
  out += s.flush();
  assert.equal(out.trim(), '', `chunk size ${size}: streamed output must not leak markup, got: ${JSON.stringify(out)}`);
  console.log(`✔ streamed in ${size}-char chunks → no leak`);
}

// ─── Markup interleaved with a real answer ───────────────────────────────────
const MIXED = 'Here are the best picks.\n<dots_function_call>\n<invoke name="web_search">x</invoke>\n</dots_function_call>\n1. Phone A — ₹18,999\n2. Phone B — ₹21,499';
assert.equal(
  sanitizeModelOutput(MIXED),
  'Here are the best picks.\n\n1. Phone A — ₹18,999\n2. Phone B — ₹21,499',
);
console.log('✔ interleaved answer survives, markup dropped');

// ─── Think/reasoning blocks ──────────────────────────────────────────────────
assert.equal(sanitizeModelOutput('<think>secret reasoning</think>The answer is 4.'), 'The answer is 4.');
assert.equal(sanitizeModelOutput('<thinking>long</thinking>Done.'), 'Done.');
assert.equal(sanitizeModelOutput('<reasoning>why</reasoning>Done.'), 'Done.');
console.log('✔ reasoning blocks removed');

// ─── Unterminated blocks (stream cut off inside the markup) ─────────────────
assert.equal(sanitizeModelOutput('Real answer first.\n<invoke name="web_search">\n{"q":"trailing args'), 'Real answer first.');
assert.equal(sanitizeModelOutput('<dots_function_call>\nunterminated'), '');
console.log('✔ unterminated blocks dropped');

// ─── Benign content must survive untouched ───────────────────────────────────
const DIV = 'Use this HTML: `<div class="card">hi</div>` — that is the element.';
assert.equal(sanitizeModelOutput(DIV), DIV);
const MATH = 'Since 3 < 4 and 7 > 5, the inequality holds.';
assert.equal(sanitizeModelOutput(MATH), MATH);
const CODE = 'if (a<b) { return x < y && y > z; }';
assert.equal(sanitizeModelOutput(CODE), CODE);
console.log('✔ benign <div>/inequality/code survives');

// ─── Nested markup ───────────────────────────────────────────────────────────
assert.equal(
  sanitizeModelOutput('<dots_function_call><think>hidden</think><invoke name="x">y</invoke></dots_function_call>Visible.'),
  'Visible.',
);
console.log('✔ nested blocks removed');

// ─── Incremental: partial tag split exactly at the boundary ──────────────────
{
  const s = new TokenOutputSanitizer();
  const chunks = ['Here is ', 'the answer: <thi', 'nk>secret</thi', 'nk> deeply researched result.'];
  let out = '';
  for (const c of chunks) out += s.push(c);
  out += s.flush();
  assert.equal(out, 'Here is the answer:  deeply researched result.');
  console.log('✔ tag split across chunks handled');
}

// ─── Incremental: trailing lone "<" flushed away ─────────────────────────────
{
  const s = new TokenOutputSanitizer();
  let out = s.push('Normal reply.') + s.push('\n') + s.push('<');
  out += s.flush();
  assert.equal(out.trim(), 'Normal reply.');
  console.log('✔ trailing lone < stripped');
}

// ─── Incremental: stray close tags dropped, text kept ───────────────────────
{
  const s = new TokenOutputSanitizer();
  let out = '';
  for (const c of ['Answer </parameter> with ', '</invoke> markup removed.']) out += s.push(c);
  out += s.flush();
  assert.equal(out, 'Answer  with  markup removed.');
  console.log('✔ stray closing tags dropped, text kept');
}

// ─── Action-JSON: the exact production payload (openrouter-free-router) ─────
const ACTION_OBSERVED = '{\n  "action": "web_search",\n  "query": "Is Meerut a metro city in India"\n}';
assert.equal(sanitizeModelOutput(ACTION_OBSERVED), '', 'whole action-JSON payload must be removed');

for (const size of [1, 3, 7, 16, 64]) {
  const s = new TokenOutputSanitizer();
  let out = '';
  for (let i = 0; i < ACTION_OBSERVED.length; i += size) out += s.push(ACTION_OBSERVED.slice(i, i + size));
  out += s.flush();
  assert.equal(out.trim(), '', `chunk size ${size}: action-JSON must not leak, got: ${JSON.stringify(out)}`);
}
console.log('✔ action-JSON payload removed one-shot and streamed');

// fenced variant
assert.equal(sanitizeModelOutput('```json\n{"action": "web_search", "query": "Meerut"}\n```'), '');
console.log('✔ fenced action-JSON removed');

// interleaved with a real answer — answer survives, payload dropped
{
  const s = new TokenOutputSanitizer();
  const chunks = ['Meerut is ', 'a city in UP. ', '{"action": "web_search", "query": "meerut"}', ' (~1.5M pop.)'];
  let out = '';
  for (const c of chunks) out += s.push(c);
  out += s.flush();
  assert.equal(out, 'Meerut is a city in UP.  (~1.5M pop.)');
  console.log('✔ interleaved action-JSON dropped mid-stream');
}

// nested args variant: {"action":"web_search","args":{"query":"x"}}
{
  const s = new TokenOutputSanitizer();
  let out = '';
  const payload = '{"action": "web_search", "args": {"query": "Is Meerut a metro city in India"}}';
  for (let i = 0; i < payload.length; i += 2) out += s.push(payload.slice(i, i + 2));
  out += s.flush();
  assert.equal(out.trim(), '', `nested action-JSON must not leak, got: ${JSON.stringify(out)}`);
  assert.equal(sanitizeModelOutput('Answer. ' + payload + ' Done.'), 'Answer.  Done.');
  console.log('✔ nested-args action-JSON removed (stream + one-shot)');
}

// legit JSON without "action" survives
{
  const JSONSEB = 'Here is an example config: {"host": "localhost", "port": 3000} — save it.';
  assert.equal(sanitizeModelOutput(JSONSEB), JSONSEB);
  console.log('✔ JSON without action key survives');
}

// ─── Rescue parser: parseActionJson ──────────────────────────────────────────
import { parseActionJson } from '../utils/action-json';
assert.deepEqual(parseActionJson(ACTION_OBSERVED), { tool: 'web_search', query: 'Is Meerut a metro city in India' });
assert.deepEqual(parseActionJson('{"action": "search", "query": "q"}'), { tool: 'web_search', query: 'q' });
assert.deepEqual(parseActionJson('{"action":"web_search","args":{"query":"nested q"}}'), { tool: 'web_search', query: 'nested q' });
assert.deepEqual(parseActionJson('\`\`\`json\n{"action": "news_search", "query": "Meerut metro news"}\n\`\`\`'), { tool: 'news_search', query: 'Meerut metro news' });
assert.deepEqual(parseActionJson('{"tool": "wikipedia", "query": "Meerut"}'), { tool: 'wikipedia', query: 'Meerut' });
assert.equal(parseActionJson('Meerut is a metro city.'), null, 'prose must not parse as action');
assert.equal(parseActionJson('{"action": "image_generate", "query": "a cat"}'), null, 'image_generate is not a text-rescue tool');
assert.equal(parseActionJson('{"action": "dance_party", "query": "x"}'), null, 'unknown tool rejected');
assert.equal(parseActionJson('{"query": "no action key"}'), null);
console.log('✔ parseActionJson cases');

// ─── Prompt teaches the model not to emit these in the first place ───────────
import { buildSystemPrompt } from '../routes/system-prompt';
const prompt = buildSystemPrompt('helpful', 'intermediate');
assert.match(prompt, /HOW TOOLS WORK/i, 'tools-are-run-by-the-backend section present');
assert.match(prompt, /never call a tool yourself/i, 'explicit never-call-tools rule present');
assert.match(prompt, /\{"action": "web_search"/, 'forbidden action-JSON shape shown as forbidden');
assert.match(prompt, /Whatever you write IS the user's visible message/i, 'visible-message rule present');
console.log('✔ system prompt forbids raw tool-call output');

console.log('\noutput-sanitizer checks passed ✔');
