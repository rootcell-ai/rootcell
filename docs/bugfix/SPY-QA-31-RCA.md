# SPY-QA-31 RCA: Timeline Row Accessible Names Hide Row Context

This RCA was written before implementation for the highest-priority open spy
bug in the current tree: `SPY-QA-31`.

## Priority Selection

- `PLAN.md:1038-1042` lists `SPY-QA-31` and `SPY-QA-32` as the remaining P2
  spy bugs before the P3 polish items.
- The handoff is ordered and `SPY-QA-31` is the first unchecked item at the
  highest remaining priority.
- `PLAN.md:1073-1074` restates the `SPY-QA-31` evidence note.
- This document was written before any product-code fix for `SPY-QA-31`.

## Bug Definition

`PLAN.md:1038-1040` defines the bug:

```text
[P2] SPY-QA-31: Improve timeline row accessible names. `aria-label` only
exposes `Open call <id>` and hides visible model/status/time/usage context from
assistive technology.
```

`PLAN.md:1073-1074` adds:

```text
SPY-QA-31: Timeline row accessible names expose only `Open call <id>`, hiding
visible model/status/time/usage context from assistive technology.
```

## Current Reproduction

I reproduced the issue against the fixture-backed spy UI before changing
product code.

Commands used:

```sh
bun run src/spy/ui/test-server.ts --port 4874 --static dist/spy-ui
```

The non-escalated localhost bind attempt failed in the sandbox. The approved
localhost server run succeeded and reported:

```text
rootcell spy UI test server listening on http://127.0.0.1:4874
```

I then opened `http://127.0.0.1:4874/?since=0` in headless Chromium, waited for
fixture timeline rows, captured the first timeline row screenshot, and compared
the row's visible text with its role-accessible name.

Screenshot captured before a fix:


The screenshot shows the row visibly includes model, status, time, provider
usage, operation, byte sizes, duration, and block counts. The decisive proof is
the DOM and role-query evidence below.

## DOM And Accessibility Proof

The first row is a native button with an explicit `aria-label`:

```json
{
  "tagName": "BUTTON",
  "role": "implicit button",
  "ariaLabel": "Open call call-fixture-flow-tool-result",
  "ariaCurrent": "true",
  "visibleText": "claude-sonnet-4-6complete08:29:27 AMread1,253write8cache read-cache write-converse-stream · input 2.6 KiB · output 217 B · 1.0 s · 9 request blocks · 3 response blocks",
  "rect": {
    "width": 530,
    "height": 106
  },
  "exactNameMatches": 1,
  "modelNameMatches": 0
}
```

This proves the bug:

- The visible row text includes `claude-sonnet-4-6`, `complete`, `read`,
  `write`, `cache read`, `cache write`, `converse-stream`, byte sizes, duration,
  and request/response block counts.
- A role query for the exact accessible name
  `Open call call-fixture-flow-tool-result` finds the row.
- A role query by visible model context, `/claude-sonnet-4-6/`, finds zero
  matching row buttons.

Therefore assistive technology receives only the call-open action and id, not
the meaningful timeline summary visible on screen.

## Source Evidence

`src/spy/ui/src/App.tsx:872` sets an explicit accessible name on each timeline
row button:

```tsx
aria-label={`Open call ${summary.call.id}`}
```

The same button renders the richer visible row content immediately below it at
`src/spy/ui/src/App.tsx:880-892`:

```tsx
<span className="truncate text-sm font-semibold">{shortModelId(summary.call.model_id)}</span>
<Badge tone={statusTone(summary.call.status)}>{summary.call.status}</Badge>
<span className="ml-auto text-xs text-stone-500">{formatTime(summary.call.started_at)}</span>
...
{summary.call.operation} · input {formatBytes(summary.requestByteSize)} · output {formatBytes(summary.responseByteSize)} · {formatDuration(summary.durationMs)} · {summary.requestBlockCount} request blocks · {summary.responseBlockCount} response blocks
```

Existing Playwright coverage also encodes the current defective accessible name.
`src/spy/ui/e2e/spy-ui.playwright.ts:117-118` locates rows by exact names that
only include `Open call <id>`:

```ts
const selectedRow = page.getByRole("button", { name: "Open call call-fixture-flow-tool-result", exact: true });
const otherRow = page.getByRole("button", { name: "Open call call-fixture-flow-tool-use", exact: true });
```

## Root Cause

`SPY-QA-31` is caused by the explicit `aria-label` on `TimelineRow`.

For a native button, an `aria-label` overrides the button's normal accessible
name computation from descendant text. The row's descendants already contain
the visible model/status/time/usage summary, but that useful text is removed
from the accessible name because `aria-label` replaces it with
`Open call <id>`.

The regression is reinforced by Playwright tests that locate rows by the exact
old aria-label, so the test suite currently proves the broken contract instead
of the intended accessible summary.

## Proposed Fix

Fix the accessible name at the `TimelineRow` boundary:

- Replace the terse `aria-label` with a generated summary label that includes
  the action, call id, short model id, status, started time, operation, provider
  usage classes, byte sizes, duration, and request/response block counts.
- Keep `aria-current` unchanged for selected-row state.
- Keep the visual row content unchanged.
- Update Playwright coverage to locate rows with names that include visible row
  context instead of exact `Open call <id>` labels.
- Add a focused assertion proving the row is discoverable by visible model and
  usage context through its accessible name.

## Verification Plan

After implementation:

```sh
bun run typecheck
bun run lint
bun run test:spy-ui:unit
bun run test:spy-ui:e2e
```

The e2e suite requires localhost/browser permission in this workspace.

## Implemented Fix

Changed `src/spy/ui/src/App.tsx` so `TimelineRow` still exposes an explicit
action-oriented accessible name, but now includes the same meaningful summary
context visible in the row:

- call id
- short model id
- status
- started time
- operation
- provider usage classes: read, write, cache read, cache write
- request and response byte sizes
- duration
- request and response block counts

The selected-row `aria-current` state and visual row content are unchanged.

Updated `src/spy/ui/e2e/spy-ui.playwright.ts` so row lookup no longer depends
on the old exact `Open call <id>` label. The regression coverage now proves
that the accessible name includes model/status/operation/usage context, with a
dedicated cache-heavy assertion for cache read/write token values.

Updated `PLAN.md` to mark `SPY-QA-31` complete.

## Proof After Fix

After-fix screenshot:


Measured after the fix:

```json
{
  "tagName": "BUTTON",
  "role": "implicit button",
  "ariaLabel": "Open call call-fixture-flow-tool-result, model claude-sonnet-4-6, status complete, started 08:34:12 AM, operation converse-stream, read 1,253, write 8, cache read -, cache write -, input 2.6 KiB, output 217 B, duration 1.0 s, 9 request blocks, 3 response blocks",
  "ariaCurrent": "true",
  "visibleText": "claude-sonnet-4-6complete08:34:12 AMread1,253write8cache read-cache write-converse-stream · input 2.6 KiB · output 217 B · 1.0 s · 9 request blocks · 3 response blocks",
  "exactOldNameMatches": 0,
  "modelNameMatches": 5,
  "usageNameMatches": 1
}
```

This proves:

- the old exact accessible name `Open call call-fixture-flow-tool-result` no
  longer matches any row
- role queries by visible model context now match timeline row buttons
- role queries by usage context now match the specific row

## Verification Completed

```sh
bun run typecheck
bun run lint
bun run test:spy-ui:unit
bun run test:spy-ui:e2e
bun run test
```

All commands passed. The Playwright suite ran 24 tests successfully. The first
non-escalated `bun run test` attempt failed because the sandbox blocked
localhost binds in `src/spy/service.test.ts`; the approved rerun passed with 46
Bun tests and 87 Vitest tests.
