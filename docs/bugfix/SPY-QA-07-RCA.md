# SPY-QA-07 RCA: Selected Call Pinning Is Implicit During Live Updates

## Scope

This RCA covers the highest-priority spy bug I could reproduce in the current
tree after reading `PLAN.md`: `SPY-QA-07`.

Triage notes:

- `SPY-QA-02` remains the only open P0 in `PLAN.md`, but it did not reproduce
  in the current built UI. Opening lower inspector panels, loading stream
  events, and jumping back to Health kept `main.scrollTop=0` and the global
  header at `top=0`.
- `SPY-QA-06` also did not reproduce in the current built UI. Selecting a
  different call after deep inspector scrolling reset the inspector to
  `scrollTop=0`.
- The next open P1 with current evidence is `SPY-QA-07`.

No implementation code has been changed for this RCA.

## Reproduction Used

Baseline:

- Ran `bun run build:spy-ui`.
- Started the fixture-backed spy UI service with:
  `bun src/spy/ui/test-server.ts --port 0 --static dist/spy-ui`
- Opened the built UI in the Codex in-app browser at
  `http://127.0.0.1:35394/?since=0`.
- Used the production built assets from `dist/spy-ui`.

The fixture server returns multiple Bedrock calls ordered newest first. This is
enough to prove the ambiguous UI state that happens after a live update inserts
a newer row above the currently selected call.

## Higher-Priority No-Repro Proof

`SPY-QA-02` was checked at the default `1280 x 720` viewport and at the original
manual-QA style `1159 x 862` viewport.

At `1159 x 862`, after opening Health, opening Stream, loading stream events,
and jumping back to Health:

```json
{
  "main": {
    "clientHeight": 862,
    "scrollHeight": 862,
    "scrollTop": 0,
    "overflowY": "hidden"
  },
  "header": { "top": 0, "bottom": 64, "height": 64 },
  "aside": {
    "clientHeight": 798,
    "scrollHeight": 2321,
    "scrollTop": 1523,
    "overflowY": "auto"
  },
  "openDetails": [
    { "id": "spy-inspector-stream", "top": -192, "height": 637 },
    { "id": "spy-inspector-health", "top": 523, "height": 319 }
  ]
}
```

This proves the lower-panel navigation work is currently owned by the inspector
scroll container, not the hidden top-level `main` scroll container.

For `SPY-QA-06`, after selecting another timeline call from the deep Health
position:

```json
{
  "main": {
    "clientHeight": 862,
    "scrollHeight": 862,
    "scrollTop": 0
  },
  "header": { "top": 0, "bottom": 64, "height": 64 },
  "aside": {
    "clientHeight": 798,
    "scrollHeight": 1457,
    "scrollTop": 0
  },
  "openDetails": []
}
```

That is a no-repro for the current tree, so this RCA does not propose a
`SPY-QA-02` or `SPY-QA-06` code change.

## Proof

With five calls visible, I selected the second row,
`call-fixture-flow-tool-use`, while the newer
`call-fixture-flow-tool-result` row remained above it.

Browser measurement:

```json
{
  "label": "selected-older-call-with-newer-row-above",
  "rowCount": 5,
  "firstRow": {
    "ariaLabel": "Open call call-fixture-flow-tool-result",
    "selectedVisual": false,
    "text": "claude-sonnet-4-6 complete cache 2 07:09:19 PM input 2.6 KiB output 217 B usage 1.3k tok duration 1.0 s converse-stream..."
  },
  "selectedRows": [
    {
      "ariaLabel": "Open call call-fixture-flow-tool-use",
      "selectedVisual": true,
      "text": "claude-sonnet-4-6 complete cache 2 07:09:17 PM input 2.4 KiB output 479 B usage 1.2k tok duration 1.0 s converse-stream..."
    }
  ],
  "inspectorId": "call-fixture-flow-tool-use",
  "visiblePinnedText": false,
  "headerSubtitle": "Live from now"
}
```

This proves the core ambiguous state:

- The timeline can contain a newer call above the selected call.
- The inspector remains on the older selected call.
- The UI has no visible "pinned", "following", or "auto-follow" state.
- The only selected-call cue is the timeline row border/ring, which may be
  offscreen in longer live timelines.

## Source Evidence

Relevant current code:

- `src/spy/ui/src/App.tsx:254-258` handles `calls-changed` SSE events by
  calling `loadCalls()`.
- `src/spy/ui/src/App.tsx:175-183` preserves the current `selectedCallId` when a
  reloaded page still contains that call.
- `src/spy/ui/src/App.tsx:772-788` renders selected timeline state only as
  visual row styling plus `aria-label="Open call <id>"`.
- `src/spy/ui/src/App.tsx:862-876` renders the inspector header with model,
  call id, status, and section navigation, but no pinned/following status.

## Root Cause

`SPY-QA-07` is a browser state-communication bug.

The live-update behavior intentionally preserves `selectedCallId` when
`loadCalls()` receives a refreshed timeline that still contains the selected
call. That is a reasonable state model for an inspector: operators often need
the detail pane to stay on the call they are reading while new live rows arrive.

The bug is that the UI does not communicate that state. Once a newer call is
inserted above the selected call, the inspector is effectively pinned to an
older call, but the inspector header still looks like ordinary selected-call
detail. There is no explicit pinned indicator, no "newer calls available"
signal, and no follow-latest control.

## Proposed Fix

Fix `SPY-QA-07` in the browser selection/live-update path:

- Track whether the selected call is the newest visible call.
- When it is not, show a compact pinned-state badge in the inspector header,
  such as `Pinned`, with a clear affordance to jump/follow the latest call.
- Keep the existing selected-call preservation behavior; changing that behavior
  would interrupt active inspection during live capture.
- Add Playwright coverage for a live update that inserts a newer call above the
  selected call and proves the inspector exposes the pinned state.

## Fix Status

Implemented.

Changed `src/spy/ui/src/App.tsx` so the app derives whether the selected call
is older than the newest visible timeline row. When that happens, the inspector
sticky header now shows a `Pinned` badge and a `Follow Latest` button that
selects the newest visible call while preserving the existing pinned-inspection
behavior by default.

Added Playwright coverage in `src/spy/ui/e2e/spy-ui.playwright.ts` proving that
selecting an older visible call exposes the pinned state, and that `Follow
Latest` selects the newest call and clears the pinned indicator.

Verification commands:

- `bun run typecheck`
- `bun run lint`
- `bun run test:spy-ui:unit`
- `bun run test:spy-ui:e2e`
