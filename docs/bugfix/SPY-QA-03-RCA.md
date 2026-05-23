# SPY-QA-03 RCA: Timeline Row And Footer Overlap

## Scope

This RCA covers the highest-priority spy bug that I could prove in the current
tree: `SPY-QA-03`.

Triage note: `SPY-QA-02` is listed before this in `PLAN.md`, but I could not
reproduce it with the current code. I tested lower inspector panel focus, stream
event loading, narrower desktop viewports, shorter viewports, and keyboard focus
traversal. In all probes, `main.scrollTop` stayed `0` and the global header
stayed at y=`0`. Since the request requires evidence before fixing, I did not
infer a `SPY-QA-02` fix from the old QA note.

## Reproduction Used

- Built the current UI with `bun run build:spy-ui`.
- Started the fixture-backed spy UI service:
  `bun src/spy/ui/test-server.ts --port 0 --static dist/spy-ui`
- The server selected `http://127.0.0.1:35678`.
- Opened `http://127.0.0.1:35678/?since=0`.
- Selected the `10 min` range, matching the QA note for the short 10-minute
  view.
- Measured browser geometry with headless Chromium against the built UI.

The fixture data was enough to reproduce the bug with five provider-call rows.

## Proof

At a normal desktop viewport of 1100 x 720, rendered timeline rows overlap:

```json
{
  "viewport": { "width": 1100, "height": 720 },
  "rowRects": [
    { "index": 0, "top": 273, "bottom": 395, "height": 122 },
    { "index": 1, "top": 391, "bottom": 513, "height": 122 },
    { "index": 2, "top": 509, "bottom": 631, "height": 122 },
    { "index": 3, "top": 627, "bottom": 749, "height": 122 },
    { "index": 4, "top": 745, "bottom": 867, "height": 122 }
  ],
  "overlaps": [
    { "previous": 0, "current": 1, "gap": -4 },
    { "previous": 1, "current": 2, "gap": -4 },
    { "previous": 2, "current": 3, "gap": -4 },
    { "previous": 3, "current": 4, "gap": -4 }
  ]
}
```

The overlap is not just visual. At y=`393`, both row 0 and row 1 are in the hit
stack:

```json
{
  "overlapY": 393,
  "row0": { "top": 273, "bottom": 395 },
  "row1": { "top": 391, "bottom": 513 },
  "elementsAtPoint": [
    { "tag": "BUTTON", "testid": "timeline-row", "row": 1 },
    { "tag": "BUTTON", "testid": "timeline-row", "row": 0 }
  ]
}
```

The sticky footer also covers row content. At initial scroll position in the same
viewport, the footer covers row 3 by 57 px:

```json
{
  "footer": { "top": 663, "bottom": 720, "height": 57 },
  "covered": [
    { "index": 3, "overlap": 57, "rowBottom": 749, "footerTop": 663 }
  ]
}
```

Even at the bottom of the timeline scroll range, the footer still covers the
last row:

```json
{
  "scrollTop": 192,
  "max": 192,
  "lastRow": { "index": 4, "top": 553, "bottom": 675, "height": 122 },
  "footer": { "top": 663, "bottom": 720, "height": 57 },
  "covered": [
    { "index": 4, "overlap": 12, "rowBottom": 675, "footerTop": 663 }
  ]
}
```

## Source Evidence

Relevant current code:

- `src/spy/ui/src/App.tsx:624-629` configures the virtualizer with
  `estimateSize: () => 118`.
- `src/spy/ui/src/App.tsx:649-653` positions each rendered row wrapper at
  `virtualRow.start`.
- `src/spy/ui/src/App.tsx:654-660` renders `TimelineRow` without attaching
  `virtualizer.measureElement`, so the virtualizer never learns the actual row
  height.
- `src/spy/ui/src/App.tsx:665-672` renders the call-count/Load More footer as
  `sticky bottom-0` inside the same scroll container, but the virtualized list
  does not reserve bottom clearance for that sticky footer.

## Root Cause

The timeline virtualizer assumes every row is 118 px tall, but the actual row
height at common desktop widths is 122 px. Because each row is absolutely
positioned from the virtualizer's fixed starts, row starts are 118 px apart while
the row boxes are 122 px tall. That creates a 4 px overlap between adjacent rows
in the current fixture; live rows with more wrapping can overlap more.

The footer has a separate cause in the same component. It is sticky inside the
timeline scroll container, so it floats over list content. The virtualized list
height is based only on virtual rows and does not include bottom padding equal to
the sticky footer height. Therefore the final visible rows can scroll underneath
the footer and remain partly covered even at maximum scroll.

## Proposed Fix

Fix both parts in `Timeline`:

- Give the virtualizer a conservative row estimate at or above the actual compact
  row height, and attach `virtualizer.measureElement` to each row wrapper so
  wrapped rows update the virtual layout with their real height.
- Include vertical spacing in the measured row wrapper instead of relying on a
  too-small fixed estimate.
- Reserve bottom clearance for the sticky footer, either by adding bottom
  padding/spacer to the virtualized content or by moving the footer outside the
  scroll-overlay path.
- Add Playwright coverage that fails when adjacent row rects overlap or when the
  footer covers the last row at max timeline scroll.

## Fix Status

Implemented.

Changed `src/spy/ui/src/App.tsx` so timeline virtual rows are measured with
`virtualizer.measureElement` and use a conservative initial row estimate. The
timeline footer is now a sibling of the scroll viewport instead of a sticky
overlay inside it, so row content cannot scroll underneath the call-count/Load
More controls.

Added Playwright coverage in `src/spy/ui/e2e/spy-ui.playwright.ts` that fails
when adjacent timeline rows overlap or when the footer overlaps row content at
maximum timeline scroll.

Verification commands:

- `bun run typecheck`
- `bun run lint`
- `bun run build:spy-ui`
- `bun run test:spy-ui:unit`
- `bun run test:spy-ui:e2e`
