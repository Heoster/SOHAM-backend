# SOHAM chat UI — required changes

Two parts: **A)** the backend contract you must consume (SSE additions + JSON
additions), **B)** the design changes that make the chat look professional.
Frontend lives outside this repo; everything here is additive and
backward-compatible — old clients keep working.

---

## A. Backend contract changes (PR: arena/ee912239-soham-backend)

### A.1 New SSE event — `sources` (the big one: research URLs in chat)

Sent **once per turn**, after context settles and before tokens, only when at
least one tool returned sources. Emitted for `web_search`, `web_read`,
`wikipedia`, `news_search`, `fact_check`, `finance_search`, `sports_search`,
`weather_search`, `play_video` (tool-tagged; skip `play_video` in the
citations bar — it has its own card).

```json
data: { "type": "sources",
        "sources": [ { "title": "Tavily — …", "url": "https://…", "tool": "web_search" } ] }
```

- Already **deduped by URL**, `http(s)`-only, tool-tagged, **capped at 12**,
  titles trimmed to 200 chars (empty title falls back to the URL).
- Play URLs appear with `tool: "play_video"` — recommended: skip them in the
  citations list (the play card covers them).
- Render: see B.6 (citations under the answer).

### A.2 Extended `done` event

```json
data: { "type": "done", "modelUsed": "…", "autoRouted": false,
        "agentTools": ["web_search", "wikipedia"],   // [] for plain chat / fallback
        "agentPlannedBy": "model",                   // 'model' | 'fallback'
        "responseTime": "8123ms",
        "degradedLayers": ["documents"]              // only when some layers failed
      }
```

- `agentTools` → optional "used N tools" chip / dev badge (B.7).
- `agentPlannedBy: "fallback"` → **do not surface to users**; dev-mode only.
- `degradedLayers` → tiny amber dot + tooltip "Some live data was unavailable"
  (B.9). Never blocks rendering.

### A.3 Existing event you may have missed — `tools`

`{ "type": "tools", "toolsUsed": ["browser_search"] }` — Groq **builtin** tool
names (strings), when `settings.groqBuiltinTools` are on and invoked. Distinct
from `sources` (that's Groq functions, not research URLs). Optional dev badge.

### A.4 Full SSE contract after this change (reference)

`status` → `token*` (+ `image`? `play`? `sources`?) → `tools`? → `done` | `error`.

| Event   | Purpose                      | Render                       |
|---------|------------------------------|------------------------------|
| status  | stage label ("Thinking…", "Using: web_search…") | shimmer line |
| token   | streamed answer text         | markdown stream (B.4)        |
| image   | generated image / chart SVG  | card (B.8)                   |
| play    | YouTube play result          | iframe card + tab fallback   |
| sources | research URLs (deduped)      | citations list (B.6)         |
| tools   | Groq builtin names           | dev-only badge               |
| done    | modelUsed, autoRouted, agentTools, agentPlannedBy, responseTime, degradedLayers? | meta line (B.7/B.9) |
| error   | fatal error text             | inline error + Retry (B.10)  |

### A.5 JSON route (`POST /api/chat`) additions

Top-level additions alongside existing `toolsUsed`, `imageUrl`, …:

```json
"sources": [ { "title": "…", "url": "https://…", "tool": "web_search" } ],
"agentPlannedBy": "model",
"agentTools": ["web_search"]
```

Use it in non-streaming clients / embeds. `toolsUsed` still carries full
per-tool objects (including nested `sources`) for anything richer.

---

## B. Professional look & feel — the changes to make

Current chat reads as "a textbox that prints text". Professional means: real
messages with anatomy, real typography, citations, and considered states.

### B.1 Layout

- 3-zone grid: **sidebar 280px** (history, New Chat, Settings) | **conversation** | (optional) **sources rail 320px** on ≥1440px.
- Conversation column **max-width 760px** (≈65–72ch), centered, generous gutters.
- Composer docked at the bottom of the conversation zone, not full-window width; floats above a subtle gradient fade of the scrolling content.
- Sidebar collapses < 1024px into an overlay drawer (☰, Esc closes, focus trapped).

### B.2 Design tokens (dark-first; SOHAM brand)

```
--bg:            #0E0F13   (near-black, warm)
--surface:       #15161C   (cards, sidebar)
--surface-2:     #1C1E26   (assistant bubble, code header)
--border:        #23252E   (1px, never pure white)
--text:          #E8E9ED   (body)      --text-dim: #9BA0AC (meta)
--accent:        #6366F1   (indigo-500)  gradient #6366F1 → #8B5CF6 for the send button & active nav only
--accent-soft:   rgba(99,102,241,.14)  (chips, citation hover)
--ok: #34D399   --amber: #FBBF24     --danger: #F87171
--radius: 14px (cards) · 10px (chips) · 999px (pills)
--shadow-card: 0 8px 24px rgba(0,0,0,.35)
--motion: 160ms cubic-bezier(.2,.8,.2,1) (fast, no bounce)
font: Inter (UI) + 13px JetBrains Mono (code) · base 15px / 1.58 line-height
```

Light theme: invert with warm whites (#FAFAF7 bg, #111 text); keep the accent
— never a pure-blue generic theme.

### B.3 Message anatomy

- **Assistant row:** small sun/logo mark (20px, accent), then model id chip
  (`auto-routed → groq/gpt-oss-120b` in dim mono 11px) + latency (`1.2s`), right-aligned actions on hover: **Copy**, **👍**, **👎**, **↻ Regenerate**.
- **User row:** right-aligned bubble `--surface-2`, radius 14px, max-width 78%.
- Streaming caret: 2px accent bar pulsing after the last token; stop ◼ button
  replaces the send button while streaming.
- Timestamp on hover only — permanent timestamps are noise.

### B.4 Markdown, done right

- Render streamed markdown incrementally: bold/italic/headings/lists; tune
  heading sizes **down** (h1 1.15em — chat is not a doc).
- Lists: hanging indents, marker color accent-dim.
- Tables: `--surface` header row, zebra rows, horizontal scroll on overflow,
  13px.
- Blockquotes: 3px accent-left border, dim text.
- **Code blocks:** mac-chrome header bar — language label (mono, dim) + **Copy**
  button right; `#0B0C10` body; JetBrains Mono 13px; no horizontal clip —
  scroll. Inline code: `accent-soft` bg, 0.85em, 6px radius.
- Math: KaTeX if you render LaTeX; else strip `$…$` cleanly. Never raw LaTeX.

### B.5 Streaming states

- While `status` events arrive: a single shimmer line with the stage text
  (`Thinking…`, `Using: web_search, wikipedia…`) — width-animated gradient,
  reduced-motion disables animation.
- First token replaces the shimmer; no spinner-of-doom.
- **Stop** aborts the fetch (`AbortController`) — the partial answer stays.

### B.6 Sources citations (the new event) — render it like a pro

- Under the answer, a slim divider then a **"Sources · N"** toggle line
  (chevron, mono 11px, dim). Expanded: numbered list 1..N.
- Row layout: `[index in accent-soft circle] [favicon 16px] [title — 1 line, truncate] [domain, dim] [↗]`.
  Favicon via `https://www.google.com/s2/favicons?sz=32&domain=<host>` with
  letter-avatar fallback.
- Click row → `window.open(url, '_blank', 'noopener,noreferrer')`.
- **In-text superscript refs** `[1]`..`[N]` are a nicety — only if you map
  tool outputs to sentences deterministically (backend doesn't number claims
  today). Prefer the numbered list; skip fake inline attribution.
- Max 12 rows (backend-enforced); "+N more" link to the raw list when capped.
- Filter: hide `tool === 'play_video'` rows.
- Persist sources per message in local history so old chats still show them.

### B.7 Chips & telemetry (keep it quiet)

- Tool-use chip (optional): 🧩 icon + `agentTools.join(' + ')` — hover shows full names; **never shown for `[]`**.
- Meta line on hover/always-dim: `model · 8.1s`. `autoRouted` may append `auto` in mono dim — not a badge.
- `agentPlannedBy` → dev-mode only.

### B.8 Rich cards (image / chart / play)

- **Image (`image` event, provider ≠ soham-chart):** rounded 14px, provider
  badge bottom-left (`FLUX`/`SDXL`/…) in 10px mono on black/60 backdrop,
  download ⤓ top-right on hover, lightbox on click.
- **Chart (`image/soham-chart` — SVG data URI):** same card; extra **Download
  .svg** button (it *is* an SVG data URI).
- **Play (`play` event):** 16:9 iframe (rounded 14px, `allow="autoplay; encrypted-media"`), below-bar: title + channel (truncate) left; right: **▶ Open in tab** ghost button (`openUrl`) — mandatory fallback since embeds fail on strict networks. `ok:false` → search-results button instead of a broken iframe.
- Never autoplay with sound; `rel=noopener` on all outbound links.

### B.9 Degraded live-data state

If `done.degradedLayers?.length`, render a 3px amber inline strip above the
meta line: `● Some live data was unavailable — answer may be from model
knowledge.` Dismissible, non-blocking, never a modal.

### B.10 Error & empty states

- **Error (`error` event):** inline bubble `--surface-2` with `--danger` left
  border: friendly text + **Retry** (re-sends last user turn) + keep the
  partial text if any. Never a red toast that auto-dismisses.
- **Empty state:** centered SOHAM mark + one-liner ("Ask anything — I can
  search, read pages, play videos, draw charts.") + 4 suggestion chips
  (chip = `--surface-2`, hover accent-soft): `Top news today` ·
  `IPL live score` · `Draw a sunset ` · `Summarize <paste URL>` — clicking
  fills the composer (never auto-sends).
- **Offline:** composer disabled banner `Offline — reconnecting…` with
  exponential backoff; answers already on screen remain readable.

### B.11 Motion & polish

- 160ms ease-out on hover/press; 220ms on overlay drawers; no spring/bounce.
- Scroll-to-bottom button appears after 240px of upward scroll.
- Focus-visible: 2px accent outline, 2px offset — on every interactive element.
- `prefers-reduced-motion: reduce` → kill shimmer/caret pulse/drawer animation.
- Message entrance: 8px translateY + fade, 180ms, once (not while streaming).

### B.12 Accessibility & semantics

- Conversation = `role="log" aria-live="polite"` (streaming announces itself).
- Sources list = `<ol>` with real links; images get `alt` (chart → title; generated → prompt).
- Contrast ≥ 4.5:1 body text in both themes; meta dim ≥ 3:1 and never below 11px.
- Keyboard: `Enter` send · `Shift+Enter` newline · `⌘/Ctrl+K` focus composer ·
  `⌘/Ctrl+/` toggle sidebar · `Esc` close drawer / stop stream.
- Touch targets ≥ 44px on mobile; composer `inputMode="text"` + autogrow to 6 lines.

### B.13 Priority order

| P0 — ship together | B.1 layout · B.2 tokens · B.3 anatomy · B.4 markdown/code blocks · B.5 status shimmer + stop · B.6 sources citations · B.10 error/empty |
|---|---|
| P1 — same week | B.8 rich cards polish · B.7 quiet chips · B.9 degraded strip · B.13 motion pass · keyboard shortcuts |
| P2 — later | sources rail ≥1440px · in-text superscript attribution · KaTeX · light theme toggle · source persistence across reloads |

### B.14 Anti-patterns — do not ship

- Raw unstyled URLs dumped into the bubble text as "sources".
- A permanent "Agent: model/fallback" KPI widget in the header.
- Toast spam for tool calls; auto-opening the sources rail every turn.
- Full-width (window-wide) composer; white bubbles in dark theme; pure `#000` background; layout-shifting "Used 5 tools…" lines that shove text down mid-stream (reserve height).
