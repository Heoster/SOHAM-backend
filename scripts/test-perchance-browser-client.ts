import assert from 'node:assert/strict';
import { generatePerchanceImage } from '../image/perchance-browser-client';

async function main(): Promise<void> {
  await assert.rejects(
    generatePerchanceImage({ prompt: 'a test image' }),
    /browser-only/,
    'Perchance client must not run in the Node backend',
  );

  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const handlers = new Map<string, (event: any) => void>();
  let iframe: any;
  let removed = false;
  const fakeWindow = {
    addEventListener: (type: string, listener: (event: any) => void) => handlers.set(type, listener),
    removeEventListener: (type: string) => handlers.delete(type),
  };
  const fakeDocument = {
    createElement: (tag: string) => {
      assert.equal(tag, 'iframe');
      iframe = {
        style: {},
        setAttribute: () => undefined,
        remove: () => { removed = true; },
      };
      return iframe;
    },
    body: { appendChild: () => undefined },
  };

  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
  try {
    const resultPromise = generatePerchanceImage({ prompt: 'a safe test prompt', timeoutMs: 2000 });
    const requestUrl = new URL(iframe.src);
    assert.equal(requestUrl.origin, 'https://perchance.org');
    assert.equal(requestUrl.pathname, '/perchance-ai-api');
    assert.equal(requestUrl.searchParams.get('prompt'), 'a safe test prompt');
    assert.equal(requestUrl.searchParams.get('format'), 'json');
    const requestId = requestUrl.searchParams.get('id');
    assert.ok(requestId);

    const message = handlers.get('message');
    assert.ok(message);
    message!({
      origin: 'https://attacker.example',
      data: { api: 'perchance-image-api', result: { id: requestId, ok: true, url: 'https://images.example/test.png' } },
    });
    message!({
      origin: 'https://perchance.org',
      data: { api: 'perchance-image-api', result: { id: 'different-request', ok: true, url: 'https://images.example/test.png' } },
    });

    const expectedUrl = 'https://images.example/test.png';
    message!({
      origin: 'https://perchance.org',
      data: { api: 'perchance-image-api', result: { id: requestId, ok: true, url: expectedUrl, seed: 12 } },
    });
    const result = await resultPromise;
    assert.equal(result.url, expectedUrl);
    assert.equal(result.seed, 12);
    assert.equal(removed, true, 'iframe should be cleaned up after success');
    assert.equal(handlers.has('message'), false, 'listener should be removed after success');
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else delete (globalThis as any).window;
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else delete (globalThis as any).document;
  }

  console.log('Perchance browser-client safety checks passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
