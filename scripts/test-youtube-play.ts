/**
 * Mocked checks for the YouTube play tool.
 * Run: node -r ts-node/register/transpile-only scripts/test-youtube-play.ts
 */
import assert from 'node:assert/strict';
import {
  buildYouTubeSearchUrl,
  extractPlayQuery,
  extractVideoId,
  parseYouTubeSearchMarkdown,
  playYouTubeVideo,
} from '../tools/youtube-play';
import { detectToolIntent, executeSohamTool } from '../tools/agent-tools';

// ─── 1) Command extraction ──────────────────────────────────────────────────
assert.equal(extractPlayQuery('play despacito'), 'despacito');
assert.equal(extractPlayQuery('/play lofi hip hop radio'), 'lofi hip hop radio');
assert.equal(extractPlayQuery('soham can you play back in black on youtube'), 'back in black');
assert.equal(extractPlayQuery('please play the shape of you'), 'shape of you');
assert.equal(extractPlayQuery('watch interstellar trailer'), 'interstellar trailer');
assert.equal(extractPlayQuery('play "blinding lights" official video'), 'blinding lights official video');
assert.equal(extractPlayQuery('how to play guitar'), null, 'how-to requests must not become play tools');
assert.equal(extractPlayQuery('play cricket world cup final'), null, 'sports must fall through to the sports tool');
assert.equal(extractPlayQuery('what is the weather today'), null);

// ─── 2) Intent wiring ───────────────────────────────────────────────────────
assert.equal(detectToolIntent('play despacito')?.tool, 'play_video');
assert.equal(detectToolIntent('play despacito')?.query, 'despacito');
assert.equal(detectToolIntent('/play lofi beats')?.tool, 'play_video');
assert.equal(detectToolIntent('what is the capital of France')?.tool, 'web_search');

// ─── 3) URL + id extraction ─────────────────────────────────────────────────
assert.equal(buildYouTubeSearchUrl('lofi hiphop'), 'https://www.youtube.com/results?search_query=lofi%20hiphop');
assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=RDdQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.equal(extractVideoId('https://www.youtube.com/playlist?list=PLabcdefghij'), null);
assert.equal(extractVideoId('https://www.youtube.com/@somechannel'), null);
assert.equal(extractVideoId('https://www.notyoutube.com/watch?v=dQw4w9WgXcQ'), null);

// ─── 4) Markdown parsing: first real video wins, junk filtered ──────────────
const SAMPLE_MARKDOWN = `
# Search Results — lofi hip hop radio

[Lo-fi Hip Hop Radio — beats to relax/study to](https://www.youtube.com/watch?v=5qap5aO4i9A)
  [Lofi Girl](https://www.youtube.com/@LofiGirlOfficial) · 12K watching

[Some ads page](https://www.youtube.com/results?search_query=ads)

[A playlist link](https://www.youtube.com/playlist?list=PLabcdefghijk)

[lofi hip hop mix 24/7](https://www.youtube.com/watch?v=jfKfPfyJRdk)
  [ChilledCow](https://www.youtube.com/@ChilledCow) · 5.2M views

[Duplicate of the first](https://www.youtube.com/watch?v=5qap5aO4i9A&t=95s)

[Lofi girl thumbnail](https://i.ytimg.com/vi/xyz/maxresdefault.jpg)
`;

const parsed = parseYouTubeSearchMarkdown(SAMPLE_MARKDOWN);
assert.equal(parsed.length, 2, 'dedupes by video id and drops ads/playlists');
assert.equal(parsed[0].videoId, '5qap5aO4i9A');
assert.equal(parsed[0].embedUrl, 'https://www.youtube.com/embed/5qap5aO4i9A');
assert.equal(parsed[0].watchUrl, 'https://www.youtube.com/watch?v=5qap5aO4i9A');
assert.match(parsed[0].title, /Lo-fi Hip Hop Radio/);
assert.equal(parsed[1].videoId, 'jfKfPfyJRdk');

// Shorts fallback when no watch URLs exist
const shortsOnly = parseYouTubeSearchMarkdown('[quick tip](https://www.youtube.com/shorts/aaaaaaaaaaa)');
assert.equal(shortsOnly.length, 1);

// Realistic Jina plain-markdown output with angle-bracket URLs
const jinaStyle = parseYouTubeSearchMarkdown('1. [Test Song Official Video](<https://www.youtube.com/watch?v=abcDEFghi12>)\n   some snippet\n2. [Another](<https://www.youtube.com/watch?v=zzzYYyyy000>)');
assert.equal(jinaStyle.length, 2);
assert.equal(jinaStyle[0].videoId, 'abcDEFghi12');

// ─── 5) End-to-end with mocked fetch: Jina primary ─────────────────────────
const originalFetch = globalThis.fetch;
const originalEnv = { JINA_API_KEY: process.env.JINA_API_KEY, FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY };

async function withMockedFetch(
  jinaHandler: () => Response,
  firecrawlHandler?: () => Response,
): Promise<{ result: Awaited<ReturnType<typeof playYouTubeVideo>>; calls: string[] }> {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.startsWith('https://r.jina.ai/')) return jinaHandler();
    if (url.startsWith('https://api.firecrawl.dev/')) {
      return firecrawlHandler
        ? firecrawlHandler()
        : new Response(JSON.stringify({ success: false, error: 'should not be called' }), { status: 500 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  try {
    // Bust the module-level cache between cases by using distinct queries
    const result = await playYouTubeVideo(`unit test ${Math.random().toString(36).slice(2)}`);
    return { result, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void (async () => {
  delete process.env.JINA_API_KEY;
  process.env.FIRECRAWL_API_KEY = 'mock-firecrawl-key';

  // 5a) Jina succeeds
  {
    const { result, calls } = await withMockedFetch(
      () => new Response(SAMPLE_MARKDOWN, { status: 200 }),
    );
    assert.ok(result.ok);
    assert.equal(result.source, 'jina');
    assert.equal(result.videoId, '5qap5aO4i9A');
    assert.deepEqual(calls[0], 'https://r.jina.ai/https://www.youtube.com/results?search_query=' + encodeURIComponent(result.query));
    assert.ok(!calls.some(c => c.startsWith('https://api.firecrawl.dev')), 'Firecrawl must not be hit when Jina works');
  }

  // 5b) Jina fails → Firecrawl fallback
  {
    const { result, calls } = await withMockedFetch(
      () => new Response('upstream error', { status: 502 }),
      () => new Response(JSON.stringify({ success: true, data: { markdown: SAMPLE_MARKDOWN } }), { status: 200 }),
    );
    assert.ok(result.ok);
    assert.equal(result.source, 'firecrawl');
    assert.equal(result.videoId, '5qap5aO4i9A');
    assert.ok(calls.some(c => c.startsWith('https://api.firecrawl.dev/')), 'Firecrawl should be used as fallback');
  }

  // 5c) Jina ok but unparsable → Firecrawl fallback
  {
    const { result } = await withMockedFetch(
      () => new Response('Loading your results… JavaScript is required to view this page. Please enable JavaScript and reload to continue.', { status: 200 }),
      () => new Response(JSON.stringify({ success: true, data: { markdown: SAMPLE_MARKDOWN } }), { status: 200 }),
    );
    assert.ok(result.ok);
    assert.equal(result.source, 'firecrawl');
  }

  // 5d) Both fail → graceful ok=false with searchUrl fallback
  {
    const { result } = await withMockedFetch(
      () => { throw new Error('socket hang up'); },
      () => new Response(JSON.stringify({ success: false }), { status: 500 }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.searchUrl.startsWith('https://www.youtube.com/results?search_query='));
    assert.equal(result.candidates.length, 0);
  }

  // 5e) executeSohamTool end-to-end (mocked Jina)
  {
    globalThis.fetch = (async () => new Response(SAMPLE_MARKDOWN, { status: 200 })) as typeof fetch;
    try {
      const tool = await executeSohamTool('play lofi hip hop radio for unit');
      assert.equal(tool?.tool, 'play_video');
      assert.equal(tool?.ok, true);
      assert.ok(tool?.embedUrl?.includes('/embed/'));
      assert.ok(tool?.openUrl?.includes('watch?v='));
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // Restore env
  if (originalEnv.JINA_API_KEY === undefined) delete process.env.JINA_API_KEY; else process.env.JINA_API_KEY = originalEnv.JINA_API_KEY;
  if (originalEnv.FIRECRAWL_API_KEY === undefined) delete process.env.FIRECRAWL_API_KEY; else process.env.FIRECRAWL_API_KEY = originalEnv.FIRECRAWL_API_KEY;

  console.log('youtube-play checks passed ✔');
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
