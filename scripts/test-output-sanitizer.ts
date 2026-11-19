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

console.log('\noutput-sanitizer checks passed ✔');
