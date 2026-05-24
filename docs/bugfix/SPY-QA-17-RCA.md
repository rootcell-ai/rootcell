# SPY-QA-17 RCA: Diff Baseline Scope Is Implicit

## Scope

This RCA covers the highest-priority open spy bug I could prove in the current
tree after reading `PLAN.md`: `SPY-QA-17`.

Triage notes:

- `PLAN.md` marks all P0 spy bugs closed.
- `PLAN.md` marks `SPY-QA-01` through `SPY-QA-16` complete or closed.
- `SPY-QA-17` is the first unchecked item in the prioritized handoff, and it is
  a P1 issue.
- This document was initially written before implementation. The fix status
  below records the later code changes.

## Reproduction Used

I used the existing sanitized Bedrock/Pi fixture pair and the real spy store
code to create three comparable provider calls:

- `call-qa17-old` at `started_at=1000`
- `call-qa17-mid` at `started_at=1100`
- `call-qa17-visible` at `started_at=1200`

Then I loaded the same timeline range behavior the UI uses by asking the store
for calls with `since=1150`. That range can only show `call-qa17-visible`.

The one-off command was equivalent to this script:

```sh
bun --eval '
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSpyStore } from "./src/spy/store.ts";
import {
  SpoolEventSchema,
  SpoolRequestEventSchema,
  SpoolResponseEventSchema,
} from "./src/spy/schemas.ts";

const fixturePath = new URL("./src/spy/fixtures/bedrock-pi-us-sonnet-4-6.ndjson", import.meta.url);
const events = readFileSync(fixturePath, "utf8")
  .trim()
  .split("\n")
  .map((line) => SpoolEventSchema.parse(JSON.parse(line)));
const baseRequest = events.find((event) => event.direction === "request" && event.flow_id === "fixture-flow-simple");
const baseResponse = events.find((event) => event.direction === "response" && event.flow_id === "fixture-flow-simple");
if (!baseRequest || !baseResponse) {
  throw new Error("missing simple fixture pair");
}

const root = mkdtempSync(join(tmpdir(), "rootcell-spy-qa17-"));
const store = openSpyStore({ dbPath: join(root, "spy.sqlite"), spoolDir: join(root, "spool") });
try {
  for (const [flowId, ts] of [["qa17-old", 1000], ["qa17-mid", 1100], ["qa17-visible", 1200]]) {
    store.persistRequest(SpoolRequestEventSchema.parse({ ...baseRequest, flow_id: flowId, ts }));
    store.persistResponse(SpoolResponseEventSchema.parse({ ...baseResponse, flow_id: flowId, ts: ts + 1 }));
  }
  const visible = store.listCallSummaries({ since: 1150, limit: 10 });
  const diff = store.getCallDiff("call-qa17-visible");
  console.log(JSON.stringify({
    visibleRangeSince: 1150,
    visibleCallIds: visible.items.map((item) => item.call.id),
    visibleCallStartedAts: visible.items.map((item) => item.call.started_at),
    diffCallId: diff?.call.call.id ?? null,
    diffPreviousCallId: diff?.previousCall?.call.id ?? null,
    diffPreviousStartedAt: diff?.previousCall?.call.started_at ?? null,
    previousIsOutsideVisibleRange: diff?.previousCall
      ? diff.previousCall.call.started_at < 1150
      : null,
    previousIsInVisibleRows: diff?.previousCall
      ? visible.items.some((item) => item.call.id === diff.previousCall.call.id)
      : null,
    diffClassificationCounts: diff?.blocks.reduce((acc, entry) => {
      acc[entry.classification] = (acc[entry.classification] ?? 0) + 1;
      return acc;
    }, {}) ?? null,
  }, null, 2));
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
'
```

The command used `openSpyStore`, `persistRequest`, `persistResponse`,
`listCallSummaries`, and `getCallDiff` from the current implementation. It did
not patch or mock the diff query.

## Store Proof

The reproduction output was:

```json
{
  "visibleRangeSince": 1150,
  "visibleCallIds": [
    "call-qa17-visible"
  ],
  "visibleCallStartedAts": [
    1200
  ],
  "diffCallId": "call-qa17-visible",
  "diffPreviousCallId": "call-qa17-mid",
  "diffPreviousStartedAt": 1100,
  "previousIsOutsideVisibleRange": true,
  "previousIsInVisibleRows": false,
  "diffClassificationCounts": {
    "repeated": 10
  }
}
```

This proved the pre-fix behavior:

- The visible timeline range contains only `call-qa17-visible`.
- The diff baseline for that visible call is `call-qa17-mid`.
- `call-qa17-mid` started before the visible range and is not in the visible
  timeline rows.
- The diff still classifies blocks against that hidden baseline.

## Pre-Fix Source Evidence

Relevant code before the fix:

- `PLAN.md:940-941` defines `SPY-QA-17`: live/ranged views can diff against a
  prior request outside the visible range without saying so.
- `src/spy/store.ts:414-437` applies the active `since`, provider, model,
  operation, status, cursor, and limit filters when listing timeline calls.
- `src/spy/store.ts:470-487` implements `getCallDiff(callId)` by selecting the
  previous call with the same provider, model, and operation before the current
  call. It does not accept or apply active timeline range/search/status filters.
- `src/spy/service.ts:200-207` exposes `GET /api/calls/:id/diff` with only the
  call id. There is no query parameter for the current visible range or filter
  context.
- `src/spy/ui/src/App.tsx:335-338` loads call detail and diff by call id only.
  The active `since`, search, and filter state are not sent with the diff
  request.
- Before the fix, `DiffPanel` rendered only
  `Previous comparable request: <timestamp> · <id>`. It did not explain that
  the baseline was global to all stored comparable calls, nor whether it was
  outside the current visible range.

## Root Cause

`SPY-QA-17` is not caused by incorrect diff matching. The store deliberately
computes a previous-comparable-request baseline across all persisted calls with
the same provider, model, and operation.

The bug is that the browser presents that global baseline inside a ranged or
live timeline without stating its scope. The timeline is range/filter scoped,
but the diff baseline is not. Because the diff endpoint has no range/filter
context and the UI does not derive or display baseline visibility, the operator
can reasonably assume the previous request came from the visible timeline when
it may have come from older hidden capture data.

## Proposed Fix

Keep the current global previous-comparable-request behavior, but make the scope
explicit in the inspector:

- Pass the active visible `since` value to the diff panel.
- In the Diff section, label the baseline as global to stored comparable calls,
  not scoped to the visible timeline.
- When `previousCall.started_at < since`, add an explicit note or badge such as
  `outside current range`.
- For Live mode, phrase the note as outside the current Live window instead of
  implying the call is missing by mistake.
- Add Playwright coverage using a controlled diff response where the selected
  visible call has a previous baseline older than the page's active `since`
  value. The test should fail if the Diff section only shows the previous id and
  timestamp without the outside-range scope text.

Expected proof after the fix:

- A ranged/live view still shows accurate repeated/new/changed counts.
- The same hidden-baseline scenario displays that the previous comparable
  request is outside the current range.
- Existing diff API behavior remains compatible because the fix can be made in
  the browser using data already present in `SpyCallDiff.previousCall`.

## Fix Status

Implemented on 2026-05-24.

Changed `src/spy/ui/src/App.tsx` so the inspector passes the active timeline
range into the Diff section. The Diff section now labels the previous request
as a global baseline across stored comparable calls, and when that previous
request started before the active range it shows an explicit `outside current
range` or `outside current Live window` badge.

The diff API and store behavior are unchanged: `GET /api/calls/:id/diff` still
compares against the previous stored call with the same provider, model, and
operation. The fix makes that global scope visible in the browser.

Added Playwright regression coverage in `src/spy/ui/e2e/spy-ui.playwright.ts`.
The new test routes a visible call at `started_at=2100` with an active
`since=2000`, then returns a diff baseline at `started_at=1900`. It verifies
that the Diff section shows the previous call id, the `outside current range`
badge, and the global-baseline explanation.

Verification commands:

- `bun run typecheck`
- `bun run lint`
- `bun run test:spy-ui:unit`
- `bun run test:spy-ui:e2e` with localhost/browser permission
- `git diff --check`
