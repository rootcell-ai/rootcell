# SPY-QA-36 RCA: Inspector Summary Cards Truncate Started Time

This RCA was written before any product-code fix for the highest-priority open
spy bug in the current tree.

## Priority Selection

- `PLAN.md:1058-1073` marks `SPY-QA-34` and `SPY-QA-35` fixed.
- `PLAN.md:1074-1075` lists `SPY-QA-36` as the only unchecked spy QA item.
- Therefore `SPY-QA-36` is the highest-priority open spy bug.

## Bug

`PLAN.md:1074-1075` defines the bug:

> [P3] SPY-QA-36: Prevent top inspector summary cards from truncating
> important values such as exact `Started` time.

The reproduced current symptom is that the selected call Summary panel visibly
clips the exact `Started` timestamp even though the API and DOM both contain the
full timestamp.

## Reproduction

I reproduced this against the current production spy UI build without changing
product code:

1. Built the current browser bundle with `bun run build:spy-ui`.
2. Started the fixture-backed spy UI service with
   `bun run src/spy/ui/test-server.ts --port 0 --static dist/spy-ui`.
3. Opened `http://127.0.0.1:33645/?since=0` in the in-app browser.
4. Used the normal browser viewport of `1280 x 720`.
5. Selected the default fixture call shown in the inspector.

Screenshot captured before a fix:


The Summary panel visibly renders the Started value as `May 24, 11:35:5...`.

## Reproducibility Proof

The fixture API returned the selected call with a precise `started_at` value:

```json
{
  "id": "call-fixture-flow-tool-result",
  "model_id": "us.anthropic.claude-sonnet-4-6",
  "started_at": 1779636958,
  "completed_at": 1779636959,
  "durationMs": 1000
}
```

In the local timezone, that timestamp is:

```text
May 24, 2026 11:35:58 AM EDT
```

The browser DOM for the Summary panel also contained the full rendered value:

```json
{
  "viewport": { "width": 1280, "height": 720 },
  "summaryPanel": "Model IDus.anthropic.claude-sonnet-4-6StartedMay 24, 11:35:58 AMDuration1.0 sRequest2.6 KiBTotal Usage1.3k tok"
}
```

Measured DOM evidence from the same Started value node:

```json
{
  "label": "Started",
  "cardWidth": 147.9453125,
  "valueText": "May 24, 11:35:58 AM",
  "valueClientWidth": 122,
  "valueScrollWidth": 142,
  "overflow": "hidden",
  "textOverflow": "ellipsis",
  "whiteSpace": "nowrap",
  "truncated": true
}
```

The adjacent Summary metric cards do not truncate with this fixture:

```json
[
  { "label": "Duration", "valueText": "1.0 s", "truncated": false },
  { "label": "Request", "valueText": "2.6 KiB", "truncated": false },
  { "label": "Total Usage", "valueText": "1.3k tok", "truncated": false }
]
```

This proves the bug is reproducible:

- the service supplies a precise `started_at` timestamp
- the UI receives and formats the full Started value
- the visible text is clipped only because the rendered value box is narrower
  than the text and uses ellipsis truncation

## Source Evidence

`src/spy/ui/src/App.tsx:1232-1248` renders the Summary panel. The exact model id
gets its own full-width, wrapping row, but the four top metrics are forced into
four equal columns:

```tsx
<div className="grid grid-cols-4 gap-3">
  <PanelMetric icon={<Clock aria-hidden="true" size={16} />} label="Started" value={formatDateTime(summary.call.started_at)} />
  <PanelMetric icon={<Activity aria-hidden="true" size={16} />} label="Duration" value={formatDuration(summary.durationMs)} />
  <PanelMetric icon={<Database aria-hidden="true" size={16} />} label="Request" value={formatBytes(summary.requestByteSize)} />
  <PanelMetric icon={<BadgeInfo aria-hidden="true" size={16} />} label="Total Usage" value={formatUsageTotal(summary.usage)} />
</div>
```

`src/spy/ui/src/App.tsx:1253-1265` renders every metric value with Tailwind's
`truncate` utility:

```tsx
function PanelMetric(props: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
}): React.ReactElement {
  return (
    <div className="min-w-0 rounded-md border border-stone-200 bg-stone-50 p-3">
      <div className="flex items-center gap-2 text-xs text-stone-500">
        {props.label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-stone-950">{props.value}</div>
    </div>
  );
}
```

`src/spy/ui/src/format.ts:45-49` formats Started as a month/day/time string,
which is longer than the metric values for Duration, Request, and Total Usage:

```ts
export function formatDateTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) {
    return "pending";
  }
  return DATE_TIME_FORMAT.format(new Date(seconds * 1000));
}
```

## Root Cause

`SPY-QA-36` is a Summary panel layout bug, not a capture, normalization, API, or
date-formatting bug.

The top Summary metrics are constrained by a `grid-cols-4` layout inside the
right inspector. At the reproduced `1280 x 720` viewport, the inspector gives
each metric card about `148 px`; after card padding, the value line has about
`122 px` of usable width. The full Started text needs `142 px`. Because
`PanelMetric` applies `truncate`, the browser resolves that width deficit with
`overflow: hidden`, `text-overflow: ellipsis`, and `white-space: nowrap`.

The API and DOM both preserve the exact timestamp. The loss happens only at
paint time in the Summary metric value line.

## Proposed Fix

Fix `SPY-QA-36` in `src/spy/ui/src/App.tsx` as a display-only change:

- Change the Summary metric grid from fixed `grid-cols-4` to a responsive grid,
  for example two columns at normal inspector widths and four columns only when
  the inspector has enough room.
- Remove `truncate` from `PanelMetric` values, or make it opt-in so only values
  that are safe to abbreviate can use it.
- Allow important values such as Started to wrap cleanly across two lines with
  `break-words` or a normal wrapping value style.
- Optionally pass a stronger presentation hint to `PanelMetric` for timestamp
  values, such as a wider column span or a `title` containing the exact value.
- Add focused Playwright coverage at `1280 x 720` that selects a fixture call
  and asserts the Started value has `scrollWidth <= clientWidth` or otherwise
  is not ellipsized.

The fix should not change provider normalization, API contracts, persisted spy
data, filtering, search, selection, or timestamp formatting semantics.

## Fix Implemented

The implementation changes only the Summary panel presentation in
`src/spy/ui/src/App.tsx`:

- The metric cards now use two columns at normal inspector widths and only move
  back to four columns at `2xl` desktop widths.
- `PanelMetric` values no longer use Tailwind's `truncate` utility.
- Metric values use normal wrapping and expose the exact value in a `title`.
- Each metric value has a `data-summary-metric` attribute so regression tests
  can measure the exact rendered node.

The existing compact timeline usage markers remain unchanged: read uses a down
arrow, write uses an up arrow, cache read uses `R`, and cache write uses `W`.

After-fix screenshot:


Measured after-fix browser evidence at the same `1280 x 720` viewport:

```json
{
  "started": {
    "text": "May 24, 11:41:35 AM",
    "clientWidth": 282,
    "scrollWidth": 282,
    "overflow": "visible",
    "textOverflow": "clip",
    "whiteSpace": "normal"
  }
}
```

Verification:

- `bun run build:spy-ui`
- `./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts -g "keeps inspector summary metric values readable"`
- `bun run typecheck`
- `bun run test:spy-ui:unit`
