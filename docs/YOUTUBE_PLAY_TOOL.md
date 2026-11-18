# YouTube Play Tool — Design & Weakness Analysis

Status: implemented · Branch: `arena/c8008f16-soham-backend` · Owner: backend

## What it does

`play <query>` → resolves the **first real video** on YouTube for what the user
asked to watch, and hands the client both playback URLs:

```
user message ──▶ extractPlayQuery() ──▶ buildYouTubeSearchUrl()
                                          https://www.youtube.com/results?search_query=<enc>
                                                │
                                    ┌───────────▼────────────┐
                                    │ Jina Reader (primary)  │  r.jina.ai/<searchUrl>
                                    └───────────┬────────────┘
                                          empty │ fail
                                    ┌───────────▼────────────┐
                                    │ Firecrawl scrape       │  POST /v1/scrape (markdown)
                                    └───────────┬────────────┘
                                                ▼
                              parseYouTubeSearchMarkdown()  → candidates[] (page order, deduped)
                                                ▼
                        pick candidates[0] → watchUrl (tab fallback) + embedUrl (iframe)
```

- Module: `tools/youtube-play.ts` — no Express dependencies, unit-testable.
- Route: `POST /api/ai/play-video` (`routes/ai/play-video.ts`) — body
  `{ query }` or `{ message }`. Returns `embedUrl` + `playback.openInTab`
  (watch URL) so the chat page can `<iframe>` the result and fall back to a tab.
- Chat wiring: `detectToolIntent` / `executeSohamTool` (`tools/agent-tools.ts`)
  registers the `play_video` tool; `/api/chat` responses carry the full result
  in `toolsUsed[]`, and `/api/chat/stream` emits a `{ type: 'play', … }` SSE
  event before the model finishes.
- Groq local function calling: `play_youtube` in `adapters/groq-adapter.ts`
  (requires `settings.enableLocalToolCalling: true`).

### Client recipe (frontend, not in this repo)

1. Listen for `type: 'play'` (SSE) or read `toolsUsed[].embedUrl` (JSON chat).
2. Render `<iframe src=embedUrl allow="autoplay; encrypted-media" allowfullscreen>`.
3. Always render an **Open on YouTube** button → `window.open(openUrl, '_blank')`.
   YouTube blocks embedding per-video (owner setting, age gate, region) and the
   iframe fails **silently** cross-origin — there is no reliable `onerror`. Do
   not hide the fallback link behind an error handler that never fires.
4. Optional pre-check: `https://www.youtube.com/oembed?url=<watchUrl>&format=json`
   (no key, but rate-limited; returns 4xx for deleted/private videos).

## The SOHAM_CLOCK pitfall (why "play X" used to produce news garbage)

The chat frontend appends a hidden `SOHAM_CLOCK … Never guess it.` block to the
outgoing `message`. Before the `utils/clean-message.ts#stripInjectedContext`
fix, that whole blob flowed into intent detection and the search pipeline:

- the single-line `play` regex silently failed on multi-line input,
- `\btoday\b` in the clock text forced `news` classification, and
- the YouTube/search query included 150 chars of timezone salad.

Mitigation: every internal layer (intent detection, tool routing, query
analysis, RAG/memory/knowledge lookups, realtime fetch) now sees only the
stripped user text. The **model prompt keeps the original blob** — the clock is
for the model. If the frontend changes the clock format, update
`stripInjectedContext` accordingly.

Also: set `JINA_API_KEY` in the deployment. Keyless `r.jina.ai` works but is a
shared, aggressively rate-limited pool — the play tool is Jina-primary, so a
missing/limited key is the difference between instant playback and a timeout.

## Weaknesses of this approach (read before relying on it)

This is, fundamentally, **scraping YouTube's search page through a third-party
reader because we don't have the YouTube Data API wired up**. Every weakness
below follows from that choice.

### 1. Fragile by construction — structure, not API
- No stability contract. YouTube can change its markup, its consent interstitial,
  or its anti-bot heuristics at any time; Jina/Firecrawl then return
  consent-wall/JS-required/app-shell pages and the parser yields 0 candidates.
  Detection is a 40-char body check + regex — it fails *open* into a confusing
  "no playable video" instead of a clean error.
- Parser accepts any `watch?v=` match; it cannot tell an organic result from an
  **ad with a video? no — ads have no watch URLs**, but it *can* pick up promoted
  "video ads in the mix" card links, Shorts carousels (mitigated: we prefer
  non-Short URLs), and timestamp junk. Page order ≈ YouTube's ranking **for an
  anonymous, logged-out, region-pinned client** — not the user's account.

### 2. First-result ≠ "most appropriate"
- No ranking signals are used (views, recency, channel authority, duration,
  live-vs-premiere, availability). "taylor swift" wants the artist's channel;
  the first hit may be a re-upload, a cover, a reaction, or a 10-hour loop.
- No freshness control (`sp=` filters): news/trailer queries get evergreen hits.
- No confirmation/disambiguation UX beyond the `candidates[]` escape hatch, which
  the client must implement (it isn't automatic).

### 3. Embedding is unreliable and its failures are invisible
- Embedding is disabled per-video (owner toggle, age-restriction, music label
  restrictions) and for accounts/regions. **The iframe cannot report this.**
  The client must always offer the tab fallback; the backend cannot guarantee
  a playable embedded player, only a watch URL.
- Autoplay with sound is blocked by browsers; voice "play X" lands on a paused
  page unless the client requests `autoplay=1&mute=0` off a user gesture
  (autoplay-policy compliance) or accepts a muted autoplay.
- Mobile deep-linking (`vnd.youtube:` / `intent:`) is out of scope here.

### 4. Double dependency — SOHAM → reader → YouTube
- SOHAM's playback breaks when **either** Jina/Firecrawl or YouTube breaks.
  Keyless `r.jina.ai` is a shared, aggressively rate-limited pool
  (`JINA_API_KEY` strongly recommended); Firecrawl costs quota per scrape.
- Latency is 1–2 outbound round-trips (typically 3–15 s) — too slow to feel
  instant for voice. The 5-min cache helps repeats but not first plays, and
  cached entries rot when videos are deleted/privated (embeds go dead until TTL).
- On failure we still return `searchUrl`, so the UX degrades to "here's the
  YouTube search page" — useful, but admits the tool did nothing.

### 5. Legal / ToS exposure
- Automated access to YouTube search results via a proxy sits against the
  YouTube Terms of Service (scraping clause) and the readers' own ToS; a traffic
  spike looks like bot behavior and can get the proxy's egress IPs (or yours)
  throttled/blocked, breaking the tool for everyone running it.
- The sanctioned path is **YouTube Data API v3** (`search.list` + `videos.list`
  for `embeddable`/`status`), ~100 units/call against 10,000 units/day free —
  far more stable, quota-visible, and explicitly embeddable-filtered. Its downside:
  requires a Google API key and returns IDs rather than rendered results.

### 6. Security & privacy
- **The user's query leaves the building** — to r.jina.ai and/or Firecrawl, and
  from there to YouTube's servers. "Play" queries can reveal health, religion,
  sexuality, politics. Nothing here redacts; document this or expect users to
  notice in network logs.
- Fetched page text is **untrusted input**. In this design we never feed it to
  an LLM (good for prompt injection), but the parsed *title* is returned to the
  client — the chat UI must render it as text, not HTML (XSS via video title).
- The query is URL-encoded into the search URL (injection into the URL path is
  not possible), but we still pass raw markdown through the parser — no
  `eval`-style sinks exist, keep it that way.

### 7. Correctness gaps in intent detection
- `play` is overloaded: "play dead", "play smart", "play it again", sports
  (`play cricket final` — guarded), games ("play Wordle" — arguably fine as a
  video result, arguably not). False positives open YouTube for requests that
  weren't about video.
- Hinglish playback verbs (`baja`, `chalao`, `dikhao`) are not recognized —
  voice users in Hindi will miss the tool entirely.
- `extractPlayQuery` strips trailing "on youtube" but not "song/video" markers,
  quotes, or "official" modifiers — usually harmless for search, occasionally
  skews results (e.g. everything gains "official").
- Shorts are only a fallback (no `/watch?v=` hit) — "play the short about X"
  still gets a long-form video if one exists.

### 8. Operational gaps
- No per-user rate limit beyond the global `/api` limiter; each play costs
  money (Firecrawl) and quota (Jina). A loop of voice activations drains both.
- No metrics on resolve rate (Jina-vs-Firecrawl win rate, parse-empty rate) —
  when YouTube changes markup, we fly blind. Add counters before production.
- No negative-result caching beyond "failures aren't cached" — a query that
  consistently parses to zero hammers both upstreams every time.
- Cache key is just the normalized query — different users get each other's
  first result (acceptable for search, worth noting for future personalization).

### 9. What "correct" looks like (recommended follow-ups)
1. **YouTube Data API v3** primary path (embeddable + status filter), scrape as
   last resort — cuts fragility and ToS risk to near zero.
2. **oEmbed existence/embeddability check** at play time (cheap 404 detector).
3. **oEmbed + `videos.list` embeddable** gate so we never serve a dead iframe.
4. **Duration/freshness heuristics** on candidates (e.g. prefer `>1 min`,
   recency for news-y queries) — cheap ranking win over pure page order.
5. **Client-side "second result" button** wired to `candidates[1]` — costs zero
   extra upstream calls (candidates are already returned).
6. **Play Hindi/Indic playback verbs** in the intent grammar.
7. **Metrics**: `soham_play_resolve_{ok,fail,empty}_total{source}`.

## Response contract (for client authors)

`POST /api/ai/play-video` → 200 always (except 400/5xx):

```json
{
  "success": true, "ok": true, "tool": "play_video",
  "query": "lofi hip hop radio",
  "videoId": "5qap5aO4i9A",
  "title": "lofi hip hop radio 📚 beats to relax/study to",
  "channel": "Lofi Girl",
  "watchUrl": "https://www.youtube.com/watch?v=5qap5aO4i9A",
  "embedUrl": "https://www.youtube.com/embed/5qap5aO4i9A",
  "thumbnailUrl": "https://i.ytimg.com/vi/5qap5aO4i9A/hqdefault.jpg",
  "searchUrl": "https://www.youtube.com/results?search_query=lofi%20hip%20hop%20radio",
  "source": "jina", "searchTimeMs": 8421,
  "candidates": [{ "videoId": "…", "title": "…", "watchUrl": "…", "embedUrl": "…" }],
  "playback": { "preferred": "embed", "embedUrl": "…",
                "fallback": "open_in_tab", "openInTab": "…" }
}
```

On failure: `ok: false`, `candidates: []`, `playback.openInTab` = the YouTube
**search** URL (still useful), `error` explains why.

`/api/chat` returns the same data under `toolsUsed[]` (`tool: 'play_video'`);
`/api/chat/stream` emits a `play` SSE event with the same fields.
