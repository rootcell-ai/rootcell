# SPY-QA-30 RCA: Selected Timeline Row Lacks ARIA State

This RCA was written before implementation for the highest-priority open spy
bug in the current tree: `SPY-QA-30`.

## Priority Selection

- `PLAN.md:1032-1033` lists `SPY-QA-30` as the first unchecked spy bug.
- All P0 and P1 spy QA findings are complete or closed in `PLAN.md`.
- `SPY-QA-22` through `SPY-QA-29` are also complete or closed.
- `SPY-QA-30` is therefore the highest-priority open spy bug in the current
  handoff.
- This document was written before any product-code fix for `SPY-QA-30`.

## Bug Definition

`PLAN.md:1032-1033` defines the bug:

```text
[P2] SPY-QA-30: Add ARIA state for selected timeline row and active range
segment. Current active/selected states are visual only.
```

`PLAN.md:1066-1067` adds:

```text
SPY-QA-30: Selected timeline row and active time-range segment are only
visually indicated; they do not expose `aria-selected`, `aria-pressed`, or
`aria-current`.
```

## Current Reproduction

I reproduced the current accessible-state gap against the fixture-backed spy UI
before changing product code.

Commands used:

```sh
./node_modules/.bin/vite build --config src/spy/ui/vite.config.ts --outDir /private/tmp/rootcell-spy-ui-qa30-dist
bun run src/spy/ui/test-server.ts --port 4765 --static /private/tmp/rootcell-spy-ui-qa30-dist
```

The first non-escalated localhost bind attempts failed in the sandbox. The
approved localhost server run succeeded and reported:

```text
rootcell spy UI test server listening on http://127.0.0.1:4765
```

I then opened `http://127.0.0.1:4765/?since=0` in headless Chromium, waited for
fixture timeline rows, selected the first row, and inspected the DOM attributes
for the timeline rows and range buttons.

Screenshot captured before a fix:


The screenshot shows the current visual selected state. The defect itself is an
accessibility semantics issue, so the decisive proof is the DOM attribute
evidence below.

## DOM Proof

After selecting the first timeline row, the selected row has the visual selected
classes but no ARIA state:

```json
{
  "label": "Open call call-fixture-flow-tool-result",
  "className": "grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-md border bg-white p-3 text-left shadow-sm transition-colors border-emerald-600 ring-2 ring-emerald-600/20",
  "ariaPressed": null,
  "ariaSelected": null,
  "ariaCurrent": null
}
```

The other visible rows also have no ARIA state, which is expected for
unselected rows:

```json
{
  "label": "Open call call-fixture-flow-tool-use",
  "className": "grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-md border bg-white p-3 text-left shadow-sm transition-colors border-stone-250 hover:border-stone-400 hover:bg-stone-50",
  "ariaPressed": null,
  "ariaSelected": null,
  "ariaCurrent": null
}
```

This proves the selected timeline row's state is visual only.

The range-control half of the plan item is stale in the current tree. The
current DOM already exposes range state through `aria-pressed`:

```json
[
  { "text": "Live", "ariaPressed": "false" },
  { "text": "10 min", "ariaPressed": "false" },
  { "text": "1 hour", "ariaPressed": "false" },
  { "text": "Today", "ariaPressed": "false" },
  { "text": "Custom", "ariaPressed": "true" }
]
```

Therefore the remaining reproducible bug is the selected timeline row ARIA
state, not the active range segment.

## Source Evidence

`src/spy/ui/src/App.tsx:665` correctly groups the range controls:

```tsx
<div className="flex flex-wrap items-center gap-2" role="group" aria-label="Timeline range">
```

`src/spy/ui/src/App.tsx:777-781` correctly gives each range segment an
`aria-pressed` state:

```tsx
<Button
  size="sm"
  variant={props.active ? "primary" : "secondary"}
  aria-pressed={props.active}
  onClick={props.onClick}
>
```

The timeline passes selected state into `TimelineRow` at
`src/spy/ui/src/App.tsx:834-839`:

```tsx
<TimelineRow
  summary={summary}
  selected={summary.call.id === props.selectedCallId}
  onSelect={() => {
    props.onSelect(summary.call.id);
  }}
/>
```

`src/spy/ui/src/App.tsx:867-873` only uses that selected state for classes:

```tsx
className={cn(
  "grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-md border bg-white p-3 text-left shadow-sm transition-colors",
  props.selected ? "border-emerald-600 ring-2 ring-emerald-600/20" : "border-stone-250 hover:border-stone-400 hover:bg-stone-50",
)}
onClick={props.onSelect}
aria-label={`Open call ${summary.call.id}`}
data-testid="timeline-row"
```

There is no `aria-selected`, `aria-current`, or `aria-pressed` on the selected
row button.

## Root Cause

`SPY-QA-30` is currently a browser accessibility-state bug in `TimelineRow`.

The app has a coherent internal selected-call state and a clear visual selected
row style. That state is passed to the row component, but the row component only
maps it to CSS. Assistive technology receives the same role and ARIA attributes
for the selected row as for every unselected row.

The active range segment is not part of the current root cause because
`SegmentButton` already maps active range state to `aria-pressed`.

## Proposed Fix

Fix only the remaining reproducible `SPY-QA-30` gap:

- Add an ARIA state to `TimelineRow` based on `props.selected`.
- Prefer `aria-current={props.selected ? "true" : undefined}` on the row button,
  because the button represents the currently inspected provider call rather
  than a toggle button.
- Keep the existing visual selected styles unchanged.
- Add Playwright coverage that selects a timeline row and proves the selected
  row exposes ARIA state while an unselected row does not.
- Preserve existing `aria-pressed` coverage for range segment buttons.

## Verification Plan

After implementation:

```sh
./node_modules/.bin/vite build --config src/spy/ui/vite.config.ts --outDir /private/tmp/rootcell-spy-ui-qa30-dist
./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts -g "ARIA state"
bun run test:spy-ui:unit
bun run typecheck
bun run lint
```

Depending on the final touched files, also run the full spy UI e2e suite before
closing the bug.

## Implemented Fix

Changed `src/spy/ui/src/App.tsx` so `TimelineRow` maps its existing
`selected` boolean to `aria-current="true"` on the row button. Unselected rows
omit the attribute.

This keeps the existing visual selected styling unchanged and avoids treating
the row as a toggle button. The selected row represents the currently inspected
provider call, so `aria-current` is the narrowest fit for the existing
interaction.

Added Playwright coverage in `src/spy/ui/e2e/spy-ui.playwright.ts` proving:

- The active `Custom` range segment exposes `aria-pressed="true"`.
- An inactive range segment exposes `aria-pressed="false"`.
- Selecting a timeline row sets `aria-current="true"` on that row.
- Selecting another timeline row moves `aria-current="true"` to the new row and
  removes it from the previous row.

Updated `PLAN.md` to mark `SPY-QA-30` complete.

## Proof After Fix

Annotated screenshot captured after the fix:


The screenshot includes the selected row plus a proof overlay showing:

```json
{
  "selectedAriaCurrent": "true",
  "otherAriaCurrent": null,
  "customAriaPressed": "true",
  "liveAriaPressed": "false"
}
```

Focused regression:

```text
✓ exposes ARIA state for selected timeline row and active range
1 passed
```

Full spy UI e2e suite:

```text
24 passed
```

Verification commands run:

```sh
bun run build:spy-ui
./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts -g "ARIA state"
bun run test:spy-ui:unit
bun run typecheck
bun run lint
bun run test:spy-ui:e2e
```
