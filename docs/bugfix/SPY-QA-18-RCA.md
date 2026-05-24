# SPY-QA-18 RCA: Timeline Hides Provider Cache Read/Write

## Scope

This RCA covers the highest-priority open spy bug in `PLAN.md`: `SPY-QA-18`.

Triage notes:

- `PLAN.md` marks all P0 spy bugs closed.
- `PLAN.md` marks `SPY-QA-01` through `SPY-QA-17` complete or closed.
- `SPY-QA-18` is the first unchecked item in the prioritized handoff, and it is
  a P1 issue.
- This document was written before any product-code fix for `SPY-QA-18`.

## Reproduction Used

I used the production-built spy UI and a headless Chromium run with mocked API
responses matching the real cache-heavy shape recorded in `PLAN.md`.

Commands used:

- `bun run build:spy-ui`
- `python3 -m http.server 4691 --bind 127.0.0.1 --directory dist/spy-ui`
- A one-off Playwright script opened
  `http://127.0.0.1:4691/?preset=today`, fulfilled `/api/*` with a single
  complete Bedrock call, and read the timeline row plus inspector text.

The mocked call summary intentionally contained both provider cache usage and
request cache markers:

```json
{
  "usage": {
    "inputTokens": 10,
    "outputTokens": 98,
    "cacheReadTokens": 5200,
    "cacheWriteTokens": 81,
    "totalTokens": 5389
  },
  "cacheMarkerCount": 2,
  "requestBlockCount": 26,
  "responseBlockCount": 3
}
```

## Proof

Runtime browser output from the current UI:

```json
{
  "apiSummaryUsage": {
    "inputTokens": 10,
    "outputTokens": 98,
    "cacheReadTokens": 5200,
    "cacheWriteTokens": 81,
    "totalTokens": 5389
  },
  "apiSummaryCacheMarkerCount": 2,
  "timelineRowText": "claude-haiku-4-5-20251001-v1:0\ncomplete\ncache 2\n09:25:03 PM\ninput 18 KiB\noutput 1.2 KiB\nusage 5.4k tok\nduration 1.4 s\nconverse-stream \u00b7 26 request blocks \u00b7 3 response blocks",
  "usageSectionText": "Usage Records\ninput\n10\noutput\n98\ncache read\n5,200\ncache write\n81\ntotal\n5,389",
  "requestCompositionProviderUsageLines": [
    "Provider usage",
    "5.4k tok",
    "in 10 \u00b7 out 98 \u00b7 cache 5,200/81"
  ],
  "timelineContainsCacheReadLabelOrValue": false,
  "timelineContainsCacheWriteLabelOrValue": false
}
```

Key observations:

- The API summary had `cacheReadTokens=5200` and `cacheWriteTokens=81`.
- The inspector Usage Records panel showed `cache read 5,200` and
  `cache write 81`.
- The Request Composition panel also showed `cache 5,200/81`.
- The timeline row did not include the cache read/write labels or values.
- The only cache-looking timeline text was `cache 2`, which is the request
  cache marker count, not provider cache read/write usage.

This reproduces the exact bug described in `PLAN.md`: cache-read and
cache-write calls look nearly identical from the row alone, and the `cache 2`
badge can be mistaken for provider cache accounting.

## Pre-Fix Source Evidence

The data is already present in the browser API contract:

- `src/spy/api-contracts.ts:65-70` defines `SpyUsageSummary` with
  `cacheReadTokens` and `cacheWriteTokens`.
- `src/spy/api-contracts.ts:73-82` includes that usage summary and
  `cacheMarkerCount` on each timeline call summary.

The store already computes those fields:

- `src/spy/store.ts:982-996` returns `usage` and `cacheMarkerCount` in
  `callSummaryForRow`.
- `src/spy/store.ts:999-1016` sums `cache_read_tokens` and
  `cache_write_tokens` into the summary usage object.

The current timeline row drops the provider cache breakdown:

- `src/spy/ui/src/App.tsx:838-842` renders
  `cache {summary.cacheMarkerCount}` as a badge.
- `src/spy/ui/src/App.tsx:844-848` renders `usage` with
  `formatUsageTotal(summary.usage)`, which only exposes total tokens in the
  row.

Other inspector surfaces prove the UI can display the same data when it chooses
to:

- `src/spy/ui/src/App.tsx:1168-1172` shows provider usage in Request
  Composition.
- `src/spy/ui/src/App.tsx:1215-1220` formats that composition detail with
  input, output, and `cache <read>/<write>` values.
- `src/spy/ui/src/App.tsx:1344-1356` renders Usage Records with explicit
  `cache read` and `cache write` cells.

## Root Cause

`SPY-QA-18` is a browser timeline rendering bug, not an ingestion, store, or API
bug.

Two different cache concepts reach the row:

- `summary.cacheMarkerCount`: the number of request cache marker blocks.
- `summary.usage.cacheReadTokens` and `summary.usage.cacheWriteTokens`: provider
  reported cache read/write token counts.

The timeline renders only the marker count as `cache N` and the provider usage
as total tokens. Because `formatUsageTotal(summary.usage)` discards the usage
breakdown, cache-heavy calls cannot be distinguished from ordinary calls in the
timeline. The `cache N` label then makes the row ambiguous because it looks like
provider cache accounting while actually meaning request marker count.

## Proposed Fix

Fix the timeline row display while keeping the existing API/store shape:

- Remove the marker badge from the high-level timeline row.
- Replace total provider usage with separate read, write, cache-read, and
  cache-write token classes.
- Add Playwright coverage with a synthetic cache-heavy call where the row must
  expose all four values and omit total `tok` usage plus marker-count text.

Expected proof after the fix:

- The same mocked call shows provider cache read/write in the timeline row.
- The marker count is absent from the high-level row.
- Inspector Usage Records and Request Composition continue to show the same
  values.

## Fix Status

Implemented on 2026-05-24.

Changed `src/spy/ui/src/App.tsx` so timeline rows now show provider usage as
four separate token classes:

- `read` from `summary.usage.inputTokens`
- `write` from `summary.usage.outputTokens`
- `cache read` from `summary.usage.cacheReadTokens`
- `cache write` from `summary.usage.cacheWriteTokens`

The row no longer renders the request cache-marker count badge, and it no
longer renders total provider usage as a combined `tok` value. Request bytes,
response bytes, duration, operation, and block counts remain in the row metadata
line.

Added Playwright regression coverage in `src/spy/ui/e2e/spy-ui.playwright.ts`
using a synthetic cache-heavy call with `read=10`, `write=98`,
`cache read=5200`, `cache write=81`, and `cacheMarkerCount=2`. The test proves
that the timeline row shows all four provider token classes and does not show
`usage`, `tok`, or `cache 2`.

Post-fix browser smoke against the built fixture UI showed the first row as:

```text
read
1,253
write
8
cache read
-
cache write
-
converse-stream ... input 2.6 KiB ... output 217 B ... 1.0 s
```

The same browser check confirmed `tok=false` and ambiguous cache-marker text
matching `cache <number>` was absent.

Verification commands:

- `bun run typecheck`
- `bun run lint`
- `bun run test:spy-ui:unit`
- `bunx playwright test -c src/spy/ui/playwright.config.ts -g "shows provider cache token classes"`
- `bun run test:spy-ui:e2e`
