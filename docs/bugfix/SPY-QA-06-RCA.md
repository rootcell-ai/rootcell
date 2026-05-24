# SPY-QA-06 RCA: No Reset Path For Already-Selected Calls

## Scope

This RCA covers the highest-priority spy bug that is both open and reproducible
in the current tree: `SPY-QA-06`.

`PLAN.md` lists `SPY-QA-02` first among open P0 items, but the plan already
records a no-repro attempt. I repeated the check before this RCA across 1280 x
720, 1100 x 720, 1280 x 600, 980 x 600, and 1440 x 900 viewports. Focusing,
clicking, tabbing to, and navigating to lower inspector sections all kept
`main.scrollTop`, `documentElement.scrollTop`, `body.scrollTop`, and
`window.scrollY` at `0`. In the current tree, `main.scrollHeight` also equals
`main.clientHeight`, so there is no hidden top-level scroll range for the
reported P0 behavior to enter. I am not proposing a P0 source change without a
reproduction.

## Reproduction Used

- Built the current UI with `bun run build:spy-ui`.
- Started the fixture-backed spy UI service:
  `bun run src/spy/ui/test-server.ts --port 4699 --static dist/spy-ui`
- Opened `http://127.0.0.1:4699/?since=0` in Playwright Chromium.
- Used a 1280 x 720 viewport.
- Selected the latest fixture call.
- Jumped to Stream Events, loaded the stream events, and scrolled the inspector
  to the bottom.
- Clicked the already-selected timeline row again.
- Clicked a different timeline row as a control case.

## Proof

Runtime measurements from the browser:

```json
[
  {
    "label": "selected latest call",
    "selectedCallId": "call-fixture-flow-tool-result",
    "activeRowLabel": "Open call call-fixture-flow-tool-result",
    "main": { "scrollTop": 0, "scrollHeight": 720, "clientHeight": 720 },
    "aside": { "scrollTop": 0, "scrollHeight": 1442, "clientHeight": 656 },
    "openSections": [],
    "visibleStreamCards": 0
  },
  {
    "label": "deep stream inspection",
    "selectedCallId": "call-fixture-flow-tool-result",
    "activeRowLabel": "Open call call-fixture-flow-tool-result",
    "main": { "scrollTop": 0, "scrollHeight": 720, "clientHeight": 720 },
    "aside": { "scrollTop": 1321, "scrollHeight": 1977, "clientHeight": 656 },
    "openSections": ["inspector-section-stream"],
    "stream": { "top": -5, "bottom": 576, "height": 581 },
    "health": { "top": 654, "bottom": 700, "height": 46 },
    "visibleStreamCards": 6
  },
  {
    "label": "after clicking selected row again",
    "selectedCallId": "call-fixture-flow-tool-result",
    "activeRowLabel": "Open call call-fixture-flow-tool-result",
    "main": { "scrollTop": 0, "scrollHeight": 720, "clientHeight": 720 },
    "aside": { "scrollTop": 1321, "scrollHeight": 1977, "clientHeight": 656 },
    "openSections": ["inspector-section-stream"],
    "stream": { "top": -5, "bottom": 576, "height": 581 },
    "health": { "top": 654, "bottom": 700, "height": 46 },
    "visibleStreamCards": 6
  },
  {
    "label": "after clicking different row control case",
    "selectedCallId": "call-fixture-flow-tool-use",
    "activeRowLabel": "Open call call-fixture-flow-tool-use",
    "main": { "scrollTop": 0, "scrollHeight": 720, "clientHeight": 720 },
    "aside": { "scrollTop": 0, "scrollHeight": 1442, "clientHeight": 656 },
    "openSections": [],
    "visibleStreamCards": 0
  }
]
```

Key observations:

- Re-clicking the already-selected row leaves `aside.scrollTop` at `1321`.
- The Stream Events accordion remains open.
- Previously loaded stream-event cards remain visible.
- The selected call id does not change, so the operator stays in the deep detail
  context instead of returning to the call title/summary.
- Clicking a different row resets the inspector correctly: `aside.scrollTop`
  returns to `0`, open sections clear, and stream-event cards are removed.

## Source Evidence

Relevant current code:

- `src/spy/ui/src/App.tsx:202-208` resets stream state and inspector scroll only
  when `selectedCallId` changes.
- `src/spy/ui/src/App.tsx:768-774` wires every timeline row click to
  `props.onSelect(summary.call.id)`.
- `src/spy/ui/src/App.tsx:551-572` passes inspector callbacks, but there is no
  explicit inspector reset callback or reset affordance.
- `src/spy/ui/src/App.tsx:1032-1038` opens lower inspector sections through the
  section navigator.
- `src/spy/ui/src/App.tsx:1040-1047` resets only `aside.scrollTop`; it is not
  callable from the already-selected row path.
- `src/spy/ui/src/App.tsx:1537-1542` renders native `<details>` sections whose
  open state can be changed by user interaction or section navigation.

## Root Cause

The UI currently treats inspector reset as a side effect of selection identity
change. That works for a genuinely different call, because `selectedCallId`
changes and the `useEffect` at `src/spy/ui/src/App.tsx:202-208` clears
`streamState` and scrolls the inspector to the top.

Re-clicking the already-selected timeline row does not change React state:
`TimelineRow` calls `onSelect` with the same call id, React keeps
`selectedCallId` unchanged, and the reset effect does not run. The selected call
therefore keeps the previous inspector scroll position, loaded stream-event
state, and open lower section.

This matches the operator problem in `PLAN.md`: once the inspector is deep in
Stream Events or another lower panel, there is no obvious way to return the
selected call to a clean top-of-inspector state unless the operator selects a
different call or changes the timeline context.

## Proposed Fix

Add an explicit selected-call reset path instead of relying only on selection
identity changes:

- Introduce a `resetSelectedCallInspection()` helper in `App` that clears
  `streamState`, resets the inspector scroll, and increments an inspector reset
  token.
- Pass that helper to `Timeline` and call it when the clicked row id already
  equals `selectedCallId`; keep the existing `setSelectedCallId` path for
  different calls.
- Use the reset token as a `key` on the loaded inspector content, or pass it to
  the section stack, so native `<details>` open state is remounted and lower
  accordions close on reset.
- Add Playwright coverage for the exact reproduction above: load stream events,
  scroll deep, re-click the selected row, and assert `aside.scrollTop === 0`,
  no stream cards are rendered, and no lower section remains open.

## Fix Status

Implemented.

Changed `src/spy/ui/src/App.tsx` so clicking the already-selected timeline row
now clears loaded stream state, increments an inspector reset key, and scrolls
the inspector back to the top. The reset key remounts the loaded inspector
content, which closes native `<details>` sections such as Stream Events.

Added Playwright coverage in `src/spy/ui/e2e/spy-ui.playwright.ts` for the
reproduction path. The test loads stream events, scrolls the inspector deep,
clicks the selected row again, then verifies:

- `aside.scrollTop` returns to `0`.
- Stream event cards are removed.
- `main.scrollTop` remains `0`.
- The Stream Events section is closed.

Verification commands:

- `bun run typecheck`
- `bun run lint`
- `bun run test:spy-ui:unit`
- `bun run test:spy-ui:e2e`
