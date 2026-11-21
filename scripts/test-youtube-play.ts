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
import { stripInjectedContext } from '../utils/clean-message';

// ─── 0) Frontend SOHAM_CLOCK injection must be stripped everywhere ──────────
const CLOCK_BLOB =
  'Play Big Buck Bunny\n\n' +
  'SOHAM_CLOCK\n' +
  'Timezone: India Standard Time (IST, UTC+05:30), no daylight saving. ' +
  'Current time: 18:39:46 IST (06:39 PM). Today: Wednesday, 18 November 2026. ' +
  'UTC now: 2026-11-18 13:09:46\n\n' +
  'Answer every question about the current time, date or day from this clock. Never guess it.';

assert.equal(stripInjectedContext(CLOCK_BLOB), 'Play Big Buck Bunny');
assert.equal(stripInjectedContext('what time is it\n\nSOHAM_CLOCK\ntime info here\nNever guess it.'), 'what time is it');
assert.equal(extractPlayQuery(CLOCK_BLOB), 'Big Buck Bunny');
assert.equal(detectToolIntent(CLOCK_BLOB)?.tool, 'play_video');
assert.equal(detectToolIntent(CLOCK_BLOB)?.query, 'Big Buck Bunny', 'clock junk must not leak into the play query');
assert.equal(detectToolIntent('what time is it\n\nSOHAM_CLOCK\nx\nNever guess it.'), null, 'clock must not force news classification or any tool');

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
assert.equal(extractPlayQuery('play "Imagine" by John Lennon and generate an image of a dove'), 'Imagine by John Lennon', 'compound play+image clause must be cut from the play query');
assert.equal(extractPlayQuery('play despacito and explain the lyrics'), 'despacito');

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

// Thumbnail/duration link before real title link must NOT stick as "YouTube video <id>"
const THUMB_FIRST_MARKDOWN = `
[![](https://i.ytimg.com/vi/2FhgKp_lfJQ/hq720.jpg)](https://www.youtube.com/watch?v=2FhgKp_lfJQ)
[3:42](https://www.youtube.com/watch?v=2FhgKp_lfJQ)
[Afsoos - Anuv Jain (Official Audio)](https://www.youtube.com/watch?v=2FhgKp_lfJQ)
[Anuv Jain](https://www.youtube.com/@AnuvJain)
`;
const thumbParsed = parseYouTubeSearchMarkdown(THUMB_FIRST_MARKDOWN);
assert.equal(thumbParsed.length, 1);
assert.equal(thumbParsed[0].title, 'Afsoos - Anuv Jain (Official Audio)');
assert.equal(thumbParsed[0].channel, 'Anuv Jain');

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

  // 5f) Thumbnail-only markdown (no title text) enriches real title via oEmbed
  {
    const thumbOnlyMd = '[![](https://i.ytimg.com/vi/JgDNFQ2RaLQ/hq720.jpg)](https://www.youtube.com/watch?v=JgDNFQ2RaLQ)';
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://r.jina.ai/')) {
        return new Response(thumbOnlyMd, { status: 200 });
      }
      if (url.startsWith('https://www.youtube.com/oembed')) {
        return new Response(
          JSON.stringify({ title: 'Ed Sheeran - Shape of You (Official Music Video)', author_name: 'Ed Sheeran' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch in oembed test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await playYouTubeVideo('shape of you unit oembed');
      assert.ok(res.ok);
      assert.equal(res.title, 'Ed Sheeran - Shape of You (Official Music Video)');
      assert.equal(res.channel, 'Ed Sheeran');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // Restore env
  if (originalEnv.JINA_API_KEY === undefined) delete process.env.JINA_API_KEY; else process.env.JINA_API_KEY = originalEnv.JINA_API_KEY;
  if (originalEnv.FIRECRAWL_API_KEY === undefined) delete process.env.FIRECRAWL_API_KEY; else process.env.FIRECRAWL_API_KEY = originalEnv.FIRECRAWL_API_KEY;

  // ─── 6) Conversation reference resolution — "play them" after a song list ──
  {
    const { resolveReferencedQuery } = await import('../tools/youtube-play');

    const trending = [
      { role: 'user', content: 'search for some trending hindi songs' },
      { role: 'assistant', content:
        'Here are some trending Hindi songs right now:\n' +
        '• **Delhi Se Manali (Ladka Tera Diwana)** – a feel-good viral track\n' +
        '• **Kashish** – featuring Ashish Bhatia, Omkar Singh\n' +
        '• **Hanuman Chalisa** – by Shankar Mahadevan, still strong\n' +
        '• **Dilruba Dilnasheen** – a fresh romantic release' },
    ];

    const first = resolveReferencedQuery('play them', trending);
    assert.equal(first.kind, 'search');
    assert.equal((first as { query: string }).query, 'Delhi Se Manali (Ladka Tera Diwana)');

    const second = resolveReferencedQuery('play the second one', trending);
    assert.equal(second.kind, 'search');
    assert.equal((second as { query: string }).query, 'Kashish');

    const last = resolveReferencedQuery('play the last one', trending);
    assert.equal((last as { query: string }).query, 'Dilruba Dilnasheen');

    // Exact YouTube URL referenced by the assistant → play that exact video
    const withUrl = [
      { role: 'user', content: 'play sapphire' },
      { role: 'assistant', content: "Here's Ed Sheeran's **Sapphire** official music video:\nhttps://www.youtube.com/watch?v=JgDNFQ2RaLQ 🎵" },
    ];
    const direct = resolveReferencedQuery('play it', withUrl);
    assert.deepEqual(direct, { kind: 'direct', videoId: 'JgDNFQ2RaLQ', reason: 'video the assistant referenced' });

    // Anaphora without any history → stays usable, never crashes
    const orphan = resolveReferencedQuery('play them', []);
    assert.equal(orphan.kind, 'search');

    // Normal explicit queries are untouched
    assert.deepEqual(resolveReferencedQuery('despacito', trending), { kind: 'search', query: 'despacito', reason: 'explicit query' });

    // Fallback: no list in assistant message → most recent user topic
    const noList = [
      { role: 'user', content: 'search for some trending hindi songs' },
      { role: 'assistant', content: 'Trending Hindi songs are booming on Spotify right now.' },
    ];
    const topic = resolveReferencedQuery('play them', noList);
    assert.equal((topic as { query: string }).query.toLowerCase(), 'trending hindi songs');

    // executeSohamTool end-to-end: history flows into the play tool
    globalThis.fetch = (async () => new Response('fetch failed', { status: 502 })) as typeof fetch;
    try {
      const tool = await executeSohamTool('play them', trending);
      assert.equal(tool?.tool, 'play_video');
      assert.ok(tool?.openUrl?.includes(encodeURIComponent('Delhi Se Manali')), `must resolve to the listed song, got: ${tool?.openUrl}`);
      assert.equal(tool?.ok, false, 'offline sandbox — must fail gracefully with the resolved search URL');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log('youtube-play checks passed ✔');
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
