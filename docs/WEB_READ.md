# `web_read` — the page-reading primitive

SOHAM never answers from a snippet. `web_read` is the tool that reads **one
explicit page, in full** — it is the grounding primitive the whole agent loop
stands on, and the difference between "I think the docs say…" and "the page
says, verbatim."

## Why it is a main part

- **It is the only tool that opens exactly one URL.** `web_search` *enriches*
  its top-3 results with full page text; `web_read` is for "read THIS page."
- **It makes "summarize this link" impossible to hallucinate** — either the
  real page text is retrieved and injected, or the model is explicitly told
  the lookup failed. There is no third outcome.
- **The same engine serves three call sites**: `web_read` (this doc),
  `web_search`'s read-the-top-3 enrichment, and YouTube transcript/search
  parsing (`tools/youtube-play.ts`). Fix one bug, all three benefit.
- **It never throws.** Every failure resolves to a structured `ok:false`
  result the model is instructed to report, not paper over.

## When it runs

| Path | How `web_read` is selected |
|---|---|
| Planner (normal) | Manifest: `Read one specific page URL in full` → `when: the user pastes/links a URL or asks about a specific page` (`core/soham-agent.ts`). The worthiness gate routes any message containing a URL straight to the planner (`isPlannerWorthy` — URLs ⇒ worthy). |
| Planner failure / kill-switch | Regex fallback: any message containing an explicit `http(s)://` URL that no other tool claimed ⇒ `web_read`. Lowest priority by design — specific skills (translate/grammar/…) keep their messages, and `play https://youtube.com/…` stays on the play path. `SOHAM_AGENT_DISABLED=1` still gets page reading. |
| Not for the same topic | The planner is instructed that `web_search` already *reads* the top-3 pages — `web_read` is **only** for explicit page URLs. No duplicate reads in one plan. |

## End-to-end flow

```
"summarize https://example.com/article"
        │
        ▼
routes/chat-stream.ts · routes/chat-impl.ts
  stripInjectedContext() → userMessage
  isPlannerWorthy()? URL ⇒ yes → planToolCalls()   (10s cap, strict JSON)
        │  (planner failure → detectToolIntent regex → web_read)
        ▼
plan = { tools:[{ tool:"web_read", args:{ query:"…https://example.com/article…" }, why:"…" }] }
        ▼
executeAgentPlan()  — parallel with any other planned tools
  runToolByName('web_read', query, history)     (tools/agent-tools.ts)
        ▼
webReadTool(query, history)
  1. URL from the query itself (https?://[^\s)<>\]]+)
  2. else scan `history` NEWEST → OLDEST for a URL (a bare "read it" follow-up)
  3. else fail-fast: ok:false "No URL found…"        (no fetch happens)
  4. readWebPage(url, 1800)                        (tools/page-reader.ts)
        ▼
readWebPage(url, maxChars=1800) — never throws
  guard: only http(s) URLs are fetched
  ┌─ PRIMARY  Jina Reader   GET https://r.jina.ai/<url>
  │     headers: Accept: text/plain  (+ Authorization: Bearer JINA_API_KEY if set)
  │     abort: 9s · trim · cap 1800 chars
  │     ≥80 chars ⇒ return { text, via:"jina" }
  ├─ FALLBACK Firecrawl     POST https://api.firecrawl.dev/v1/scrape
  │     body: { url, formats:["markdown"], onlyMainContent:true, timeout:8000 }
  │     needs FIRECRAWL_API_KEY · abort: 9s · cap 1800
  │     ≥80 chars ⇒ return { text, via:"firecrawl" }
  └─ else return { text:"" }                       (both failed / too thin)
        ▼
webReadTool returns SohamToolResult:
  ok:true  → output: "Full page content of <url> (via <jina|firecrawl> —
             this is the REAL page text):\n\n<text>"   (≈1,930 chars max)
             sources: [{ title:url, url }]
  ok:false → output: "Could not read <url> — the page is unreachable or
             blocked. Never invent its contents."  (+ sources; model must not invent)
  logged:  console.log(`[WebRead] page read via …`) / console.warn(…)
        ▼
executeAgentPlan
  · 30s cap per tool (this tool: ~9s worst case) · allSettled isolation
  · output hard-capped at 2,200 chars (body is pre-capped at 1,800)
        ▼
core/orchestrator.ts — LAYER 1 (tool results)
  block: "Current data (web_read):\n<output>"  cap 4,000 chars
  total injected context still bounded by MAX_CONTEXT_CHARS (truncation warns)
  prompt wrapper: "Background context (use naturally — do NOT cite … )"
        ▼
Synthesis (streamed SSE via chat-stream.ts / JSON via chat-impl.ts)
  SSE status event: "Using: web_read…"   (before tokens)
  no dedicated `web_read` SSE event — same contract as every tool
  on ok:false the prompt carries the failure marker; the model says so
        ▼
Post-processing (unchanged)
  persistSohamMemory(…) · extractLongTermMemoriesAsync only when
  agentMemoryExtract ≠ false (planner-gated) · triggerAutoLearnAsync
```

## Failure contract (never throws, every step isolated)

| Failure | Result |
|---|---|
| No URL in message **and** none in history | `ok:false` — "No URL found…" (no network call at all) |
| Non-http(s) URL | `{ text:"" }` → `ok:false` |
| Jina errors / <80 chars after cap | falls through to Firecrawl |
| Firecrawl errors / no key / <80 chars | `ok:false` — "unreachable or blocked…" |
| Page is a JS app / bot-walled | Jina usually still returns markdown; if <80 chars → `ok:false` |
| Tool exceeds 30s (can't happen: 9s×2 worst case) | `executeAgentPlan` resolves `ok:false` "timed out" |
| Planner dies mid-orchestration | whole plan falls back to regex path; regex path serves `web_read` for explicit URLs |

The 80-char minimum is the garbage guard — a stub page must not be injected
and treated as evidence.

## The shared engine (`tools/page-reader.ts`)

| Export | Used by | Limits |
|---|---|---|
| `readWebPage(url, maxChars)` | `web_read` (1,800 chars) | one page, Jina→Firecrawl |
| `readTopPages(urls, topN, maxChars)` | `web_search` enrichment (3 pages × 1,500), YouTube fallbacks | parallel, failures omitted |

⚠️ Deliberate gate, not an oversight to "fix" casually: `enrichWithFullContent`
only enriches when `JINA_API_KEY` **or** `FIRECRAWL_API_KEY` is set. Jina is
keyless-capable, but enabling keyless reads there adds 3 external fetches (and
rate-limit + latency risk) to *every* `web_search`. Flip it in
`tools/search-engine.ts` only with that cost accepted.

## Tuning knobs & env

| Knob / env | Default | Meaning |
|---|---|---|
| `JINA_API_KEY` | unset | optional; raises Jina rate limits (works without, rate-limited) |
| `FIRECRAWL_API_KEY` | unset | optional; enables the markdown fallback (without it, fallback is a no-op) |
| read cap (`webReadTool`) | 1,800 chars | body injected into context |
| executor cap (`RESULT_OUTPUT_CAP`) | 2,200 chars | hard cap after header |
| L1 block cap (`MAX_BLOCK_CHARS`) | 4,000 chars | per-tool context block |
| Jina/Firecrawl timeout | 9s | per reader attempt |
| tool timeout (`TOOL_TIMEOUT_MS`) | 30s | per planned step |

## Observability

- chat-stream: `status: "Using: web_read…"` before tokens; tools-used summary
  in the final `done` log line.
- chat-impl: `toolsUsed[]` (full `SohamToolResult`s) in the JSON response.
- `[WebRead] page read via jina|firecrawl (N chars) — <url>` /
  `[WebRead] page unreadable …` on stdout/logs.
- Orchestrator surfaces `agentTools: ['web_read', …]`, `agentPlannedBy`.

## Known gaps / follow-ups

- `sources` from `web_read` are **not forwarded to the HTTP client** (only
  `play_video`'s sources reach the UI, via the `play` event). Citation display
  is a frontend/UI contract item — see `docs/UI_CHANGES_REQUIRED.md` (pending).
- JS-heavy SPAs may yield thin Jina markdown → `ok:false` by design (see
  80-char guard). Firecrawl (with key) renders JS — that's what it's for.
- `web_read` + very large pages: only the first 1,800 chars reach the model.
  Fine for articles; for "analyze my 40-page PDF" the Document RAG layer is the
  right tool (`stripChunkIds`, uploaded docs), not `web_read`.
- Regex fallback classifies *any* URL-bearing message without another tool
  claim — intentional, but it means "here's the link" without a verb reads the
  page rather than asking what to do with it. That is the desired default.

## Example (planner path)

```
User:  summarize https://docs.python.org/3/tutorial/datastructures.html
Plan:  {"tools":[{"tool":"web_read","args":{"query":"https://docs.python.org/3/tutorial/datastructures.html"},"why":"user asked for a specific page"}],"memory_extract":false}
Read:  [WebRead] page read via jina (1791 chars)
Block: Current data (web_read):
       Full page content of https://… (via jina — this is the REAL page text):
       …
Model: "That tutorial covers lists, stacks/queues via collections.deque, …"
```

## Example (rollback path — `SOHAM_AGENT_DISABLED=1`)

```
User:  read this: https://example.com
→ detectToolIntent: no specific skill matches, URL present ⇒ web_read
→ identical read/inject/synthesize flow; planner never involved
```
