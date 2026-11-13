import assert from 'node:assert/strict';
import { generatePerchanceImage, generateSOHAMPrimaryImage } from '../image/perchance-browser-client';

async function main(): Promise<void> {
  await assert.rejects(
    generatePerchanceImage({ prompt: 'a test image' }),
    /browser-only/,
    'Perchance client must not run in the Node backend',
  );
  await assert.rejects(
    generateSOHAMPrimaryImage({ prompt: 'a test image' }),
    /browser-only/,
    'SOHAM primary Perchance entry point must be browser-only',
  );

  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let script: any;
  let scriptRemoved = false;
  const fakeWindow: Record<string, any> = {};
  const fakeDocument = {
    createElement: (tag: string) => {
      const element: any = {
        style: {},
        setAttribute: () => undefined,
        remove: () => { if (tag === 'script') scriptRemoved = true; },
      };
      if (tag === 'script') script = element;
      return element;
    },
    body: {
      appendChild: (element: any) => {
        if (element.src === 'https://perchance.org') {
          queueMicrotask(() => element.onload?.());
          return;
        }
        const requestUrl = new URL(element.src);
        const callbackName = requestUrl.searchParams.get('callback');
        assert.ok(callbackName && typeof fakeWindow[callbackName] === 'function');
        queueMicrotask(() => fakeWindow[callbackName]({
          id: requestUrl.searchParams.get('id'),
          ok: true,
          url: 'https://images.example/test.png',
          seed: 12,
        }));
      },
    },
  };

  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
  try {
    const resultPromise = generateSOHAMPrimaryImage({ prompt: 'a safe test prompt', style: 'anime', timeoutMs: 2000 });
    await new Promise(resolve => setTimeout(resolve, 510));
    const requestUrl = new URL(script.src);
    assert.equal(requestUrl.origin, 'https://perchance.org');
    assert.equal(requestUrl.pathname, '/perchance-ai-api');
    assert.match(requestUrl.searchParams.get('prompt') ?? '', /safe test prompt/i);
    assert.match(requestUrl.searchParams.get('prompt') ?? '', /anime art style/i);
    assert.equal(requestUrl.searchParams.get('format'), 'json');
    assert.ok(requestUrl.searchParams.get('id'));
    assert.match(requestUrl.searchParams.get('callback') ?? '', /^__soham_perchance_[a-f0-9]+$/);

    const result = await resultPromise;
    assert.equal(result.url, 'https://images.example/test.png');
    assert.equal(result.seed, 12);
    assert.ok(result.enhancedPrompt.includes('Anime art style'));
    assert.equal(scriptRemoved, true, 'JSONP script should be cleaned up after success');
    assert.equal(fakeWindow[requestUrl.searchParams.get('callback')!], undefined, 'callback should be removed after success');
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
