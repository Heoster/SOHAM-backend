/**
 * Model API Test Script — SOHAM Full Suite
 * Run: node server/test-models.mjs
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.resolve('server', '.env') });

const GROQ_KEY     = process.env.GROQ_API_KEY;
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
const GOOGLE_KEY   = process.env.GOOGLE_API_KEY;
const HF_KEY       = process.env.HUGGINGFACE_API_KEY;
const OR_KEY       = process.env.OPENROUTER_API_KEY;

const PROMPT = [{ role: 'user', content: 'Reply with just the word OK.' }];
const TIMEOUT_MS = 25000;

function withTimeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
  );
}

async function testOpenAICompat(label, url, apiKey, modelId, extraHeaders = {}) {
  if (!apiKey) return { label, status: 'SKIP', reason: 'No API key' };
  try {
    const res = await Promise.race([
      fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify({ model: modelId, messages: PROMPT, max_tokens: 20 }),
      }),
      withTimeout(TIMEOUT_MS),
    ]);
    const data = await res.json();
    if (!res.ok) return { label, status: 'FAIL', code: res.status, error: (data?.error?.message || JSON.stringify(data)).slice(0, 100) };
    const text = data?.choices?.[0]?.message?.content?.trim();
    return { label, status: 'PASS', response: (text || '').slice(0, 60) };
  } catch (e) {
    return { label, status: 'FAIL', error: e.message.slice(0, 100) };
  }
}

async function testGoogle(label, modelId) {
  if (!GOOGLE_KEY) return { label, status: 'SKIP', reason: 'No API key' };
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GOOGLE_KEY}`;
    const res = await Promise.race([
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with just the word OK.' }] }], generationConfig: { maxOutputTokens: 20 } }),
      }),
      withTimeout(TIMEOUT_MS),
    ]);
    const data = await res.json();
    if (!res.ok) return { label, status: 'FAIL', code: res.status, error: (data?.error?.message || '').slice(0, 100) };
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return { label, status: 'PASS', response: (text || '').slice(0, 60) };
  } catch (e) {
    return { label, status: 'FAIL', error: e.message.slice(0, 100) };
  }
}

const OR = { 'HTTP-Referer': 'https://soham-ai.vercel.app', 'X-Title': 'SOHAM' };
const GROQ  = 'https://api.groq.com/openai/v1/chat/completions';
const CBRAS = 'https://api.cerebras.ai/v1/chat/completions';
const HF    = 'https://router.huggingface.co/v1/chat/completions';
const ORURL = 'https://openrouter.ai/api/v1/chat/completions';

async function runAll() {
  console.log('\n========================================');
  console.log('  SOHAM Model API Test Suite — Full');
  console.log('========================================\n');

  const tests = [
    // ── GROQ ──────────────────────────────────────────────────────────────
    () => testOpenAICompat('Groq: llama-3.1-8b-instant',              GROQ,  GROQ_KEY,     'llama-3.1-8b-instant'),
    () => testOpenAICompat('Groq: llama-3.3-70b-versatile',           GROQ,  GROQ_KEY,     'llama-3.3-70b-versatile'),
    () => testOpenAICompat('Groq: llama-4-scout-17b-16e-instruct',    GROQ,  GROQ_KEY,     'meta-llama/llama-4-scout-17b-16e-instruct'),
    () => testOpenAICompat('Groq: qwen/qwen3-32b',                    GROQ,  GROQ_KEY,     'qwen/qwen3-32b'),
    () => testOpenAICompat('Groq: openai/gpt-oss-120b',               GROQ,  GROQ_KEY,     'openai/gpt-oss-120b'),
    () => testOpenAICompat('Groq: openai/gpt-oss-20b',                GROQ,  GROQ_KEY,     'openai/gpt-oss-20b'),

    // ── CEREBRAS ──────────────────────────────────────────────────────────
    () => testOpenAICompat('Cerebras: llama3.1-8b',                   CBRAS, CEREBRAS_KEY, 'llama3.1-8b'),
    () => testOpenAICompat('Cerebras: gpt-oss-120b',                  CBRAS, CEREBRAS_KEY, 'gpt-oss-120b'),
    () => testOpenAICompat('Cerebras: zai-glm-4.7',                   CBRAS, CEREBRAS_KEY, 'zai-glm-4.7'),
    () => testOpenAICompat('Cerebras: qwen-3-235b-a22b-instruct-2507',CBRAS, CEREBRAS_KEY, 'qwen-3-235b-a22b-instruct-2507'),

    // ── GOOGLE ────────────────────────────────────────────────────────────
    () => testGoogle('Google: gemini-2.5-flash',      'gemini-2.5-flash'),
    () => testGoogle('Google: gemini-2.5-flash-lite', 'gemini-2.5-flash-lite'),

    // ── HUGGINGFACE (free) ────────────────────────────────────────────────
    () => testOpenAICompat('HuggingFace: Llama-3.1-8B-Instruct',          HF, HF_KEY, 'meta-llama/Llama-3.1-8B-Instruct'),
    () => testOpenAICompat('HuggingFace: Llama-3.3-70B-Instruct',         HF, HF_KEY, 'meta-llama/Llama-3.3-70B-Instruct'),
    () => testOpenAICompat('HuggingFace: Qwen2.5-72B-Instruct',           HF, HF_KEY, 'Qwen/Qwen2.5-72B-Instruct'),
    () => testOpenAICompat('HuggingFace: Qwen2.5-7B-Instruct',            HF, HF_KEY, 'Qwen/Qwen2.5-7B-Instruct'),
    () => testOpenAICompat('HuggingFace: DeepSeek-R1-Distill-Llama-70B',  HF, HF_KEY, 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B'),

    // ── OPENROUTER (free tier) ────────────────────────────────────────────
    () => testOpenAICompat('OpenRouter: openai/gpt-oss-20b:free',                ORURL, OR_KEY, 'openai/gpt-oss-20b:free',                OR),
    () => testOpenAICompat('OpenRouter: openai/gpt-oss-120b:free',               ORURL, OR_KEY, 'openai/gpt-oss-120b:free',               OR),
    () => testOpenAICompat('OpenRouter: nvidia/nemotron-3-super-120b-a12b:free', ORURL, OR_KEY, 'nvidia/nemotron-3-super-120b-a12b:free', OR),
    () => testOpenAICompat('OpenRouter: google/gemma-4-31b-it:free',             ORURL, OR_KEY, 'google/gemma-4-31b-it:free',             OR),
    () => testOpenAICompat('OpenRouter: google/gemma-3-27b-it:free',             ORURL, OR_KEY, 'google/gemma-3-27b-it:free',             OR),
    () => testOpenAICompat('OpenRouter: google/gemma-3-12b-it:free',             ORURL, OR_KEY, 'google/gemma-3-12b-it:free',             OR),
    () => testOpenAICompat('OpenRouter: arcee-ai/trinity-large-preview:free',    ORURL, OR_KEY, 'arcee-ai/trinity-large-preview:free',    OR),
    () => testOpenAICompat('OpenRouter: minimax/minimax-m2.5:free',              ORURL, OR_KEY, 'minimax/minimax-m2.5:free',              OR),
    () => testOpenAICompat('OpenRouter: openrouter/elephant-alpha',              ORURL, OR_KEY, 'openrouter/elephant-alpha',              OR),
  ];

  const results = [];
  for (let i = 0; i < tests.length; i += 5) {
    const batch = tests.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(fn => fn()));
    results.push(...batchResults);
    for (const r of batchResults) {
      const icon   = r.status === 'PASS' ? 'PASS' : r.status === 'SKIP' ? 'SKIP' : 'FAIL';
      const detail = r.status === 'PASS' ? `"${r.response}"` : r.reason || r.error || `HTTP ${r.code}`;
      console.log(`[${icon}] ${r.label.padEnd(52)} ${detail}`);
    }
  }

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  console.log(`\n  RESULTS: ${pass} PASS  |  ${fail} FAIL  |  ${skip} SKIP\n`);

  if (fail > 0) {
    console.log('Failed:');
    results.filter(r => r.status === 'FAIL').forEach(r =>
      console.log(`  - ${r.label}: ${r.error || `HTTP ${r.code}`}`)
    );
  }
}

runAll().catch(console.error);
