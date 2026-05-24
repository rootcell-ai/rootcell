# SPY-QA-35 RCA: Timeline Metric Chips Clip Cache Labels

This RCA was written before any product-code fix for the highest-priority open
spy bug in the current tree.

## Priority Selection

- `PLAN.md:1058-1062` marks `SPY-QA-34` fixed.
- `PLAN.md:1063-1065` lists `SPY-QA-35` as the first unchecked spy bug.
- `PLAN.md:1066-1067` lists `SPY-QA-36` after it at the same P3 priority.
- Therefore `SPY-QA-35` is the highest-priority open spy bug.

## Bug

`PLAN.md:1063-1065` defines the bug:

> [P3] SPY-QA-35: Loosen timeline row chips/badges. Long token labels,
> token values, and timestamps can wrap or clip into awkward multi-line
> fragments.

The reproduced current symptom is that timeline usage chips truncate
`cache read` and `cache write` even though the API data and accessible row label
contain the full labels and values.

## Reproduction

I reproduced this against the current production spy UI build without changing
product code:

1. Built the current browser bundle with `bun run build:spy-ui`.
2. Served `dist/spy-ui` through a temporary localhost mock API with one
   cache-heavy Bedrock call.
3. Opened `http://127.0.0.1:42785/?since=0` in the in-app browser.
4. Set the browser viewport to `1100 x 850`, matching the normal desktop-width
   viewport used by nearby spy UI regression tests.

Screenshot captured before a fix:


The row visibly renders `cach... 5,200` and `cache wr... 81`.

## Reproducibility Proof

The mocked API returned exactly one call with full cache token classes:

```json
{
  "items": [
    {
      "call": {
        "id": "call-spy-qa-35-cache-row",
        "model_id": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "status": "complete"
      },
      "usage": {
        "inputTokens": 10,
        "outputTokens": 98,
        "cacheReadTokens": 5200,
        "cacheWriteTokens": 81,
        "totalTokens": 5389
      }
    }
  ]
}
```

The browser rendered one row and the row's accessible name preserved the full
data:

```text
Open call call-spy-qa-35-cache-row, model claude-haiku-4-5-20251001-v1:0,
status complete, started 09:11:28 AM, operation converse-stream, read 10,
write 98, cache read 5,200, cache write 81, input 18 KiB, output 1.2 KiB,
duration 1.4 s, 26 request blocks, 3 response blocks
```

Measured DOM evidence from the same row:

```json
{
  "viewport": { "width": 1100, "height": 850 },
  "timelineWidth": 519,
  "rowCount": 1,
  "cacheRead": {
    "text": "cache read5,200",
    "labelClientWidth": 44,
    "labelScrollWidth": 63,
    "labelTruncated": true
  },
  "cacheWrite": {
    "text": "cache write81",
    "labelClientWidth": 64,
    "labelScrollWidth": 65,
    "labelTruncated": true
  }
}
```

This proves the bug is reproducible:

- the API supplies full `cacheReadTokens` and `cacheWriteTokens`
- the UI receives the data and exposes it in the accessible row label
- the visible metric labels are clipped by layout, not missing from the data

## Source Evidence

`src/spy/ui/src/App.tsx:886-889` renders the header as a single flex row. The
timestamp is an ordinary flex item with no `shrink-0` or `whitespace-nowrap`,
so it is allowed to shrink or wrap when the header is tight:

```tsx
<div className="flex min-w-0 items-center gap-2">
  <span className="truncate text-sm font-semibold">{shortModelId(summary.call.model_id)}</span>
  <Badge tone={statusTone(summary.call.status)}>{summary.call.status}</Badge>
  <span className="ml-auto text-xs text-stone-500">{formatTime(summary.call.started_at)}</span>
</div>
```

`src/spy/ui/src/App.tsx:891-895` forces all four usage metrics into four equal
columns:

```tsx
<div className="mt-2 grid grid-cols-4 gap-2 text-xs text-stone-600">
  <Metric label="read" value={formatNumber(summary.usage.inputTokens)} />
  <Metric label="write" value={formatNumber(summary.usage.outputTokens)} />
  <Metric label="cache read" value={formatNumber(summary.usage.cacheReadTokens)} />
  <Metric label="cache write" value={formatNumber(summary.usage.cacheWriteTokens)} />
</div>
```

`src/spy/ui/src/App.tsx:924-929` makes each metric a single-line flex chip. The
value is `shrink-0`, while the label is explicitly `truncate`, so any width
deficit is resolved by hiding label text:

```tsx
function Metric(props: { readonly label: string; readonly value: string }): React.ReactElement {
  return (
    <span className="flex min-w-0 items-center justify-between gap-1 rounded-md bg-stone-100 px-2 py-1">
      <span className="truncate text-stone-500">{props.label}</span>
      <span className="shrink-0 font-medium text-stone-900">{props.value}</span>
    </span>
  );
}
```

`src/spy/ui/src/format.ts:76-77` formats row values as full numbers with
thousands separators, so the row chip must fit `5,200` rather than a compact
timeline-specific value:

```ts
export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : NUMBER_FORMAT.format(value);
}
```

## Root Cause

`SPY-QA-35` is a timeline row layout bug, not a provider-data or normalization
bug.

The row is constrained by the two-column spy page. Inside that row, usage
metrics are forced into four equal columns. Each metric chip then reserves the
value as non-shrinking and makes the label the only shrinkable/truncated text.
At the reproduced 1100 px viewport, the metric column is about 97 px wide; after
chip padding and the `5,200` value, `cache read` only receives 44 px even though
it needs 63 px. The same mechanism clips `cache write`.

The timestamp risk named in `PLAN.md` comes from the same pattern: the header is
a crowded single-line flex row, but the timestamp is not protected from
shrinking or wrapping.

## Proposed Fix

Fix `SPY-QA-35` in `src/spy/ui/src/App.tsx` and nearby format helpers:

- Replace the fixed `grid-cols-4` metric layout with a wrapping layout, or a
  responsive two-column/four-column layout that gives cache metrics enough
  width at the 1100 px desktop viewport.
- Update `Metric` so labels and values stay readable together. Prefer
  `whitespace-nowrap` for the label/value pair and let whole chips wrap to a
  new row instead of truncating labels inside a chip.
- Consider a row-only compact number formatter for large token counts while
  keeping exact values in the inspector and accessible row label.
- Add `shrink-0 whitespace-nowrap` to the timestamp, leaving the model name as
  the primary truncation candidate in the header.
- Add focused Playwright coverage using a cache-heavy row at `1100 x 850` that
  asserts `cache read` and `cache write` have `scrollWidth <= clientWidth` and
  that the row still exposes exact values in its accessible name.

The fix should be display-only. It should not change provider normalization,
API contracts, persisted spy data, filtering, search, or timeline selection.

## Fix Implemented

The implementation keeps the timeline's full usage semantics but makes the
visible chips more compact:

- `read` now renders a down-arrow marker.
- `write` now renders an up-arrow marker.
- `cache read` now renders `R`.
- `cache write` now renders `W`.
- Each chip keeps its exact full meaning through `aria-label` and `title`, for
  example `cache read 5,200`.
- The timestamp now uses `shrink-0 whitespace-nowrap`, so it does not wrap under
  row pressure.

The change is display-only. It does not alter spy API contracts, persisted
data, filtering, search, timeline selection, or the row's existing accessible
name.

Focused regression coverage was updated in
`src/spy/ui/e2e/spy-ui.playwright.ts`:

- the cache-heavy row is checked at `1100 x 850`
- compact visible markers are asserted
- full `aria-label` values are asserted
- every usage chip is measured with `scrollWidth <= clientWidth`

## Proof After Fix

Rerunning the same cache-heavy reproduction at `1100 x 850` produced this
screenshot:


The row now shows compact markers with exact values: down arrow `10`, up arrow
`98`, `R 5,200`, and `W 81`.

Measured DOM evidence after the fix:

```json
{
  "viewport": { "width": 1100, "height": 850 },
  "timelineWidth": 519,
  "rowCount": 1,
  "metrics": [
    { "key": "read", "ariaLabel": "read 10", "text": "10", "clipped": false },
    { "key": "write", "ariaLabel": "write 98", "text": "98", "clipped": false },
    { "key": "cache read", "ariaLabel": "cache read 5,200", "text": "R5,200", "clipped": false },
    { "key": "cache write", "ariaLabel": "cache write 81", "text": "W81", "clipped": false }
  ],
  "timestamp": {
    "text": "09:16:44 AM",
    "whiteSpace": "nowrap"
  }
}
```

The row-level accessible name still preserves the full semantic usage labels:

```text
Open call call-spy-qa-35-cache-row, model claude-haiku-4-5-20251001-v1:0,
status complete, started 09:16:44 AM, operation converse-stream, read 10,
write 98, cache read 5,200, cache write 81, input 18 KiB, output 1.2 KiB,
duration 1.4 s, 26 request blocks, 3 response blocks
```

Verification commands:

- `bun run typecheck`
- `bun run lint`
- `bun run build:spy-ui`
- `./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts -g "shows provider cache token classes"`
