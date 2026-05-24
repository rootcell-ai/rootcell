# SPY-QA-04 RCA: Long Inspectors Bury Core Panels

## Scope

This RCA covers the highest-priority spy bug that is both open and reproducible
in the current tree: `SPY-QA-04`.

`PLAN.md` lines 852-855 describe the failure as long inspectors being hard to
navigate because Request/Response Blocks open by default and Usage Records,
Network Metadata, Stream Events, Raw Payloads, and Health become effectively
buried.

Triage note: `SPY-QA-02` is listed first among the remaining P0 items, but the
plan already records a no-repro attempt. I repeated the relevant check in the
current built UI. Clicking the offscreen `Health` section scrolled the inspector
only: `main.scrollTop` stayed `0`, the global header stayed at y=`0..64`, and
the Health summary became visible at y=`655..699`. Because the requested fix
requires actual evidence before implementation, I am not treating `SPY-QA-02`
as the next fix until it can be reproduced.

## Reproduction Used

- Built the current UI with `bun run build:spy-ui`.
- Started the fixture-backed spy UI service:
  `bun src/spy/ui/test-server.ts --port 4683 --static dist/spy-ui`
- Opened `http://127.0.0.1:4683/?since=0` in the Codex in-app browser.
- Selected the first fixture-backed provider call.
- Measured DOM geometry in the default 1280 x 720 browser viewport.

The fixture call is sufficient to reproduce the issue without relying on live
traffic or a special long production capture.

## Proof

Immediately after selecting the first provider call, the inspector scroll
container is correctly constrained to the viewport, but all inspector section
summaries are below the visible area:

```json
{
  "viewport": { "width": 1280, "height": 720 },
  "main": {
    "scrollTop": 0,
    "clientHeight": 720,
    "scrollHeight": 720,
    "overflowY": "hidden"
  },
  "aside": {
    "scrollTop": 0,
    "clientHeight": 656,
    "scrollHeight": 3448,
    "maxScrollTop": 2792,
    "overflowY": "auto",
    "rect": { "top": 64, "bottom": 720, "height": 656 }
  },
  "detailsOpenByDefault": ["Request Blocks", "Response Blocks"],
  "visibleSummaries": [],
  "screenfulsToBottom": 4.26
}
```

The measured section positions at the top of the inspector were:

```json
[
  { "title": "Request Blocks", "top": 967, "open": true, "height": 1653 },
  { "title": "Response Blocks", "top": 2636, "open": true, "height": 485 },
  { "title": "Diff Against Previous Request", "top": 3137, "open": false },
  { "title": "Usage Records", "top": 3199, "open": false },
  { "title": "Network Metadata", "top": 3261, "open": false },
  { "title": "Stream Events", "top": 3323, "open": false },
  { "title": "Raw Payloads", "top": 3385, "open": false },
  { "title": "Health", "top": 3447, "open": false }
]
```

The practical effect is that none of the call-native inspector sections are
visible in the first viewport. The operator sees only the top summary and
request-composition card, then must scroll several viewport heights before
reaching provider usage, network metadata, stream events, raw payload state, or
service health.

After opening and loading Stream Events, the scroll burden grows further:

```json
{
  "aside": {
    "clientHeight": 656,
    "scrollHeight": 4926,
    "maxScrollTop": 4270
  },
  "detailsOpenByDefaultOrUserOpened": [
    "Request Blocks",
    "Response Blocks",
    "Stream Events",
    "Health"
  ],
  "preBlockCount": 18,
  "screenfulsToBottom": 6.51
}
```

That stream-event expansion is the related `SPY-QA-05` problem, but it makes the
same root navigation problem worse: all detail panels live in one long scroll
stack with no section navigation and several high-volume panels rendered inline.

## Source Evidence

Relevant pre-fix code observed before implementation:

- `src/spy/ui/src/App.tsx:768` makes the whole inspector one vertical
  `overflow-auto` scroll container.
- `src/spy/ui/src/App.tsx:783` renders all inspector content in a single
  `space-y-4` stack.
- `src/spy/ui/src/App.tsx:812-843` renders Summary, Request Composition, then
  every inspector section sequentially.
- `src/spy/ui/src/App.tsx:814` opens Request Blocks by default.
- `src/spy/ui/src/App.tsx:818` opens Response Blocks by default.
- `src/spy/ui/src/App.tsx:1013-1016` renders every normalized block in each open
  block section.
- `src/spy/ui/src/App.tsx:1036-1038` allows each block preview to consume up to
  `max-h-64`, so a modest number of blocks can consume multiple viewport
  heights.
- `src/spy/ui/src/App.tsx:1147-1157` renders loaded stream events inline.
- `src/spy/ui/src/App.tsx:1225-1234` defines `Section` as a plain `<details>`
  panel with no sticky local navigation, no summary list, and no bounded
  section-level pagination.

## Root Cause

The inspector layout has a correct scroll owner after `SPY-QA-01`, but the
content model inside that owner is still linear and volume-driven.

`InspectorContent` renders high-level summary cards first, then opens both
Request Blocks and Response Blocks by default before the diagnostic sections.
Those block lists render every block preview inline. The first fixture call
therefore places the first section summary at y=`967`, below the viewport, and
places Usage Records, Network Metadata, Stream Events, Raw Payloads, and Health
more than 3,100 px below the viewport top.

The issue is not that lower panels are mathematically unreachable. They are
reachable through the inspector scrollbar. The bug is that the call-native
inspector makes core diagnostic panels operationally hard to reach during normal
use, especially when request/response blocks or loaded stream events are large.

## Proposed Fix

Make the inspector navigable without requiring a long linear scroll through
expanded content:

- Add a compact sticky section navigator inside the inspector header or directly
  below it, with anchors for Summary, Request Composition, Request Blocks,
  Response Blocks, Diff, Usage, Network, Stream, Raw, and Health.
- Collapse high-volume Request Blocks and Response Blocks by default for large
  calls, or render them behind explicit "expand blocks" controls when their
  measured block count/byte size exceeds a conservative threshold.
- Preserve quick visibility for Usage Records, Network Metadata, Stream Events,
  Raw Payloads, and Health from the top of the inspector through the navigator.
- Keep Stream Events loaded on demand, and coordinate with `SPY-QA-05` for
  pagination or virtualization so loading stream events does not create another
  multi-screen inline stack.
- Add Playwright coverage that selects the fixture call and verifies that the
  lower diagnostic sections are reachable via the new navigation without
  manually scrolling thousands of pixels.

## Fix Status

Implemented.

Changed `src/spy/ui/src/App.tsx` so the inspector header includes a sticky
section navigator for Summary, Composition, Request, Response, Diff, Usage,
Network, Stream, Raw, and Health. Navigator buttons open `<details>` sections
when needed and scroll the target section into view inside the inspector.

Changed large Request/Response block sections to start collapsed when the
combined block count or byte size exceeds the conservative auto-open threshold.
For the original fixture call, Request Blocks and Response Blocks now start
collapsed and show block-count/byte-size summaries in their headers.

Added Playwright coverage in `src/spy/ui/e2e/spy-ui.playwright.ts` proving that:

- Large fixture block sections start collapsed.
- Health initially remains below the viewport, preserving the regression setup.
- The Health navigator button scrolls Health into the viewport and opens it.
- `main.scrollTop` remains `0`, so the fix does not reintroduce hidden
  top-level scrolling.

Post-fix browser verification at 1280 x 720:

```json
{
  "beforeNav": {
    "main": { "scrollTop": 0, "clientHeight": 720, "scrollHeight": 720 },
    "aside": {
      "scrollTop": 0,
      "clientHeight": 656,
      "scrollHeight": 1457,
      "maxScrollTop": 801
    },
    "requestOpen": false,
    "responseOpen": false,
    "health": { "top": 1455, "bottom": 1501 }
  },
  "afterHealthNav": {
    "main": { "scrollTop": 0, "clientHeight": 720, "scrollHeight": 720 },
    "aside": {
      "scrollTop": 1074,
      "clientHeight": 656,
      "scrollHeight": 1730,
      "maxScrollTop": 1074
    },
    "healthOpen": true,
    "health": { "top": 381, "bottom": 700 }
  }
}
```

Verification commands:

- `bun run typecheck`
- `bun run lint`
- `bun run test:spy-ui:unit`
- `bun run test:spy-ui:e2e`
