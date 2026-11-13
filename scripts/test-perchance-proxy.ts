import assert from 'node:assert/strict';
import { perchanceImageHandler } from '../routes/image/perchance';

async function main(): Promise<void> {
  const oldHost = process.env.PERCHANCE_SERVICE_HOSTPORT;
  const oldUrl = process.env.PERCHANCE_SERVICE_URL;
  const oldToken = process.env.PERCHANCE_SERVICE_TOKEN;
  const oldFetch = globalThis.fetch;
  process.env.PERCHANCE_SERVICE_HOSTPORT = 'perchance-internal:10000';
  delete process.env.PERCHANCE_SERVICE_URL;
  process.env.PERCHANCE_SERVICE_TOKEN = 'local-test-secret';

  let expectedServiceUrl = 'http://perchance-internal:10000/perchance';
  let forwardedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), expectedServiceUrl);
    assert.equal(new Headers(init?.headers).get('X-Perchance-Service-Token'), 'local-test-secret');
    forwardedBody = JSON.parse(String(init?.body));
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'X-Perchance-Seed': '73',
        'X-Perchance-Width': '768',
        'X-Perchance-Height': '768',
      },
    });
  };

  try {
    const response: { statusCode: number; body?: Record<string, any> } = { statusCode: 200 };
    const res = {
      status(code: number) { response.statusCode = code; return this; },
      json(body: Record<string, any>) { response.body = body; return this; },
    };
    await perchanceImageHandler({
      body: { prompt: 'A fox in a snowy pine forest', style: 'artistic' },
      requestId: 'test-request-id',
    } as any, res as any);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body?.success, true);
    assert.equal(response.body?.provider, 'perchance');
    assert.equal(response.body?.imageUrl, 'data:image/png;base64,iVBORw==');
    assert.equal(response.body?.seed, '73');
    assert.equal(response.body?.width, 768);
    assert.match(String(forwardedBody?.prompt), /fox in a snowy pine forest/i);
    assert.match(String(forwardedBody?.prompt), /painterly/i);
    assert.equal(forwardedBody?.shape, 'square');
    assert.equal(forwardedBody?.seed, undefined);

    process.env.PERCHANCE_SERVICE_URL = 'https://soham-backend-dxih.onrender.com/';
    expectedServiceUrl = 'https://soham-backend-dxih.onrender.com/perchance';
    const externalUrlResponse: { statusCode: number; body?: Record<string, any> } = { statusCode: 200 };
    await perchanceImageHandler({ body: { prompt: 'another fox' }, requestId: 'test-external' } as any, {
      status(code: number) { externalUrlResponse.statusCode = code; return this; },
      json(body: Record<string, any>) { externalUrlResponse.body = body; return this; },
    } as any);
    assert.equal(externalUrlResponse.statusCode, 200);
    assert.equal(externalUrlResponse.body?.provider, 'perchance');

    const invalidResponse: { statusCode: number; body?: Record<string, any> } = { statusCode: 200 };
    await perchanceImageHandler({ body: { prompt: 'fox', style: 'not-a-style' }, requestId: 'test' } as any, {
      status(code: number) { invalidResponse.statusCode = code; return this; },
      json(body: Record<string, any>) { invalidResponse.body = body; return this; },
    } as any);
    assert.equal(invalidResponse.statusCode, 400);
    console.log('Perchance proxy safety checks passed.');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldHost === undefined) delete process.env.PERCHANCE_SERVICE_HOSTPORT;
    else process.env.PERCHANCE_SERVICE_HOSTPORT = oldHost;
    if (oldUrl === undefined) delete process.env.PERCHANCE_SERVICE_URL;
    else process.env.PERCHANCE_SERVICE_URL = oldUrl;
    if (oldToken === undefined) delete process.env.PERCHANCE_SERVICE_TOKEN;
    else process.env.PERCHANCE_SERVICE_TOKEN = oldToken;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
