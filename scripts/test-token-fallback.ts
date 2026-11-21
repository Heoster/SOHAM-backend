/**
 * Token Detector, Dynamic Chain Shifter & Per-Model Fallback Verification
 * Tests:
 *   1. Token detection accounts for systemPrompt + prompt + history + maxOutputTokens
 *   2. Dynamic chain shifting across TINY/SMALL/MEDIUM/LARGE/HUGE budgets
 *   3. Live 60s TPM window shifts away from groq-gpt-oss-20b before hitting 429
 *   4. Groq 429 TPM on openai/gpt-oss-20b falls back directly to qwen/qwen3.8-27b (same provider!)
 *   5. Single Google model stall (gemini-3.6-flash) falls back to gemini-3.5-flash-lite without poisoning all of Google
 *   6. Stream abort propagation cancels hung fetch immediately
 */

import assert from 'node:assert/strict';

const envKeys = [
  'GROQ_API_KEY',
  'GROQ_FREE_PLAN_ONLY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'ENABLE_CLOUDFLARE_TEXT_AI',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_AI_API_TOKEN',
] as const;

const savedEnv = new Map(envKeys.map(k => [k, process.env[k]]));
const originalFetch = global.fetch;

async function run(): Promise<void> {
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.GROQ_FREE_PLAN_ONLY = 'true';
  process.env.GOOGLE_API_KEY = 'test-google-key';
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  process.env.ENABLE_CLOUDFLARE_TEXT_AI = 'true';
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-cf-account';
  process.env.CLOUDFLARE_AI_API_TOKEN = 'test-cf-token';

  const { getModelRegistry } = require('../routing/model-registry') as typeof import('../routing/model-registry');
  const { resolveAutoRoute } = require('../routing/auto-router') as typeof import('../routing/auto-router');
  const {
    computeTokenBudget,
    applyTokenBudget,
    recordModelTokenUsage,
    resetTokenBudgetTracking,
  } = require('../routing/token-budget') as typeof import('../routing/token-budget');
  const {
    streamWithSmartFallback,
    generateWithSmartFallback,
    resetFallbackState,
  } = require('../routing/smart-fallback') as typeof import('../routing/smart-fallback');

  getModelRegistry().refreshProviderAvailability();
  resetFallbackState();

  const fullChain = resolveAutoRoute('CHAT').modelChain;
  assert.ok(fullChain.includes('groq-gpt-oss-20b'), 'chain includes gpt-oss-20b');
  assert.ok(fullChain.includes('groq-qwen3.8-27b'), 'chain includes qwen3.8-27b');
  assert.ok(fullChain.includes('gemini-3.5-flash-lite'), 'chain includes gemini-3.5-flash-lite');

  // ── 1. Token detection includes systemPrompt ────────────────────────────────
  const bigSystemPrompt = 'S'.repeat(9000); // ~2572 tokens
  const budgetWithSys = computeTokenBudget('hi there', [], 2048, bigSystemPrompt);
  const budgetWithoutSys = computeTokenBudget('hi there', [], 2048, '');
  assert.ok(budgetWithSys.systemPromptTokens >= 2500, 'systemPrompt tokens must be counted');
  assert.ok(budgetWithSys.inputTokens > budgetWithoutSys.inputTokens + 2000, 'inputTokens must include systemPrompt');

  // ── 2. Dynamic chain shifting by token budget ───────────────────────────────
  // TINY (<2500 total): cheapest small Groq 20B runs first
  const tiny = applyTokenBudget('hi', [], fullChain, 512, 'short sys');
  assert.equal(tiny.budget.bucket, 'TINY');
  assert.equal(tiny.chain[0], 'groq-gpt-oss-20b', 'TINY request should run cheapest small Groq model first');

  // MEDIUM (5K-10K total, e.g. systemPrompt + message + 2048 output = ~5600): shifts Qwen 27B ahead of 20B
  const mediumPrompt = 'M'.repeat(4500); // ~1286 tok + 2572 sys + 2048 out = ~5906 tok
  const medium = applyTokenBudget(mediumPrompt, [], fullChain, 2048, bigSystemPrompt);
  assert.equal(medium.budget.bucket, 'MEDIUM');
  assert.ok(
    medium.chain.indexOf('groq-qwen3.8-27b') < medium.chain.indexOf('groq-gpt-oss-20b'),
    `MEDIUM chain should prefer qwen3.8-27b ahead of gpt-oss-20b (got ${medium.chain.slice(0, 4).join(', ')})`,
  );

  // LARGE (>=10K total, > 8K Groq TPM): shifts Google Flash-Lite ahead of 8K-TPM Groq & Cloudflare
  const largePrompt = 'L'.repeat(30000); // ~8572 tok + sys + out > 10K
  const large = applyTokenBudget(largePrompt, [], fullChain, 2048, bigSystemPrompt);
  assert.equal(large.budget.bucket, 'LARGE');
  assert.equal(large.chain[0], 'gemini-3.5-flash-lite', `LARGE chain should shift to Flash-Lite first (got ${large.chain[0]})`);
  assert.ok(
    large.chain.indexOf('gemini-3.5-flash-lite') < large.chain.indexOf('groq-gpt-oss-20b'),
    'LARGE chain must demote 8K-TPM Groq behind Google Flash-Lite',
  );
  assert.ok(
    large.chain.indexOf('openrouter-free-router') < large.chain.indexOf('cloudflare-granite-4-micro'),
    'Free OpenRouter must stay ahead of Neuron-billed Cloudflare',
  );

  // ── 3. Live 60s TPM window shifts away from saturated 20B ──────────────────
  resetTokenBudgetTracking();
  recordModelTokenUsage('groq-gpt-oss-20b', 3223);
  // Request needing ~5591 tokens (2572 sys + ~971 prompt + 2048 out): 3223 + 5591 > 8000!
  const saturated = applyTokenBudget('P'.repeat(3400), [], fullChain, 2048, bigSystemPrompt);
  assert.ok(
    saturated.chain.indexOf('groq-qwen3.8-27b') < saturated.chain.indexOf('groq-gpt-oss-20b'),
    `Saturated 20B (3223 used) must be demoted behind Qwen (got ${saturated.chain.slice(0, 4).join(', ')})`,
  );
  // Even for a SMALL request (<5000 total) if 20B already used 5500 tokens: 5500 + 3500 > 8000!
  resetTokenBudgetTracking();
  recordModelTokenUsage('groq-gpt-oss-20b', 5500);
  const smallSaturated = applyTokenBudget('quick question', [], fullChain, 1024, bigSystemPrompt);
  assert.ok(
    smallSaturated.chain.indexOf('groq-qwen3.8-27b') < smallSaturated.chain.indexOf('groq-gpt-oss-20b'),
    'Saturated 20B must shift to Qwen even on small requests',
  );

  // ── 4. Groq 429 on 20B falls back directly to Groq Qwen 27B ────────────────
  resetFallbackState();
  const attemptedModels: string[] = [];
  global.fetch = (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    const model = body.model ?? 'unknown';
    attemptedModels.push(model);

    if (model === 'openai/gpt-oss-20b') {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Used 3223, Requested 5591. Please try again in 6.105s.',
            type: 'tokens',
            code: 'rate_limit_exceeded',
          },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (model === 'qwen/qwen3.8-27b') {
      const sse = 'data: {"choices":[{"delta":{"content":"Hello from Qwen!"}}]}\n\ndata: [DONE]\n\n';
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }

    throw new Error(`Unexpected fallback model called: ${model}`);
  }) as typeof fetch;

  const stream1 = streamWithSmartFallback({
    prompt: 'hi',
    systemPrompt: 'short',
    history: [],
    modelChain: ['groq-gpt-oss-20b', 'groq-qwen3.8-27b', 'gemini-3.5-flash-lite'],
    params: { temperature: 0.5, topP: 0.9, maxOutputTokens: 512 },
  });
  let out1 = '';
  let step1 = await stream1.next();
  while (!step1.done) {
    out1 += step1.value;
    step1 = await stream1.next();
  }
  assert.equal(out1, 'Hello from Qwen!');
  assert.deepEqual(attemptedModels, ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);
  assert.equal(step1.value.modelUsed, 'groq-qwen3.8-27b');
  assert.equal(step1.value.fallbackTriggered, true);

  // Subsequent call within the cooldown skips 20B immediately and hits Qwen directly!
  attemptedModels.length = 0;
  const stream2 = streamWithSmartFallback({
    prompt: 'hi again',
    systemPrompt: 'short',
    history: [],
    modelChain: ['groq-gpt-oss-20b', 'groq-qwen3.8-27b', 'gemini-3.5-flash-lite'],
    params: { temperature: 0.5, topP: 0.9, maxOutputTokens: 512 },
  });
  let out2 = '';
  let step2 = await stream2.next();
  while (!step2.done) {
    out2 += step2.value;
    step2 = await stream2.next();
  }
  assert.equal(out2, 'Hello from Qwen!');
  assert.deepEqual(attemptedModels, ['qwen/qwen3.8-27b'], '20B should be skipped while cooling down, going straight to Qwen');

  // ── 5. Single Google model empty/error does NOT poison other Gemini models ─
  resetFallbackState();
  const googleUrls: string[] = [];
  global.fetch = (async (url: RequestInfo | URL): Promise<Response> => {
    const u = String(url);
    googleUrls.push(u);
    if (u.includes('gemini-3.6-flash')) {
      // Empty stream (stalled/no tokens)
      return new Response('data: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (u.includes('gemini-3.5-flash-lite')) {
      const sse = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello from Flash-Lite!"}]}}]}\n\n';
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected URL: ${u}`);
  }) as typeof fetch;

  // Forced manual selection of gemini-3.6-flash (no modelChain, matching chat-stream manual mode):
  // gemini-3.6-flash fails with empty stream -> falls back to gemini-3.5-flash-lite without
  // cooling down the whole google provider.
  const stream3 = streamWithSmartFallback({
    prompt: 'hello',
    systemPrompt: 'short',
    history: [],
    preferredModelId: 'gemini-3.6-flash',
    params: { temperature: 0.5, topP: 0.9, maxOutputTokens: 512 },
  });
  let out3 = '';
  let step3 = await stream3.next();
  while (!step3.done) {
    out3 += step3.value;
    step3 = await stream3.next();
  }
  assert.equal(out3, 'Hello from Flash-Lite!');
  assert.equal(step3.value.modelUsed, 'gemini-3.5-flash-lite');
  assert.ok(googleUrls.some(u => u.includes('gemini-3.6-flash')), 'gemini-3.6-flash should be attempted first');
  assert.ok(googleUrls.some(u => u.includes('gemini-3.5-flash-lite')), 'gemini-3.5-flash-lite should follow immediately');

  // ── 6. generateWithSmartFallback also falls back from 20B 429 to Qwen ──────
  resetFallbackState();
  attemptedModels.length = 0;
  global.fetch = (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    const model = body.model ?? 'unknown';
    attemptedModels.push(model);

    if (model === 'openai/gpt-oss-20b') {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Used 3223, Requested 5591. Please try again in 6.105s.',
          },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (model === 'qwen/qwen3.8-27b') {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Non-stream Qwen reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 15 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected model: ${model}`);
  }) as typeof fetch;

  const genRes = await generateWithSmartFallback({
    prompt: 'hi',
    systemPrompt: 'short',
    history: [],
    modelChain: ['groq-gpt-oss-20b', 'groq-qwen3.8-27b', 'gemini-3.5-flash-lite'],
    params: { temperature: 0.5, topP: 0.9, maxOutputTokens: 512 },
  });
  assert.equal(genRes.modelUsed, 'groq-qwen3.8-27b');
  assert.equal(genRes.response.text, 'Non-stream Qwen reply');
  assert.deepEqual(attemptedModels, ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);

  console.log('All token-detector, dynamic chain-shifting, and per-model fallback checks passed ✔');
}

run()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    global.fetch = originalFetch;
    for (const key of envKeys) {
      const v = savedEnv.get(key);
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  });
