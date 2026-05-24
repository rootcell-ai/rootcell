# SPY-QA-22 RCA: Request Composition Clips At Normal Browser Width

## Scope

This RCA covers the highest-priority open spy bug in the current tree:
`SPY-QA-22`.

Triage notes:

- `PLAN.md` marks all P0 and P1 spy bugs complete or closed.
- `PLAN.md:976-978` lists `SPY-QA-22` as the first unchecked item in the
  prioritized handoff, and it is a P2 issue.
- Later unchecked P2/P3 items are lower in the handoff order.
- This document was written before any product-code fix for `SPY-QA-22`.

## Bug Definition

`PLAN.md:976-978` defines the current bug:

```text
[P2] SPY-QA-22: Make request composition responsive. Provider usage and
cache read/write suffixes truncate, and the section table clips horizontally
at the normal in-app browser width.
```

`PLAN.md:1024-1027` adds the evidence note:

```text
Request composition has correct provider usage text in the DOM, but
the visible cache read/write suffix can truncate at normal desktop width. The
section table is also wider than its visible card without a responsive
treatment.
```

## Reproduction Used

I started the current spy UI and used headless Chromium with mocked same-origin
API responses. The mocked call uses provider usage values matching recent QA
examples: `inputTokens: 10`, `outputTokens: 105`, `cacheReadTokens: 5281`, and
`cacheWriteTokens: 79`.

Commands used:

```sh
bun run dev:spy-ui -- --port 4788
node --input-type=module '<Playwright probe>'
```

The probe loaded `http://127.0.0.1:4788/?preset=today` with an 1100 x 850
viewport, waited for `data-testid="request-composition"`, and measured the
rendered DOM widths for the Provider usage metric and section table.

## Runtime Proof

The current tree produced this output before any product-code fix:

```json
{
  "viewport": {
    "width": 1100,
    "height": 850
  },
  "inspectorClientWidth": 580,
  "cardClientWidth": 538,
  "cardRectWidth": 540,
  "providerUsageMetric": {
    "label": "Provider usage",
    "parentClientWidth": 115,
    "valueText": "5.5k tok",
    "valueClientWidth": 115,
    "valueScrollWidth": 115,
    "detailText": "in 10 · out 105 · cache 5,281/79",
    "detailClientWidth": 115,
    "detailScrollWidth": 176
  },
  "cacheMarkersMetric": {
    "label": "Cache markers",
    "parentClientWidth": 115,
    "valueText": "2 · 0 B",
    "valueClientWidth": 115,
    "valueScrollWidth": 115,
    "detailText": "0 chars",
    "detailClientWidth": 115,
    "detailScrollWidth": 115
  },
  "table": {
    "text": "SectionStateMessagesBlocksCharsBytesProvider Envelopepresent111,0001.1 KiBHarness System Contextpresent121,1111.2 KiBUser Visible Messagepresent131,2221.4 KiBPr",
    "clientWidth": 504,
    "scrollWidth": 594,
    "overflowX": "hidden",
    "rectWidth": 506,
    "headerScrollWidth": 594,
    "lastRowScrollWidth": 594
  }
}
```

This proves both reported symptoms:

- The Provider usage detail text is in the DOM, but the visible cell has only
  115 px while the text needs 176 px. Because the detail line uses `truncate`,
  the cache read/write suffix is visually cut off.
- The section table needs 594 px but sits inside a 504 px clipped container with
  `overflow-x: hidden`, so the right side of the table is hidden rather than
  reflowed or made reachable.

## Source Evidence

`src/spy/ui/src/App.tsx:546` fixes the page body to two columns:
`minmax(520px,44vw)` for the timeline and `minmax(0,1fr)` for the inspector.
At an 1100 px viewport this leaves the inspector at about 580 px before
inspector padding and card padding.

`src/spy/ui/src/App.tsx:1164-1188` renders the Request Composition metrics in a
fixed four-column grid:

- The rendered card content width was 538 px.
- Four metric columns plus gaps leave about 115 px per metric in the repro.
- `Provider usage` carries the longest detail string because it combines input,
  output, cache read, and cache write into one line.

`src/spy/ui/src/App.tsx:1223-1226` makes every composition metric label, value,
and detail line `truncate`, so any text wider than the metric cell is silently
ellipsized.

`src/spy/ui/src/App.tsx:1191-1201` renders the section table inside
`overflow-hidden` and uses the same fixed grid tracks for the header and rows:

```text
minmax(150px,1fr) 72px 72px 72px 88px 88px
```

With column gaps and horizontal padding, that layout requires about 594 px in
the repro. The visible clipped container was only 504 px.

## Root Cause

`SPY-QA-22` is a responsive layout bug in `RequestCompositionPanel`.

The panel assumes desktop-wide inspector space even though the app reserves a
minimum 520 px for the timeline. At normal in-app browser widths, the inspector
and card are too narrow for:

- a four-column metric grid containing the long Provider usage detail string;
- a six-column section table with fixed numeric column widths.

The current CSS then hides the overflow instead of adapting it. Metric details
are truncated by design, and the section table is clipped by `overflow-hidden`.
The API data is not the root cause: the proof shows the full Provider usage
text exists in the DOM.

## Proposed Fix

Fix `SPY-QA-22` in `src/spy/ui/src/App.tsx`:

- Change the composition metric grid from fixed `grid-cols-4` to responsive
  columns that reduce to two columns at normal inspector widths.
- Let the Provider usage metric span more horizontal space when needed, or split
  cache read/write into visible submetrics instead of one long truncating
  suffix.
- Remove `truncate` from composition metric detail text where wrapping is the
  better behavior, while keeping labels compact.
- Replace the clipped section table with a responsive treatment:
  - either a horizontally scrollable table with visible/reachable overflow, or
  - a card/list layout at narrow inspector widths.
- Add Playwright coverage at an 1100 px viewport proving:
  - Provider usage detail is not truncated (`scrollWidth <= clientWidth`, or the
    information wraps visibly);
  - the section table no longer has hidden horizontal clipping
    (`overflow-x` is not `hidden` when `scrollWidth > clientWidth`, or the table
    reflows so `scrollWidth <= clientWidth`).

## Fix Status

Implemented on 2026-05-24.

Changed `src/spy/ui/src/App.tsx` so the Request Composition panel adapts at the
normal in-app browser width:

- Composition metrics now use two columns below `xl` and four columns on wider
  screens.
- Metric values and details can wrap instead of being forcibly truncated.
- Provider usage has a stable `data-testid` so the visible cache read/write
  detail can be measured directly.
- The section table no longer uses `overflow-hidden`; its grid tracks were
  narrowed so the table fits the inspector card at the reproduced 1100 px
  viewport, with horizontal auto-scroll as a fallback below that width.

Added Playwright coverage in `src/spy/ui/e2e/spy-ui.playwright.ts` proving that,
at an 1100 x 850 viewport, the Provider usage detail text is present and no
longer overflows its visible width, and the section table no longer has hidden
horizontal clipping.

Focused post-fix regression:

```sh
./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts -g "keeps request composition"
```

Result:

```text
1 passed
```

Built-app browser sanity check after the fix:

```json
{
  "viewport": {
    "height": 720,
    "width": 1280
  },
  "inspectorClientWidth": 702,
  "cardClientWidth": 660,
  "usageText": "in 1,253 · out 8 · cache -/-",
  "usageClientWidth": 145,
  "usageScrollWidth": 145,
  "tableClientWidth": 626,
  "tableScrollWidth": 626,
  "tableOverflowX": "auto"
}
```

Verification run:

- `bun run build:spy-ui`
- `bun run typecheck`
- `bun run lint`
- `bun run test:spy-ui:unit`
- `./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts -g "keeps request composition"`
- `./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts`
