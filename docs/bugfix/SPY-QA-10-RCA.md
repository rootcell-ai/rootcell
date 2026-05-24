# SPY-QA-10 RCA: Health Is Hidden When Timeline Filters Return No Calls

## Scope

This RCA covers the highest-priority open spy bug I could prove in the current
tree after reading `PLAN.md`: `SPY-QA-10`.

Triage notes:

- `SPY-QA-02` remains the only open P0 in `PLAN.md`, but it still does not
  reproduce in the current production-built UI.
- `SPY-QA-10` is the first open P1 with concrete current evidence.

This RCA was written before implementation. The fix status below now documents
the implemented change and verification.

## Reproduction Used

- Built the current UI with `bun run build:spy-ui`.
- Started the fixture-backed spy UI service with:
  `bun src/spy/ui/test-server.ts --port 4680 --static dist/spy-ui`
- Opened the production build at `http://127.0.0.1:4680/?since=0`.
- Used the Codex in-app browser in the default `1280 x 720` viewport.
- Verified the fixture service had 5 completed provider calls and 0 pending
  calls.

The fixture server is enough to prove this bug because the failure is in browser
selection and inspector rendering. It does not depend on live provider traffic.

## Higher-Priority No-Repro Proof

After loading the app, selecting the first call, jumping to Health, jumping to
Stream Events, loading stream events, jumping to Raw Payloads, and jumping back
to Health:

```json
{
  "viewport": { "width": 1280, "height": 720 },
  "main": {
    "clientHeight": 720,
    "scrollHeight": 720,
    "scrollTop": 0,
    "overflowY": "hidden",
    "rect": { "top": 0, "bottom": 720, "height": 720 }
  },
  "header": { "rect": { "top": 0, "bottom": 64, "height": 64 } },
  "aside": {
    "clientHeight": 656,
    "scrollHeight": 2318,
    "scrollTop": 1662,
    "overflowY": "auto",
    "rect": { "top": 64, "bottom": 720, "height": 656 }
  },
  "openDetails": [
    "spy-inspector-stream",
    "spy-inspector-raw",
    "spy-inspector-health"
  ],
  "rowCount": 5
}
```

This is a no-repro for `SPY-QA-02`: lower inspector navigation and stream-event
loading kept top-level `main.scrollTop=0`, and the global header stayed pinned at
`y=0`.

## Proof

With the same loaded UI, I changed the Status filter to `Pending`. The fixture
data has no pending calls, so the call list became empty.

Browser measurements immediately after selecting `Pending`:

```json
{
  "statusFilterValue": "pending",
  "statusFilterText": "Pending",
  "timelineRowCount": 0,
  "timelineEmptyText": "No provider calls in this range.",
  "inspectorHeading": "Call Inspector",
  "inspectorSubtext": "Select a provider call.",
  "inspectorEmptyText": "Select a timeline row to inspect the provider call.",
  "inspectorNavCount": 1,
  "healthSectionCount": 0,
  "healthTextVisible": false
}
```

Key observations:

- The active filter is definitely `Pending`.
- The timeline has no rows.
- The inspector has been replaced by the empty call-selection state.
- The health section is not in the DOM (`healthSectionCount: 0`).
- Health labels such as `Dropped captures`, `Last ingest`, and `Schema` are not
  visible.
- A stale inspector section nav can remain, but its `Health` target no longer
  exists.

The service health API is still valid at the same time:

```json
{
  "ok": true,
  "service": {
    "enabled": true,
    "bind": "127.0.0.1",
    "port": 4680,
    "retentionDays": 7,
    "maxBytes": 6442450944,
    "spoolMaxBytes": 1073741824,
    "storeRaw": false,
    "staticAssets": true
  },
  "store": {
    "schemaVersion": 2,
    "dbSizeBytes": 274432,
    "dbUsedBytes": 274432,
    "spoolSizeBytes": 0,
    "providerCallCount": 5,
    "pendingCallCount": 0,
    "droppedCaptureCount": 0,
    "lastIngestAt": 1779581016.454
  }
}
```

This proves the health data exists and the backend is healthy, but the UI makes
that data unreachable when no timeline call is selected.

## Source Evidence

Relevant current code:

- `PLAN.md:895-897` defines `SPY-QA-10`: keep service Health reachable
  independently of selected calls.
- `src/spy/ui/src/App.tsx:176-184` chooses `page.items[0]?.call.id` as the
  selected call after a non-append load. When a filter returns no calls, that
  resolves to `undefined`.
- `src/spy/ui/src/App.tsx:300-302` derives `selectedSummary` only by finding the
  selected id in the current visible call page.
- `src/spy/ui/src/App.tsx:876-877` renders `EmptyInspector` whenever
  `props.summary === null`.
- `src/spy/ui/src/App.tsx:1008-1013` renders the Health section only inside
  `InspectorContent`, which is only used for a loaded selected call.
- `src/spy/ui/src/App.tsx:1516-1536` has the independent health panel data, but
  there is no selected-call-independent route to render it.
- `src/spy/ui/src/App.tsx:211-219` and `src/spy/ui/src/api.ts:170-173` already
  fetch `/api/health` independently of call detail, so the problem is not API
  availability.

## Root Cause

`SPY-QA-10` is a browser composition bug.

The app stores service health independently, but the only full health display is
nested inside the selected-call inspector content. When filters or search return
an empty page, `loadCalls()` clears the effective selected call by resolving the
next selection to `undefined`. That makes `selectedSummary` become `null`, and
`CallInspector` renders the empty call-selection state instead of
`InspectorContent`. Because the Health section is inside `InspectorContent`, it
is removed along with the call detail sections.

This couples service health to call selection even though `/api/health` is
call-independent.

## Proposed Fix

Fix `SPY-QA-10` by giving service health a selected-call-independent render path:

- Keep the call-native inspector behavior for selected call details.
- When no call is selected, render a useful inspector empty state that includes
  the same service health panel or a dedicated compact health/status panel.
- Hide the inspector section nav unless its target sections actually exist, or
  include a Health target that exists in the no-call state.
- Preserve current selected-call health rendering so operators can still see
  health while inspecting a call.
- Add Playwright coverage for an empty filter result that verifies `/api/health`
  data remains visible in the inspector.

Expected proof after the fix:

- Applying a `Pending` filter with zero pending calls should still show service
  health values such as Enabled, DB size, Spool size, Calls, Pending, and Schema.
- The no-call inspector should not expose dead section navigation targets.
- `/api/health` and visible health values should agree.

## Fix Status

Implemented on 2026-05-23.

Changed `src/spy/ui/src/App.tsx` so the no-call inspector state renders a
selected-call-independent Service Health panel using the existing health data.
The inspector section navigator now requires an actual selected call, so empty
filter/search results no longer expose dead call-section targets.

Added Playwright coverage in `src/spy/ui/e2e/spy-ui.playwright.ts` for applying
a `Pending` filter with zero matching calls and verifying that service health
remains visible in the inspector.

Verification commands:

- `bun run typecheck`
- `bun run lint`
- `bun run test:spy-ui:e2e`
