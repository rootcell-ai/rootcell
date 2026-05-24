# SPY-QA-28 RCA: Full Provider Model ID Is Hidden From Prominent UI Surfaces

This RCA was written before implementation for the highest-priority open spy bug
at diagnosis time: `SPY-QA-28`.

## Priority Selection

- `PLAN.md:1019-1020` lists `SPY-QA-28` as the first unchecked spy bug.
- All P0 and P1 spy QA findings are complete or closed in `PLAN.md`.
- `SPY-QA-22` through `SPY-QA-27` are also complete or closed.
- `SPY-QA-28` is therefore the highest-priority open spy bug in the current
  handoff.
- This document was written before any product-code fix for `SPY-QA-28`.

## Bug Definition

`PLAN.md:1019-1020` defines the bug:

```text
[P2] SPY-QA-28: Show the full provider model id somewhere prominent. The
normal row/header omit the `us.anthropic.` Bedrock namespace.
```

`PLAN.md:1055-1057` adds the evidence note:

```text
SPY-QA-28: The normal timeline row and inspector header show the shortened
model id but not the full Bedrock namespace, so exact model verification
requires the API or Network Metadata.
```

## Reproduction Evidence

I built the current spy UI and started the fixture-backed spy service:

```sh
bun run build:spy-ui
bun run src/spy/ui/test-server.ts --port 5199 --static dist/spy-ui
```

The first server bind attempts on ports `5098` and `5199` failed inside the
sandbox with `EADDRINUSE`. The escalated localhost server run succeeded and
reported:

```text
rootcell spy UI test server listening on http://127.0.0.1:5199
```

I then queried the API directly:

```sh
curl -s 'http://127.0.0.1:5199/api/calls?limit=1'
```

The API response includes the full provider model id:

```json
{
  "call": {
    "id": "call-fixture-flow-tool-result",
    "provider": "bedrock",
    "operation": "converse-stream",
    "model_id": "us.anthropic.claude-sonnet-4-6",
    "status": "complete"
  }
}
```

I also opened the built UI with headless Chromium at
`http://127.0.0.1:5199/?preset=10m`, selected the first timeline row, and
captured the visible text from the row, inspector sticky header, and summary
section.

Probe output:

```json
{
  "location": "http://127.0.0.1:5199/?preset=10m",
  "fullModelId": "us.anthropic.claude-sonnet-4-6",
  "shortModelId": "claude-sonnet-4-6",
  "timelineRowText": "claude-sonnet-4-6\ncomplete\n07:47:45 AM\nread\n1,253\nwrite\n8\ncache read\n-\ncache write\n-\nconverse-stream · input 2.6 KiB · output 217 B · 1.0 s · 9 request blocks · 3 response blocks",
  "inspectorHeaderText": "claude-sonnet-4-6\n\ncall-fixture-flow-tool-result\n\ncomplete\nSummary\nComposition\nRequest\nResponse\nDiff\nUsage\nNetwork\nStream\nRaw\nHealth",
  "summaryText": "Started\nMay 24, 07:47:45 AM\nDuration\n1.0 s\nRequest\n2.6 KiB\nTotal Usage\n1.3k tok",
  "bodyContainsFullModelId": false,
  "timelineRowContainsFullModelId": false,
  "inspectorHeaderContainsFullModelId": false,
  "summaryContainsFullModelId": false,
  "bodyContainsShortModelId": true
}
```

This proves the reported failure:

- The backend returns the full model id.
- The visible timeline row displays only `claude-sonnet-4-6`.
- The sticky inspector header displays only `claude-sonnet-4-6`.
- The summary section does not add the full model id.
- The full id `us.anthropic.claude-sonnet-4-6` is absent from the page's visible
  text in the default selected-call inspection path.

## Code Evidence

The data contract and store preserve the full model id:

- `src/spy/api-contracts.ts:73-84` exposes `SpyCallSummary.call` as a full
  `ProviderCall`.
- `src/spy/store.ts:1321-1335` maps `row.model_id` directly to
  `ProviderCall.model_id`.

The UI then shortens that full value in the prominent surfaces:

- `src/spy/ui/src/format.ts:94-103` implements `shortModelId`. For a Bedrock
  model id whose first dot segment is a two-letter region, it returns
  `parts.slice(2).join(".")`. That transforms
  `us.anthropic.claude-sonnet-4-6` into `claude-sonnet-4-6`.
- `src/spy/ui/src/App.tsx:879-881` renders the timeline row model label as
  `shortModelId(summary.call.model_id)`.
- `src/spy/ui/src/App.tsx:960-962` renders the inspector header title as
  `shortModelId(props.summary.call.model_id)`.
- `src/spy/ui/src/App.tsx:1147-1158` renders the top summary panel with Started,
  Duration, Request, and Total Usage metrics, but no full model id.

## Root Cause

`SPY-QA-28` is a browser presentation bug, not a capture, normalization, store,
or API bug.

The full provider model id is retained by the service and API, but the UI uses
`shortModelId` for both prominent model labels and does not provide a nearby
full-id fallback in the inspector summary. The shortening was useful for compact
rows, but it removed Bedrock's namespace/region prefix from every prominent
default inspection surface. As a result, exact model verification requires
leaving the normal row/header path and checking the raw API response or less
prominent network metadata.

## Fix Plan

Fix `SPY-QA-28` in `src/spy/ui/src/App.tsx` without changing the stored model id
or API contract:

- Keep compact row/title labels if needed for layout, but expose the full
  `summary.call.model_id` in at least one prominent selected-call surface.
- Prefer adding a full `Model ID` field to the top inspector summary area so the
  exact provider id is visible immediately after selecting a call.
- Add a `title` or accessible label on compact row/header model text only if it
  can be done without making the visual UI noisy.
- Keep the model filter values unchanged; they already use the full model id as
  the option value.

## Verification Plan

After implementation:

- Add or update Playwright coverage so selecting a fixture call proves
  `us.anthropic.claude-sonnet-4-6` is visible in a prominent inspector surface.
- Preserve existing compact model behavior where the row/header intentionally
  uses `claude-sonnet-4-6`.
- Run:

```sh
bun run build:spy-ui
bun run test:spy-ui:unit
./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts -g "model"
```

Depending on touched files, also run the broader spy/UI suite before closing the
bug.

## Implemented Fix

Changed `src/spy/ui/src/App.tsx` so the selected-call Summary panel renders a
prominent `Model ID` field above the existing Started/Duration/Request/Usage
metrics. The field uses the exact `summary.call.model_id` value and wraps with
`break-all`, so Bedrock namespace prefixes such as `us.anthropic.` remain
visible without requiring Network Metadata or API inspection.

The compact timeline row and sticky inspector title still use `shortModelId` to
avoid crowding those narrow surfaces.

Added Playwright coverage in `src/spy/ui/e2e/spy-ui.playwright.ts` proving:

- The normal timeline row still displays the compact
  `claude-sonnet-4-6` label.
- The timeline row does not expose the full id inline.
- After selecting the row, the Summary panel shows `Model ID` and the exact
  `us.anthropic.claude-sonnet-4-6` value.

Updated `PLAN.md` to mark `SPY-QA-28` complete.

## Verification Results

Ran:

```sh
bun run build:spy-ui
bun run test:spy-ui:unit
./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts -g "full provider model id"
bun run typecheck
bun run lint
git diff --check
bun run test:spy-ui:e2e
```

Results:

- `bun run build:spy-ui` passed.
- `bun run test:spy-ui:unit` passed: 19 tests.
- Focused Playwright regression passed: 1 test.
- `bun run typecheck` passed.
- `bun run lint` passed.
- `git diff --check` passed.
- Full `bun run test:spy-ui:e2e` passed: 22 tests.

I also served the built fixture UI at `http://127.0.0.1:5201/?preset=10m` and
verified it through the in-app browser:

```json
{
  "modelCount": 1,
  "rowCount": 5,
  "modelText": "Model ID\nus.anthropic.claude-sonnet-4-6",
  "rowTextIncludesFull": false,
  "modelTextIncludesFull": true
}
```
