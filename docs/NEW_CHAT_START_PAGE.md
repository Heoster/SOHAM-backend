# New chat start page — minimal & clean (proposed)

> Reference mock: `docs/mocks/new-chat.html` (open in a browser — it is
> self-contained, ~15 KB, no build step). Frontend lives outside this repo, so
> this file describes exactly what to build there. Everything is additive;
> no backend change is required.

## Why the current one feels "full"

A new-chat screen earns attention only if it offers **one** clear action.
Clutter usually comes from: hero artwork, gradient blobs, feature grids,
stats/testimonials, six-plus prompt cards, loud CTAs, and competing colors.
The fix is removal + hierarchy, not more styling.

## The 8 moves

1. **One column, centered.** Max 640 px content width, everything left-aligned
   inside it except the kicker/headline (which are centered).
2. **Kicker, not banner.** A tiny uppercase line with the date —
   `TUESDAY · 19 NOVEMBER` (Letter-spacing .18em, 10.5px, muted).
3. **Serif headline, one breath.** Fraunces Light, 28–40px:
   `Where should we begin, <name>?` — italic accent word in terracotta.
   Body font stays Inter (UI) — two families maximum.
4. **Composer is the only raised element.** 640px, 16px radius, single
   shadow; focus = 3px soft terracotta ring. Placeholder `Ask SOHAM anything…`.
   Left: attach · mic. Right: filled terracotta circle with ↑. Below, a hairline
   divider with a meta row: `● Memory on · private by default` left,
   `/ commands · ⌘K focus` right (kbd chips).
5. **Suggestions: exactly 4, one row.** Rounded-full chips, hairline border,
   no fill. Each chip exercises a *real* backend capability (they map 1:1 to
   working tools): Play, News, Chart, Creative. Wrap to 2 rows on mobile,
   hide 4th+ below 640px.
6. **One capability note, 11px, muted** — `web search · YouTube · charts ·
   memory · weather` — teaches without selling.
7. **Chrome recedes.** Top bar 56px, wordmark-only (no logo artwork), three
   quiet icons (search ⌘K, settings, avatar). Footer 46px, one left line
   ("SOHAM answers with its sources. How it works"), right: Privacy /
   Shortcuts / Feedback.
8. **Texture, not decoration.** Background = near-white paper (`#FAFAF7`) +
   48px/1.3px dot grid at 5.5% opacity + a single 6% terracotta radial glow
   at top. One glow, never more. Dark mode included via `prefers-color-scheme`.

## Remove list (from the old page)

- Hero illustrations/gradient washes · any emoji bigger than 13px
- $"Try asking"$ card grids > 4 or multi-row prompt walls
- Buttons fighting the composer for attention · duplicate CTAs
- Feature badges/stats below the fold · drop shadows on everything

## Tokens (both themes)

| Token | Light | Dark |
|---|---|---|
| bg | `#FAFAF7` | `#131311` |
| card | `#FFFFFF` | `#1B1B18` |
| ink / ink-2 / ink-3 | `#1A1A17 / #57534E / #A8A29C` | `#EDEDE6 / #A8A29C / #6E6A64` |
| accent | `#C2410C` (terracotta) | `#E8915A` |
| accent-soft (focus) | `rgba(194,65,12,.10)` | `rgba(232,145,90,.14)` |
| ok (memory dot) | `#16A34A` | `#34D399` |
| hairline | `ink @ 10%` | `ink @ 12%` |
| radius | 16px card / 999px chips | same |
| font | Fraunces (display) + Inter (UI) | same |

## States & details

- Composer focus: ring + border fades out; send button at `scale(1.07)` on hover
- Empty send: disabled at 35% opacity
- `prefers-reduced-motion`: transitions off
- `:focus-visible` outlines everywhere (2px accent, 2px offset)
- Date kicker is **client-local** date; greeting name from the profile endpoint
- Chips route to the corresponding tool flows (play/search/chart/creative)

## Responsive

- `≤640px`: hide capability note, footer right links, and chips 4+;
  headline 27px; wordmark suffix hidden
- `≥1440px`: consider the optional 280px sources rail from `UI_CHANGES_REQUIRED.md` —
  the page stays centered, rail collapsible

## Acceptance checklist

- [ ] 5-second test: one glance → knows it's a chat box, ready to type
- [ ] No more than one shadowed element on screen
- [ ] No color used for decoration only
- [ ] Composer autofocused (desktop only), full-width on mobile
- [ ] Renders flawlessly at 375px, 768px, 1440px, and in dark mode
