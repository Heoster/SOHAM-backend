import assert from 'node:assert/strict';

const keys = ['ENABLE_CLOUDFLARE_TEXT_AI', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AI_API_TOKEN', 'OPENROUTER_API_KEY'] as const;
const previous = new Map(keys.map(key => [key, process.env[key]]));

try {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  process.env.CLOUDFLARE_AI_API_TOKEN = 'test-token';
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  process.env.ENABLE_CLOUDFLARE_TEXT_AI = 'false';

  const { getModelRegistry } = require('../routing/model-registry') as typeof import('../routing/model-registry');
  const { resolveAutoRoute } = require('../routing/auto-router') as typeof import('../routing/auto-router');
  const registry = getModelRegistry();

  registry.refreshProviderAvailability();
  const withoutCloudflare = resolveAutoRoute('CHAT').modelChain;
  assert.ok(withoutCloudflare.includes('openrouter-free-router'));
  assert.ok(!withoutCloudflare.includes('cloudflare-granite-4-micro'));
  assert.ok(!withoutCloudflare.includes('cloudflare-gpt-oss-20b'));

  process.env.ENABLE_CLOUDFLARE_TEXT_AI = 'true';
  registry.refreshProviderAvailability();
  const withCloudflare = resolveAutoRoute('CHAT').modelChain;
  const openRouterIndex = withCloudflare.indexOf('openrouter-free-router');
  const graniteIndex = withCloudflare.indexOf('cloudflare-granite-4-micro');
  const gptOssIndex = withCloudflare.indexOf('cloudflare-gpt-oss-20b');
  assert.ok(openRouterIndex >= 0, 'OpenRouter free model should remain in the auto chain');
  assert.ok(graniteIndex > openRouterIndex, 'Cloudflare Granite should be a later fallback than OpenRouter');
  assert.ok(gptOssIndex > openRouterIndex, 'Cloudflare GPT-OSS should be a later fallback than OpenRouter');

  console.log('Auto-router includes gated Cloudflare models after the existing free-provider fallbacks.');
} finally {
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
