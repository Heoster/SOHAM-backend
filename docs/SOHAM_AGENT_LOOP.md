# SOHAM Agent Loop — how a user request becomes a perfect answer

SOHAM is a **Self-Organising Hyper-Adaptive Machine**: a request does not
blindly hit one model prompt. A planner model first decides *what the request
needs*, a deterministic executor runs it, and the synthesis model answers from
grounded output.

```
user message (+ last 4 turns)
        │
        ▼
┌───────────────────┐   fences/prose → JSON → zod → known tools only
│ 1. PLAN            │   ≤6 tools · deduped · 10s cap · failure ⇒ regex fallback
│ core/soham-agent.ts│
└───────────────────┘
        │
        ▼            (image_generate → image pipeline; chart → chart pipeline —
┌───────────────────┐   short-circuit in chat-stream / chat-impl)
│ 2. EXECUTE         │   parallel · per-tool 30s cap · allSettled
│ runToolByName()    │   output capped 2,200 chars · failures are ok:false results
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ 3. SYNTHESIZE      │   streamed generation over: grounded tool context +
│ existing chat path │   RAG (docs, memories, profile) + live data + history
└───────────────────┘
```

## web_read deep dive

See `docs/WEB_READ.md` — the page-reading primitive (Jina→Firecrawl), its
end-to-end flow, failure contract, tuning knobs and observability.

## Planner-worthiness gate

Routes (and the planner itself) ask *"is this message worth a planner round
at all?"* before spending a model call: pure pleasantries/acknowledgements
("hi", "good morning how are you", "thanks so much", "ok", "👋") skip the
model entirely and receive the correct verdict for free — zero tools,
`memory_extract:false`. Anything containing a URL, a digit, or any
non-pleasantry word goes to the planner. See `isPlannerWorthy()` in
`core/soham-agent.ts`; regression-checked in `scripts/test-agent.ts`.

## Why a planner instead of the regex detector?

The old path (`detectToolIntent`) was one regex → one tool → answer. It could
not: pick Wikipedia **and** the web, read a pasted URL, decide a request needs
no tools at all, or handle several needs in one message. The planner chooses
from the same tool registry the regex path uses (`runToolByName`), so both
paths share every implementation.

## Available tools (manifest in `core/soham-agent.ts`)

| group | tools |
|---|---|
| live web | `web_search` (reads top 3 pages — Jina primary, Firecrawl fallback), `web_read` (one URL), `wikipedia`, `news_search` |
| live data | `weather_search`, `sports_search`, `finance_search` |
| skills | `fact_check`, `dictionary`, `translate`, `sentiment`, `grammar`, `quiz`, `recipe`, `joke`, `summarize` |
| media | `play_video` (resolves "them"/"it" from the conversation), `image_generate` (short-circuit), `chart` (deterministic SVG + markdown table) |

Every tool the planner can emit exists in the executor — `test-agent.ts`
asserts manifest ↔ runner parity forever.

## Failure & rollback contract

- Planner timeout / garbage / no models ⇒ **legacy regex tool path** (pre-agent
  behavior, bit-for-bit). Logged as `plannedBy: 'fallback'`.
- `SOHAM_AGENT_DISABLED=1` ⇒ model planner bypassed everywhere (routes skip the planning call too) and the legacy regex tool path runs — ops kill-switch.
- Any single tool failure ⇒ that tool returns `ok:false`; the model still
  answers (it is told the data lookup failed — it will say so, not invent).
- `memory_extract:false` from the planner skips long-term memory extraction
  for greetings/chit-chat; everything else extracts as before.

## Extending

1. Add the implementation (or reuse) in `tools/…`,
2. case it in `runToolByName` (`tools/agent-tools.ts`),
3. add one line to `CAPABILITY_MANIFEST` (`core/soham-agent.ts`),
4. `scripts/test-agent.ts` keeps manifest ↔ executor in sync automatically.

## SSE events (chat-stream)

`status` → `token`* (+ `image`? `play`? `sources`?) → `tools`? → `done` | `error`.

- **`sources`** (new) — `{ type:'sources', sources:[{title,url,tool}] }`:
  research URLs from every tool result, deduped by URL, http(s)-only,
  tool-tagged, capped at 12. Emitted once, after context settles, before
  tokens. UI contract: `docs/UI_CHANGES_REQUIRED.md` §A.1/§B.6.
- **`done`** now also carries `agentTools` (string[]) and `agentPlannedBy`
  (`model`|`fallback`).
- The JSON route returns flattened `sources` + `agentPlannedBy` + `agentTools`
  top-level.

## Observability

`SohamContextResult` now carries `agentPlannedBy` (`model` | `fallback`),
`agentTools` (chosen tools) and `agentMemoryExtract`. Chat logs
`[Agent] …` on planner failure; SSE `status` shows the tools in use; tool
outputs injected into the prompt carry verified-real markers where relevant
(play URLs, read pages).

## Where the plan is used before context

Both chat routes call `planToolCalls()` **once**, then:

1. `image_generate` in a **single-purpose** plan ⇒ image pipeline with the
   planner's prompt (terminal response),
2. `chart` in a **single-purpose** plan ⇒ deterministic chart pipeline
   (terminal response),
3. otherwise ⇒ `buildSohamPromptContext({ …, agentPlan })` executes the whole
   plan in parallel (no second planner call),
4. a chart or image that was part of a **mixed** plan runs inline via the
   agent — the SVG is emitted through the `image` SSE event after context
   settles (and `imageUrl`/`imageProvider` in the JSON route) while the other
   tools' results feed synthesis. Nothing in the plan is silently dropped.
