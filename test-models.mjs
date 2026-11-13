/**
 * Model API Test Script — SOHAM Full Suite
 * Run: node test-models.mjs
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.resolve('.env') });

const GROQ_KEY     = process.env.GROQ_API_KEY;
const GROQ_FREE_PLAN_ONLY = process.env.GROQ_FREE_PLAN_ONLY === 'true';
const GOOGLE_KEY   = process.env.GOOGLE_API_KEY;
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
        body: JSON.stringify({ model: modelId, messages: PROMPT, ...(url.includes('api.groq.com') ? { max_completion_tokens: 20 } : { max_tokens: 20 }) }),
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
const ORURL = 'https://openrouter.ai/api/v1/chat/completions';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function runAll() {
  console.log('\n========================================');
  console.log('  SOHAM Free Model API Test Suite');
  console.log('========================================\n');

  const tests = [
    // Groq checks are skipped unless the operator explicitly confirms a $0 Free-plan account.
    () => GROQ_FREE_PLAN_ONLY
      ? testOpenAICompat('Groq: GPT-OSS 120B', GROQ_URL, GROQ_KEY, 'openai/gpt-oss-120b')
      : Promise.resolve({ label: 'Groq: GPT-OSS 120B', status: 'SKIP', reason: 'GROQ_FREE_PLAN_ONLY is not true' }),
    () => GROQ_FREE_PLAN_ONLY
      ? testOpenAICompat('Groq: GPT-OSS 20B', GROQ_URL, GROQ_KEY, 'openai/gpt-oss-20b')
      : Promise.resolve({ label: 'Groq: GPT-OSS 20B', status: 'SKIP', reason: 'GROQ_FREE_PLAN_ONLY is not true' }),
    () => GROQ_FREE_PLAN_ONLY
      ? testOpenAICompat('Groq: Qwen 3.8 27B', GROQ_URL, GROQ_KEY, 'qwen/qwen3.8-27b')
      : Promise.resolve({ label: 'Groq: Qwen 3.8 27B', status: 'SKIP', reason: 'GROQ_FREE_PLAN_ONLY is not true' }),
    // These endpoints are documented as free-tier or explicitly free-router paths.
    () => testGoogle('Google: Gemini 3.6 Flash', 'gemini-3.6-flash'),
    () => testGoogle('Google: Gemini 3.5 Flash-Lite', 'gemini-3.5-flash-lite'),
    () => testGoogle('Google: Gemini 3.1 Flash-Lite', 'gemini-3.1-flash-lite'),
    () => testOpenAICompat('OpenRouter: free-only router', ORURL, OR_KEY, 'openrouter/free', OR),
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
