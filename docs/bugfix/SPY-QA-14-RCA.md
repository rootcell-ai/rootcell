# SPY-QA-14 RCA: Search Scope Excludes Visible Call And Model Identifiers

## Scope

This RCA covers the highest-priority open spy bug I could prove in the current
tree after reading `PLAN.md`: `SPY-QA-14`.

Triage notes:

- `PLAN.md` marks `SPY-QA-01` through `SPY-QA-13` complete or closed.
- `SPY-QA-14` is the first unchecked item in the prioritized handoff, and it is
  a P1 issue.
- This document was written before implementation. No application source code
  has been changed for this bug yet.

## Reproduction Used

I rebuilt the current spy UI and ran the fixture-backed service:

```sh
bun run build:spy-ui
bun src/spy/ui/test-server.ts --port 0 --static dist/spy-ui
```

The sandboxed server start failed on localhost bind, so I reran the same server
command with localhost permission. The server started at:

```text
rootcell spy UI test server listening on http://127.0.0.1:39845
```

## Browser Proof

I launched headless Chromium against the production-built UI and captured the
current DOM behavior. Result:

```json
{
  "initialRows": 5,
  "searchPlaceholder": "Search text",
  "searchAriaLabel": "Search normalized text",
  "firstRowAriaLabel": "Open call call-fixture-flow-tool-result",
  "visibleInspectorCallId": "call-fixture-flow-tool-result",
  "rowsAfterCallIdSearch": 0,
  "emptyTextAfterCallIdSearch": "No provider calls match the current search or filters.",
  "rowsAfterModelFragmentSearch": 0,
  "emptyTextAfterModelSearch": "No provider calls match the current search or filters.",
  "rowsAfterNormalizedTextSearch": 5
}
```

This proves the bug as currently shipped:

- The UI exposes `call-fixture-flow-tool-result` as a call identifier.
- The search placeholder only says `Search text`.
- Searching the visible call id returns zero rows.
- Searching the visible model fragment `sonnet` returns zero rows.
- Searching normalized body text, `Fixture capture`, returns five rows.

## API Proof

The same fixture service proves the backend scope mismatch.

Baseline calls include visible searchable-looking identifiers:

```sh
curl -sS 'http://127.0.0.1:39845/api/calls?since=0&limit=10'
```

The response includes five calls, including:

```json
{
  "id": "call-fixture-flow-tool-result",
  "model_id": "us.anthropic.claude-sonnet-4-6",
  "request_flow_id": "fixture-flow-tool-result",
  "response_flow_id": "fixture-flow-tool-result"
}
```

But searching those visible fields returns no matches:

```sh
curl -sS 'http://127.0.0.1:39845/api/search?since=0&limit=10&q=call-fixture-flow-tool-result'
```

```json
{"items":[]}
```

```sh
curl -sS 'http://127.0.0.1:39845/api/search?since=0&limit=10&q=sonnet'
```

```json
{"items":[]}
```

Normalized text search still works:

```sh
curl -sS 'http://127.0.0.1:39845/api/search?since=0&limit=10&q=Fixture%20capture'
```

That response returns all five calls.

## Source Evidence

Relevant current code:

- `PLAN.md:924-926` defines `SPY-QA-14`: search scope must clarify whether it
  includes call ids, model ids, or metadata.
- `PLAN.md:995-997` records the specific evidence note: search scopes to
  normalized block text and call-id fragments return no results while the
  placeholder says `Search text`.
- `src/spy/ui/src/App.tsx:659-663` renders the search input with
  `aria-label="Search normalized text"` but visible placeholder `Search text`.
- `src/spy/ui/src/App.tsx:829` exposes timeline row call ids in accessible names.
- `src/spy/ui/src/App.tsx:837` shows the shortened model id in timeline rows.
- `src/spy/ui/src/App.tsx:914-918` shows the shortened model id and call id in
  the inspector header.
- `src/spy/ui/src/api.ts:135-137` sends any submitted search string to
  `/api/search?q=...`.
- `src/spy/store.ts:548-580` implements search by matching only
  `normalized_block_fts` rows joined back to provider calls.
- `src/spy/migrations.ts:82-83` defines `normalized_block_fts` with only
  `block_id` and normalized block `text`.
- `src/spy/migrations.ts:148-153` populates the FTS table only from
  `normalized_block.text`.

## Root Cause

`SPY-QA-14` is a search contract and presentation mismatch.

The service implements search as normalized block text search only. It does not
index or query `provider_call` identifiers such as `id`, `model_id`,
`request_flow_id`, or `response_flow_id`. The browser then presents visible and
accessible identifiers next to a generic visible placeholder, `Search text`,
without telling the operator that those identifiers are outside the search
scope.

That combination makes visible operational keys look searchable even though the
backend cannot match them.

## Proposed Fix

Fix `SPY-QA-14` by making search scope explicit and useful for visible
identifiers:

- Extend `/api/search` to include exact or substring matches for provider-call
  metadata that the UI already exposes: call id, request flow id, response flow
  id, model id, provider, operation, and status.
- Preserve the existing normalized-block FTS behavior for prompt/response text.
- Deduplicate calls when both normalized text and metadata match.
- Update the visible placeholder and accessible label to name the real scope,
  for example `Search text, call ID, or model`.
- Add unit coverage at the store/API-helper layer proving call id and model id
  searches return the expected call.
- Add Playwright coverage proving a visible call id and visible model fragment
  both return timeline rows, while normalized text search continues to work.

Expected proof after the fix:

- `q=call-fixture-flow-tool-result` returns the matching call.
- `q=sonnet` returns the fixture calls with model
  `us.anthropic.claude-sonnet-4-6`.
- `q=Fixture capture` still returns normalized-text matches.
- The search control no longer exposes the ambiguous visible placeholder
  `Search text`.

## Fix Status

Implemented on 2026-05-24.

Changed `src/spy/store.ts` so `/api/search` matches both normalized block FTS
text and visible provider-call metadata: call id, request flow id, response flow
id, model id, provider, operation, and status. Metadata matches are unioned with
normalized text matches and deduplicated before the existing time/provider/
model/operation/status filters and pagination are applied.

Changed `src/spy/ui/src/App.tsx` so the search input now labels the real scope
as `Search text, call ID, or model`.

Added regression coverage:

- `src/spy/store.test.ts` proves call id, flow id, model fragment, normalized
  text, and filtered metadata searches.
- `src/spy/service.test.ts` proves the HTTP `/api/search` endpoint returns
  matches for a call id and model fragment.
- `src/spy/ui/e2e/spy-ui.playwright.ts` proves the production UI can search a
  visible call id, visible model fragment, and normalized text.

Verification commands:

- `bun test src/spy/store.test.ts --timeout 10000`
- `bun test src/spy/service.test.ts --timeout 10000`
- `bun run typecheck`
- `bun run lint`
- `bun run test:spy-ui:unit`
- `bun run test`
- `bun run test:spy-ui:e2e`
