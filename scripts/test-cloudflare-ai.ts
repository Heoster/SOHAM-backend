import assert from 'node:assert/strict';
import { cfGenerateImage } from '../image/cloudflare-ai';
import { CloudflareAdapter } from '../adapters/cloudflare-adapter';
import type { ModelConfig } from '../routing/model-config';
import { generateImageCFHandler } from '../routes/image/generate-cf';

async function main(): Promise<void> {
  const envKeys = [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_AI_API_TOKEN',
    'CLOUDFLARE_AI_GATEWAY_ID',
    'ENABLE_CLOUDFLARE_TEXT_AI',
    'ENABLE_CLOUDFLARE_IMAGE_AI',
  ] as const;
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_AI_API_TOKEN;
    delete process.env.CLOUDFLARE_AI_GATEWAY_ID;
    delete process.env.ENABLE_CLOUDFLARE_TEXT_AI;
    delete process.env.ENABLE_CLOUDFLARE_IMAGE_AI;

    const adapter = new CloudflareAdapter();
    assert.equal(adapter.isAvailable(), false, 'Cloudflare text must be opt-in');
    process.env.ENABLE_CLOUDFLARE_TEXT_AI = 'true';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account-test';
    process.env.CLOUDFLARE_AI_API_TOKEN = 'token-test';
    assert.equal(adapter.isAvailable(), true, 'Cloudflare text should activate with opt-in and credentials');

    let fetchCount = 0;
    const sentBodies: Array<{ prompt: string; steps: number }> = [];
    globalThis.fetch = async (input, init) => {
      fetchCount++;
      assert.equal(String(input), 'https://api.cloudflare.com/client/v4/accounts/account-test/ai/run/@cf/black-forest-labs/flux-1-schnell');
      const body = JSON.parse(String(init?.body));
      sentBodies.push(body);
      return new Response(Uint8Array.from([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    };

    await assert.rejects(() => cfGenerateImage({ prompt: 'test image' }), /image AI is disabled/);
    assert.equal(fetchCount, 0, 'disabled Cloudflare image must not issue a network call');

    process.env.ENABLE_CLOUDFLARE_IMAGE_AI = 'true';
    const result = await cfGenerateImage({ prompt: ' test image ', steps: 4 });
    assert.equal(result.imageBase64, 'data:image/png;base64,iVBORw==');
    assert.equal(result.model, '@cf/black-forest-labs/flux-1-schnell');
    assert.deepEqual(sentBodies[0], { prompt: 'test image', steps: 4 });

    let responseStatus = 200;
    let responseBody: Record<string, unknown> | undefined;
    const res = {
      status(code: number) { responseStatus = code; return this; },
      json(value: Record<string, unknown>) { responseBody = value; return this; },
    };
    await generateImageCFHandler({ body: { prompt: 'image from route', steps: 3 } } as never, res as never);
    assert.equal(responseStatus, 200);
    assert.equal(responseBody?.success, true);
    assert.equal(fetchCount, 2);
    assert.deepEqual(sentBodies[1], { prompt: 'image from route', steps: 3 });

    await generateImageCFHandler({ body: { prompt: 'x', steps: 9 } } as never, res as never);
    assert.equal(responseStatus, 400, 'unsupported step counts must be rejected before calling Cloudflare');
    assert.equal(fetchCount, 2);

    process.env.CLOUDFLARE_AI_GATEWAY_ID = 'test-gateway';
    let chatBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://api.cloudflare.com/client/v4/accounts/account-test/ai/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('cf-aig-gateway-id'), 'test-gateway');
      chatBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Hello from Cloudflare' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const model: ModelConfig = {
      id: 'cloudflare-granite-4-micro',
      name: 'Granite 4.0 H Micro',
      provider: 'cloudflare',
      modelId: '@cf/ibm-granite/granite-4.0-h-micro',
      category: 'general',
      description: 'test model',
      contextWindow: 131000,
      supportsStreaming: true,
      defaultParams: { temperature: 0.6, topP: 0.9, maxOutputTokens: 128 },
      enabled: true,
    };
    const chat = await adapter.generate({ model, prompt: 'say hello' });
    assert.equal(chat.text, 'Hello from Cloudflare');
    assert.equal(chat.modelUsed, model.id);
    assert.equal(chatBody?.model, model.modelId);
    assert.equal(chatBody?.stream, false);

    console.log('Cloudflare text opt-in/chat, AI Gateway header, FLUX request schema, and route validation checks passed.');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
