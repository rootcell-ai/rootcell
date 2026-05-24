# SPY-QA-11 RCA: Empty Timeline Copy Ignores Active Filters

## Scope

This RCA covers the highest-priority open spy bug I could prove in the current
tree after reading `PLAN.md`: `SPY-QA-11`.

Triage notes:

- `PLAN.md` marks `SPY-QA-01` through `SPY-QA-10` complete.
- `SPY-QA-11` is the first unchecked item in the prioritized handoff, and it is
  a P1 issue.
- This document was written before implementation. No application code has been
  changed for this bug yet.

## Reproduction Used

I rebuilt the current spy UI and ran the existing fixture-backed Playwright
coverage against the production artifact.

Targeted proof commands:

```sh
bun run build:spy-ui
./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts -g "keeps service health visible"
```

Result:

```text
bun run build:spy-ui
✓ built in 117ms

./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts -g "keeps service health visible"
1 passed
```

The first sandboxed attempt failed before running the test because the local
test server could not bind its localhost port. I reran the same targeted
Playwright command with localhost/browser permission, and the test completed
successfully.

## Proof

The passing Playwright test proves the current bad copy is present in a filtered
empty result state:

- The fixture-backed UI starts with 5 visible provider-call rows.
- The test selects the `Pending` status filter.
- The visible timeline row count becomes 0.
- The same test then expects and finds the text:
  `No provider calls in this range.`

That is the exact failure mode described in `PLAN.md`: there are calls in the
range, but active filters exclude them, and the UI claims the range has no
provider calls.

This existing test currently locks in the incorrect copy:

```ts
await expect(page.getByTestId("timeline-row")).toHaveCount(5);
await page.getByLabel("Filter by status").selectOption("pending");
await expect(page.getByTestId("timeline-row")).toHaveCount(0);
await expect(page.getByText("No provider calls in this range.")).toBeVisible();
```

There is a second filtered/search empty-state test with the same assertion after
choosing a mismatched operation filter and after adding a search term while that
filter is still active.

## Source Evidence

Relevant current code:

- `PLAN.md:903-905` defines `SPY-QA-11`: a `Pending` filter can produce the
  copy `No provider calls in this range` even though filters excluded calls.
- `src/spy/ui/src/App.tsx:128-134` stores provider, model, operation, status,
  and block-kind filters in React state.
- `src/spy/ui/src/App.tsx:163-171` sends `search`, provider, model, operation,
  and status to the API when loading timeline calls.
- `src/spy/ui/src/App.tsx:528-540` passes the filter state into
  `TimelineControls`, so the controls know which filters are active.
- `src/spy/ui/src/App.tsx:554-563` renders `Timeline` with only `calls`,
  selection, loading, pagination, and callbacks. It does not pass `search`,
  filter state, or any unfiltered range count into `Timeline`.
- `src/spy/ui/src/App.tsx:742-749` confirms the `Timeline` props have no
  filter/search context.
- `src/spy/ui/src/App.tsx:759-763` hard-codes the only empty-state message to
  `No provider calls in this range.` whenever `calls.length === 0` and loading
  is false.
- `src/spy/ui/e2e/spy-ui.playwright.ts:328-335` proves the filtered empty state
  with 5 initial rows, a `Pending` status filter, 0 resulting rows, and the
  range-only empty copy.
- `src/spy/ui/e2e/spy-ui.playwright.ts:314-324` similarly proves the same copy
  after an operation filter and search return no rows.

## Root Cause

`SPY-QA-11` is a browser presentation-state bug.

The app correctly tracks active search/filter inputs and sends them to the API,
but the timeline empty-state renderer is isolated from that context. `Timeline`
receives the already-filtered page of calls and a loading flag. When the page is
empty, it has no way to distinguish these cases:

- There are no provider calls in the selected time range.
- There are provider calls in the selected time range, but active filters or
  search excluded them.

Because the component cannot tell those cases apart, it always renders the
range-only message. The current e2e tests assert that behavior, so the test suite
does not protect the intended UX yet.

## Proposed Fix

Fix `SPY-QA-11` by making the timeline empty state aware of the active query
context:

- Compute whether timeline query constraints are active in `App` from submitted
  search plus provider/model/operation/status filters.
- Pass a small empty-state descriptor into `Timeline`, rather than making
  `Timeline` infer app-level state.
- Keep the existing `No provider calls in this range.` copy only when no
  search/filter constraints are active.
- When constraints are active, render copy that says the current filters/search
  excluded calls in the selected range.
- Include the active constraints in concise supporting copy if it can be done
  without turning this into `SPY-QA-12` or `SPY-QA-13`.
- Update Playwright coverage so the `Pending` filtered-empty case expects the
  filter-aware copy, while the clear-data/no-range-data case still expects the
  range-only copy.

Expected proof after the fix:

- Applying a `Pending` filter when the range has completed calls but no pending
  calls should no longer show `No provider calls in this range.`
- Clearing data, where the range truly has no calls, should still show the
  range-only empty-state copy.
- Existing health visibility coverage from `SPY-QA-10` should remain intact.

## Fix Status

Implemented on 2026-05-24.

Changed `src/spy/ui/src/App.tsx` so `App` derives whether the timeline query is
constrained by submitted search text or provider/model/operation/status filters,
then passes that empty-state descriptor into `Timeline`. `Timeline` now keeps
`No provider calls in this range.` only for unconstrained range-empty states and
uses `No provider calls match the current search or filters.` when active query
constraints produce an empty list.

Updated `src/spy/ui/e2e/spy-ui.playwright.ts` so filtered/search empty states
expect the query-aware copy and assert the range-only copy is absent. The
clear-data test still expects the range-only copy, proving true range-empty
states were preserved.

Verification commands:

- `bun run typecheck`
- `bun run lint`
- `bun run build:spy-ui`
- `bun run test:spy-ui:unit`
- `./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts`
