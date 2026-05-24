# SPY-QA-23 RCA: Block-Kind Filter Scope Is Misleading

## Scope

This RCA covers the highest-priority open spy bug in the current tree:
`SPY-QA-23`.

Triage notes:

- `PLAN.md` marks all P0 and P1 spy bugs complete or closed.
- `PLAN.md:984-986` lists `SPY-QA-23` as the first unchecked item in the
  prioritized handoff, and it is a P2 issue.
- Later unchecked P2/P3 items are lower in the handoff order.
- This document was written before any product-code fix for `SPY-QA-23`.

## Bug Definition

`PLAN.md:984-986` defines the current bug:

```text
[P2] SPY-QA-23: Move or scope the block-kind filter. It lives under Request
Blocks, affects request and response blocks, persists across call selection,
and can make Response Blocks look empty.
```

`PLAN.md:1033-1036` adds the evidence note:

```text
The block-kind filter is presented under Request Blocks but filters
request and response blocks, persists across call selection, and can make
Response Blocks say "No blocks" when the chosen kind only appears in the
request.
```

## Reproduction Used

I started the current spy UI and used headless Chromium with mocked same-origin
API responses. The mocked data deliberately uses two provider calls where each
call has:

- one request block of kind `current-user-input`;
- one response block of kind `assistant-output`.

Commands used:

```sh
bun run dev:spy-ui -- --port 4789
node /private/tmp/spy-qa-23-probe.mjs
```

The first command required localhost bind permission in this workspace. The
second command required browser-launch permission for headless Chromium on
macOS. No implementation files were changed before this RCA was written.

## Runtime Proof

The current tree produced this output before any product-code fix:

```json
{
  "before": {
    "filterValue": "all",
    "filterContainer": "inspector-section-request-blocks",
    "requestText": "Request Blocks1 block · 25 BAll block kindsProvider EnvelopeHarness System ContextUser Visible MessagePrior Conversation HistoryCurrent User InputAssistant OutputThinkingTool DefinitionTool CallTool ResultCache MarkerMedia SummaryUnknownCurrent User Inputnew25 BOnly appears in request A$.synthetic",
    "responseText": "Response Blocks1 block · 26 BAssistant Outputnew26 BOnly appears in response A$.synthetic"
  },
  "afterRequestOnlyFilter": {
    "filterValue": "current-user-input",
    "filterContainer": "inspector-section-request-blocks",
    "requestShowsRequestOnlyBlock": true,
    "requestShowsNoBlocks": false,
    "responseShowsResponseOnlyBlock": false,
    "responseShowsNoBlocks": true,
    "responseText": "Response Blocks1 block · 26 BNo blocks."
  },
  "afterCallSelection": {
    "selectedCallId": "spy-rca-b",
    "filterValue": "current-user-input",
    "requestShowsRequestOnlyBlock": true,
    "responseShowsResponseOnlyBlock": false,
    "responseShowsNoBlocks": true,
    "responseText": "Response Blocks1 block · 26 BNo blocks."
  },
  "consoleErrors": []
}
```

This proves the reported behavior:

- The only visible block-kind control is mounted inside
  `inspector-section-request-blocks`.
- Before filtering, `Response Blocks` correctly renders its response-only
  `assistant-output` block.
- After selecting request-only kind `current-user-input`, `Response Blocks`
  still advertises `1 block · 26 B` in the section summary but the visible list
  says `No blocks.`
- Selecting another call keeps the same `current-user-input` filter value, so
  the response block for the newly selected call is hidden too.

## Source Evidence

`src/spy/ui/src/App.tsx:129-135` stores `blockKind` in the shared top-level
`filters` state alongside timeline filters:

```text
provider, model, operation, status, blockKind
```

`src/spy/ui/src/App.tsx:1003-1010` renders `BlockToolbar` only inside the
`Request Blocks` section:

```text
<BlockToolbar filters={props.filters} onFilters={props.onFilters} />
<BlockList blocks={requestBlocks} filterKind={props.filters.blockKind} ... />
```

`src/spy/ui/src/App.tsx:1012-1018` then passes the same
`props.filters.blockKind` into the `Response Blocks` list, even though the
control is not shown there:

```text
<BlockList blocks={responseBlocks} filterKind={props.filters.blockKind} ... />
```

`src/spy/ui/src/App.tsx:1243-1277` implements `BlockToolbar` as a generic
`Filter blocks by kind` select, but its placement makes it look scoped to
request blocks.

`src/spy/ui/src/App.tsx:1280-1289` applies the selected kind to whatever block
array is passed in and renders `No blocks.` when no block in that direction
matches:

```text
props.blocks.filter((block) => block.kind === props.filterKind)
```

The filter is not part of `timelineContextKey` at
`src/spy/ui/src/App.tsx:151-158`, and it is not reset by the selected-call
change effect at `src/spy/ui/src/App.tsx:206-210`. That matches the runtime
proof where `current-user-input` persists after selecting `spy-rca-b`.

## Root Cause

`SPY-QA-23` is a UI state and placement bug in the call inspector.

The implementation treats `blockKind` as a shared inspector-wide filter, but
the UI renders the control inside the `Request Blocks` disclosure. This creates
two conflicting scopes:

- visual scope: the control appears to belong to `Request Blocks`;
- actual scope: the state is shared by both request and response `BlockList`
  instances and survives call selection.

When the selected kind exists only in request blocks, the response list is
filtered down to zero rows while its unfiltered section summary still reports
that response blocks exist. The data and API are not the root cause: the proof
shows the response block is present before the shared filter is applied.

## Proposed Fix

Fix `SPY-QA-23` in `src/spy/ui/src/App.tsx` by making the filter's visual scope
match its behavioral scope. Two viable options:

1. Move the block-kind filter to an inspector-level toolbar above both Request
   Blocks and Response Blocks, label it as applying to all blocks, and make
   empty states say that the current block-kind filter hid the rows.
2. Split the state into independent request and response block-kind filters,
   rendering a separate control in each section.

The first option is smaller and preserves the current shared filtering
behavior, but it must make the global scope explicit. The fix should also add
Playwright coverage proving:

- the filter is no longer visually scoped only to Request Blocks;
- applying a request-only kind does not make `Response Blocks` look like it has
  no captured data without explanation;
- call selection either intentionally preserves the inspector-wide block filter
  with clear UI state, or resets it if we choose call-local section filters.

## Fix Status

Implemented on 2026-05-24.

Changed `src/spy/ui/src/App.tsx` so the block-kind filter is an
inspector-level toolbar above both Request Blocks and Response Blocks, with a
visible `Request and response blocks` scope label. The filter still applies to
both block lists and intentionally persists across call selection, but the
scope is no longer visually tied to Request Blocks.

Filtered-empty block lists now show which selected kind is absent from that
section, for example `No Current User Input blocks in this section.`, instead
of the misleading generic `No blocks.`

Added Playwright coverage in `src/spy/ui/e2e/spy-ui.playwright.ts` proving the
filter is outside the Request Blocks section, the Response Blocks empty state
identifies the active kind, and the shared filter remains visible and explicit
after selecting another call.
