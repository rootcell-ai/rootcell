# SPY-QA-34 RCA: Singular Call Count Grammar

This RCA was written before implementation for the highest-priority open spy
bug in the current tree.

## Priority Selection

- `PLAN.md:1052-1056` marks the last P2 spy QA item complete or closed.
- `PLAN.md:1058` lists `SPY-QA-34` as the first unchecked spy bug.
- `SPY-QA-34` is therefore the highest-priority open spy bug.

## Bug

`PLAN.md:1058` defines the bug:

> [P3] SPY-QA-34: Fix singular/plural call count grammar (`1 calls`).

The timeline footer uses plural grammar even when the current visible timeline
contains exactly one provider call.

## Reproduction

I reproduced this against the current production spy UI build before changing
product code:

1. Built the browser UI with `bun run build:spy-ui`.
2. Started the existing fixture-backed spy UI service with
   `bun run src/spy/ui/test-server.ts --port 0 --static dist/spy-ui`.
3. Opened the printed URL, `http://127.0.0.1:32406`, in the in-app browser.
4. Selected the `10 min` timeline range so the fixture calls were visible.
5. Searched for the unique visible call id `call-fixture-flow-simple`.

Screenshot captured before the fix:


The footer at the lower-left of the timeline reads `1 calls`.

## Reproducibility Proof

The fixture service API returned exactly one call for the search term:

```json
{
  "items": [
    {
      "call": {
        "id": "call-fixture-flow-simple",
        "provider": "bedrock",
        "operation": "converse-stream",
        "status": "complete"
      }
    }
  ]
}
```

The browser DOM after the same UI search measured:

```json
{
  "footerText": "1 calls\nLoad More",
  "rowCount": 1,
  "bodyIncludesOneCalls": true
}
```

This proves the bug is reproducible:

- the data source has exactly one matching provider call
- the timeline renders exactly one row
- the visible footer text still says `1 calls`

## Source Evidence

`src/spy/ui/src/App.tsx:804` uses the visible call array length as the
virtualizer count:

```tsx
count: props.calls.length,
```

`src/spy/ui/src/App.tsx:827` renders timeline rows from that same array:

```tsx
const summary = props.calls[virtualRow.index];
```

`src/spy/ui/src/App.tsx:853` renders the footer count from the same array
length, but hardcodes the plural noun:

```tsx
<span>{formatNumber(props.calls.length)} calls</span>
```

`src/spy/ui/src/format.ts:76-78` shows that `formatNumber` only formats the
number. It does not select singular or plural labels:

```ts
export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : NUMBER_FORMAT.format(value);
}
```

There is already a local example of correct singular/plural handling at
`src/spy/ui/src/App.tsx:1171`:

```tsx
return `${formatNumber(blocks.length)} ${blocks.length === 1 ? "block" : "blocks"} · ${formatBytes(byteSize)}`;
```

## Root Cause

`SPY-QA-34` is a presentation bug in the `Timeline` footer.

The UI correctly computes and renders the visible timeline rows from
`props.calls`. The footer uses the same count, so the count itself is not stale
or incorrect. The root cause is that the footer concatenates a formatted number
with the literal plural string `calls`, independent of whether the count is
`1`.

## Proposed Fix

Add a small count-label formatter and use it in the timeline footer.

Recommended implementation:

- Add a helper near `formatNumber`, for example
  `formatCount(count, "call", "calls")`.
- Update the timeline footer to render `formatCount(props.calls.length, "call")`.
- Add unit coverage for `0 calls`, `1 call`, and `2 calls`.
- Add focused Playwright coverage that constrains the timeline to one visible
  call and asserts `1 call` is visible while `1 calls` is absent.

The fix should be display-only. It should not change API contracts, call
filtering, search behavior, virtualizer state, or persisted spy data.

## Expected Proof After Fix

Rerunning the same reproduction should show:

- the API still returns one item for `call-fixture-flow-simple`
- the timeline still renders one row
- the footer renders `1 call`
- `1 calls` no longer appears in the page body

## Fix Implemented

The implementation added `formatCount` in `src/spy/ui/src/format.ts` and changed
the timeline footer in `src/spy/ui/src/App.tsx` to use it for the visible call
count.

The helper keeps number formatting centralized and selects the singular label
only when the count is exactly `1`. The timeline data path is unchanged.

Regression coverage added:

- `src/spy/ui/src/format.test.ts` covers `0 calls`, `1 call`, `2 calls`, and an
  irregular plural override.
- `src/spy/ui/e2e/spy-ui.playwright.ts` searches the fixture timeline down to
  one visible call, asserts the footer says `1 call`, and asserts `1 calls` is
  absent.

## Proof After Fix

After rebuilding the UI and rerunning the same fixture-backed reproduction, the
browser DOM measured:

```json
{
  "footerText": "1 call\nLoad More",
  "rowCount": 1,
  "badTextCount": 0
}
```

Screenshot captured after the fix:


Verification commands:

- `bun test src/spy/ui/src/format.test.ts --timeout 10000`
- `bun run build:spy-ui`
- `./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts -g "uses singular grammar"`
- `bun run typecheck`
- `bun run lint`
- `bun run test:spy-ui:unit`
- `bun run test:spy-ui:e2e`
