/**
 * Regression checks: the model must know the time, but never volunteer it.
 * Run: node -r ts-node/register/transpile-only scripts/test-time-scope.ts
 */
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../routes/system-prompt';
import {
  scopeInjectedClockInstructions,
  stripInjectedContext,
} from '../utils/clean-message';

// ─── 1) System prompt no longer commands time-volunteering ──────────────────
const prompt = buildSystemPrompt('helpful', 'intermediate');
assert.ok(!/Always use this when answering questions about/i.test(prompt), 'must not contain the old imperative');
assert.ok(!/Never say you don't know the current date or time\./i.test(prompt), 'must not contain the old "never say you don\'t know" line');
assert.match(prompt, /never mention unless the user asks/i, 'top line must carry the scope note');
assert.match(prompt, /NEVER mention, restate, or volunteer the current time or date/i, 'strict-scope rule present');
assert.match(prompt, /If the user didn't ask about time or date, an answer that contains it is WRONG/i, 'hard rule present');

// ─── 2) Frontend SOHAM_CLOCK imperative is neutralized, values kept ─────────
const blob =
  'Set a 25 minute timer for me\n\n' +
  'SOHAM_CLOCK\n' +
  'Timezone: India Standard Time (IST, UTC+05:30), no daylight saving. Current time: 19:52:07 IST (07:52 PM). ' +
  'Today: Wednesday, 18 November 2026. UTC now: 2026-11-18 14:22:07\n\n' +
  'Answer every question about the current time, date or day from this clock. Never guess it.';

const scoped = scopeInjectedClockInstructions(blob);
assert.match(scoped, /SOHAM_CLOCK/, 'clock block must be KEPT (model still needs the time)');
assert.match(scoped, /19:52:07 IST/, 'clock values must be KEPT');
assert.ok(!/Answer every question about the current time/i.test(scoped), 'imperative must be rewritten');
assert.match(scoped, /Never volunteer or restate the current time or date unprompted/i, 'scoped rule present');

// Ordinary messages are untouched
assert.equal(scopeInjectedClockInstructions('what is the capital of France?'), 'what is the capital of France?');

// ─── 3) Tool routing still sees only user text (unchanged behavior) ─────────
assert.equal(stripInjectedContext(blob), 'Set a 25 minute timer for me');

// ─── 4) Variant directive without the tail marker ───────────────────────────
const noTail = 'hi\n\nSOHAM_CLOCK\ntime stuff\nAnswer every question about the current time, date or day from this clock.';
const scopedNoTail = scopeInjectedClockInstructions(noTail);
assert.ok(!/Answer every question/i.test(scopedNoTail), 'bare imperative variant must also be rewritten');
assert.match(scopedNoTail, /Never volunteer or restate/i);

// ─── 4) Timer honesty — SOHAM must know it has no timer/alarm/reminder ───────
assert.match(prompt, /NO timer, alarm or reminder tool/i, 'timer limitation must be stated explicitly');
assert.match(prompt, /cannot message you first/i, 'proactive-messaging limitation present');
assert.match(prompt, /I'll let you know when it's up/i, 'the exact forbidden phrase must be listed as forbidden');
assert.match(prompt, /phone's timer app/i, 'must point at the device timer for real alerts');
assert.match(prompt, /how much time is left/i, 'must offer the countdown it CAN do');

console.log('time-scope checks passed ✔');
process.exit(0);
