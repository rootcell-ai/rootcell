# SPY-QA-01 RCA: Clipped Spy Layout Scroll Containers

## Scope

This RCA covers the highest-priority open spy bug from `PLAN.md`: `SPY-QA-01`.

`PLAN.md` lines 830-833 describe the failure as the two-column page layout letting
`main` hide overflow instead of giving the timeline and inspector their own
reachable scroll containers.

## Reproduction Used

- Built the current UI with `bun run build:spy-ui`.
- Started the fixture-backed spy UI service with:
  `bun run src/spy/ui/test-server.ts --port 4681 --static dist/spy-ui`
- Opened `http://127.0.0.1:4681/?since=0` in the in-app browser.
- Measured layout geometry in a 1280 x 720 viewport after fixture calls loaded.

The fixture server loaded 5 provider-call rows, which was enough to reproduce the
layout bug. This is stronger than the manual QA condition in one respect: the
bug does not require a long Today view or a large live call.

## Proof

Runtime layout measurements from the browser:

```json
{
  "viewport": { "width": 1280, "height": 720 },
  "main": {
    "height": 720,
    "clientHeight": 720,
    "scrollHeight": 912,
    "overflowY": "hidden",
    "scrollTop": 0
  },
  "section": {
    "top": 64,
    "bottom": 720,
    "height": 656,
    "clientHeight": 656,
    "scrollHeight": 848
  },
  "timeline": {
    "top": 265,
    "bottom": 912,
    "height": 647,
    "clientHeight": 647,
    "scrollHeight": 647,
    "maxScrollTop": 0,
    "overflowY": "auto"
  },
  "footer": {
    "top": 855,
    "bottom": 912,
    "height": 57
  }
}
```

Key observations:

- `main` is exactly viewport height (`720`) but its content height is `912`.
- `main` has `overflowY: hidden`, so the extra `192 px` is clipped with no page
  scrollbar.
- The timeline is laid out from y=`265` to y=`912`, so its bottom `192 px` sit
  below the visible viewport.
- The timeline reports `clientHeight == scrollHeight == 647`, so it believes it
  has no internal scroll range (`maxScrollTop: 0`). Scrolling over it cannot
  reveal the clipped rows or footer.
- Row 3 ends at y=`733`, row 4 spans y=`745` to y=`851`, and the footer spans
  y=`855` to y=`912`; all are partly or wholly below the visible viewport bottom
  at y=`720`.

Inspector proof after scrolling the inspector to its maximum scroll position:

```json
{
  "viewport": { "height": 720 },
  "aside": {
    "top": 64,
    "bottom": 912,
    "height": 848,
    "clientHeight": 848,
    "scrollHeight": 3448,
    "scrollTop": 2600,
    "maxScrollTop": 2600
  },
  "lowerSectionsAtMaxScroll": {
    "Stream Events": { "top": 723, "bottom": 767 },
    "Raw Payloads": { "top": 785, "bottom": 829 },
    "Health": { "top": 847, "bottom": 891 }
  }
}
```

At the inspector's maximum scroll position, `Stream Events`, `Raw Payloads`, and
`Health` are still below y=`720`. The aside's own `clientHeight` is `848`, but
only y=`64` through y=`720` is visible. The browser is aligning the bottom of
the inspector content to y=`912`, not to the visible viewport bottom.

## Source Evidence

Relevant current code:

- `src/spy/ui/src/App.tsx:375` sets the page root to
  `h-screen min-h-[720px] overflow-hidden`.
- `src/spy/ui/src/App.tsx:408` sets the content grid to
  `h-[calc(100vh-4rem)] min-h-[656px]`.
- `src/spy/ui/src/App.tsx:409` creates the timeline column as a flex column
  without `min-h-0`.
- `src/spy/ui/src/App.tsx:641` makes the timeline itself `flex-1 overflow-auto`,
  but the parent has already expanded past the visible section.
- `src/spy/ui/src/App.tsx:763` makes the inspector `overflow-auto`, but it is
  also allowed to size taller than the visible grid track.

## Root Cause

The scroll containers are present, but their ancestors are not allowed to shrink
inside the fixed viewport grid.

The combination of viewport-fixed heights, minimum heights, `main` clipping, and
missing `min-h-0` on the grid/flex children causes the timeline column and the
inspector to resolve to content-driven heights. They become `848 px` tall in a
`656 px` visible content area. Because the scroll containers themselves believe
their full `848 px` boxes are visible, they compute the wrong scroll range.

This is why the bug is not merely cosmetic:

- Timeline rows and the footer can exist below the viewport while the timeline
  has no internal scroll range.
- Lower inspector sections can remain below the viewport even when the inspector
  is scrolled to its maximum.
- `main` hides the layout overflow, so the user gets neither a page scrollbar
  nor a correct nested scrollbar.

## Proposed Fix

Rework the app shell so the header and body are explicit viewport rows, and make
the body grid and both columns shrinkable:

- Use a root layout equivalent to `h-screen grid grid-rows-[4rem_minmax(0,1fr)]`
  with `overflow-hidden`.
- Remove the content area's viewport-derived `min-h` that can exceed the visible
  viewport.
- Add `min-h-0` to the content grid, timeline column, timeline scroll region,
  and inspector.
- Keep timeline and inspector as the only vertical scroll owners for their
  respective columns.

Expected proof after the fix:

- The content grid bottom should equal the viewport bottom.
- Timeline and inspector bottoms should be `720` in the same viewport, not `912`.
- Timeline `clientHeight` should reflect the visible space, and rows beyond that
  should be reachable through `timeline.scrollTop`.
- At inspector max scroll, lower sections such as `Health` should be visible
  within the viewport.

## Fix Status

Implemented.

Changed `src/spy/ui/src/App.tsx` so the spy UI shell uses an explicit header row
and shrinkable body row, with `min-h-0` on the body grid, timeline column,
timeline scroll region, and inspector. Added Playwright coverage in
`src/spy/ui/e2e/spy-ui.playwright.ts` for the viewport clipping regression.

Post-fix browser verification at 1280 x 720:

```json
{
  "main": { "clientHeight": 720, "scrollHeight": 720 },
  "timeline": {
    "bottom": 720,
    "clientHeight": 455,
    "scrollHeight": 647,
    "maxScrollTop": 192
  },
  "aside": {
    "bottom": 720,
    "clientHeight": 656,
    "scrollHeight": 3448,
    "maxScrollTop": 2792
  },
  "afterTimelineScroll": {
    "scrollTop": 192,
    "lastRow": { "top": 553, "bottom": 659 }
  },
  "afterInspectorScroll": {
    "scrollTop": 2792,
    "health": { "top": 655, "bottom": 699 }
  }
}
```

Verification commands:

- `bun run typecheck`
- `bun run lint`
- `bun run build:spy-ui`
- `bun run test:spy-ui:unit`
- `bun run test:spy-ui:e2e`
