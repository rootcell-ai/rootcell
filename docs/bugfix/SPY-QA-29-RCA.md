# SPY-QA-29 RCA: Sticky Inspector Header Overlap

This RCA was written before implementation for the highest-priority open spy bug
in the current tree.

## Priority Selection

- `PLAN.md` marks all P0 and P1 spy QA findings complete or closed.
- `PLAN.md` lists `SPY-QA-29` as the first unchecked spy bug.
- `SPY-QA-29` is therefore the highest-priority open spy bug I could act on.

## Bug

`PLAN.md` defines the bug:

> [P2] SPY-QA-29: Fix sticky inspector header overlap. Scrolled detail content
> can slide underneath the fixed title/status area and appear clipped.

## Reproduction

I reproduced this against the fixture-backed spy UI before changing product
code:

1. Built the browser UI with `bun run build:spy-ui`.
2. Started the fixture service with:
   `bun run src/spy/ui/test-server.ts --port 5374 --static dist/spy-ui`
3. Opened `http://127.0.0.1:5374` in the in-app browser.
4. Selected the `10 min` range so fixture calls were visible.
5. Used the default selected call, `call-fixture-flow-tool-result`.
6. Scrolled the inspector pane downward by 360 px.

Screenshots captured before the fix:


The crop shows the Composition panel after its title and top metric row have
partially moved under the sticky inspector header. The table is visible directly
below the header, but the section heading and upper content that should precede
it are clipped from view.

## Measurement Proof

At a 1280 x 720 viewport, before scrolling:

```json
{
  "asideScrollTop": 0,
  "header": { "top": 64, "bottom": 192, "height": 128 },
  "composition": { "top": 406, "bottom": 1099, "height": 693 }
}
```

After a normal wheel scroll inside the inspector:

```json
{
  "asideScrollTop": 360,
  "header": { "top": 64, "bottom": 192, "height": 128 },
  "composition": { "top": 46, "bottom": 739, "height": 693 },
  "overlapPx": 146
}
```

This proves the issue geometrically:

- The sticky header remains fixed over `y=64..192`.
- The Composition section moves to `y=46..739`.
- Therefore `192 - 46 = 146` px of the Composition section is under the header.

The bug is not only a visual impression. The section's actual DOM rectangle is
behind the header's DOM rectangle after ordinary inspector scrolling.

## Source Evidence

`src/spy/ui/src/App.tsx:956` makes the entire `<aside>` the scroll container:

```tsx
<aside className="spy-scrollbar min-h-0 min-w-0 overflow-auto bg-[#f3f0eb]">
```

`src/spy/ui/src/App.tsx:957` then places the inspector title/status/nav header
inside that same scroll container as a sticky overlay:

```tsx
<div className="sticky top-0 z-10 border-b border-stone-300 bg-white px-5 py-3">
```

`src/spy/ui/src/App.tsx:987` renders the detail body as normal following
content in the same scroll container:

```tsx
<div className="space-y-4 p-5">
```

Because a sticky element remains in the same scrolling context while staying
painted at the top with `z-10`, following content can pass underneath it during
normal scrolling. The existing `scroll-mt-36` on inspector anchors and details
helps `scrollIntoView()` navigation, but it does not prevent ordinary wheel
scrolling from moving detail content behind the sticky header.

## Root Cause

`SPY-QA-29` is a layout composition bug in `CallInspector`.

The inspector uses one element for both responsibilities:

- the viewport-level inspector scroll container
- the containing block for the sticky title/status/nav header

That makes the header an overlay within the same scrollable content stream. The
body is not in a separate scrollport below the header, and the normal scroll
path has no top exclusion zone equal to the header height.

## Proposed Fix

Split the inspector into a non-scrolling header and a separate scrolling body:

- Change the inspector `<aside>` to a flex column with `overflow-hidden`.
- Keep the title/status/nav header as a normal, non-sticky flex child.
- Add a dedicated scrollable body element below the header for inspector
  content.
- Update `resetInspectorScroll()` to reset that body scroll element.
- Update section navigation to scroll the dedicated body, preserving the current
  behavior of opening `<details>` sections before scrolling.
- Add Playwright coverage that scrolls the inspector body and fails if any
  visible content section overlaps the header rectangle.

## Expected Proof After Fix

The same reproduction should show:

- inspector body scroll changes while the header rectangle stays above it
- the first visible content top is greater than or equal to the scroll body top
- no visible detail content hit-tests inside the header area
- screenshots show content starts below the header instead of disappearing
  underneath it

## Fix Implemented

The implementation split `CallInspector` into:

- a non-scrolling inspector shell
- a fixed normal-flow inspector header
- a dedicated `inspector-scroll-body` scrollport for all detail content

Section navigation and inspector reset now scroll the dedicated body instead of
the whole `<aside>`. Existing e2e tests that asserted inspector scroll behavior
were updated to measure that body, and a new regression test proves scrolled
content does not exist underneath the header hit-test area.

## Proof After Fix

I reran the same fixture service and browser reproduction after the fix, then
scrolled the inspector by 360 px.

After-fix screenshot:


Measured after the fix:

```json
{
  "header": { "top": 64, "bottom": 192, "height": 128 },
  "body": { "top": 192, "bottom": 720, "height": 528 },
  "composition": { "top": 46, "bottom": 739, "height": 693 },
  "scrollTop": 360,
  "contentUnderHeader": false,
  "stackAtHeaderBottom": [
    "div[inspector-header]",
    "aside[inspector]",
    "section",
    "main",
    "div",
    "body",
    "html"
  ]
}
```

The whole Composition element's mathematical rectangle is still above the body
top after scrolling, which is normal for clipped scroll content. The important
post-fix proof is that the scroll body starts exactly at the header bottom
(`192`), and hit-testing inside the header area finds no inspector section or
request-composition content underneath the header.

Verification commands:

- `bun run typecheck`
- `bun run lint`
- `bun run test:spy-ui:unit`
- `bun run test:spy-ui:e2e`
