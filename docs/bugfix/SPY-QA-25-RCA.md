# SPY-QA-25 RCA: Custom Datetime Input Is Too Narrow

## Scope

This RCA covers the highest-priority open spy bug in the current tree:
`SPY-QA-25`.

Triage notes:

- `PLAN.md` marks all P0 and P1 spy QA findings complete or closed.
- `PLAN.md` marks `SPY-QA-22`, `SPY-QA-23`, and `SPY-QA-24` complete.
- `PLAN.md` marks `SPY-QA-26` closed as a product enhancement.
- `PLAN.md:1000-1001` lists `SPY-QA-25` as the first unchecked P2 item in the
  prioritized handoff.
- Later unchecked P2/P3 items are lower in the handoff order.
- This document was written before any product-code fix for `SPY-QA-25`.

## Bug Definition

`PLAN.md:1000-1001` defines the current bug:

```text
[P2] SPY-QA-25: Expand or restyle the custom datetime input so the AM/PM
and time controls are not cramped at the normal desktop width.
```

`PLAN.md:1043-1045` adds the retained evidence note:

```text
SPY-QA-25: The custom datetime input is cramped at the normal desktop browser
width; the stored value is correct, but the AM/PM/time affordance is visually
crowded.
```

## Reproduction Used

I built the current production spy UI and ran the fixture spy service:

```sh
bun run build:spy-ui
bun run src/spy/ui/test-server.ts --port 4874 --static dist/spy-ui
```

The server command required localhost bind permission in this workspace. I then
opened the same custom-range state covered by the existing custom range e2e
test:

```text
http://127.0.0.1:4874/?preset=custom&since=1779562507
```

Headless Chromium required browser-launch permission on macOS. No product-code
files were changed before this RCA was written.

## Runtime Proof

At a normal desktop QA viewport of `1159 x 862`, the live rendered control
measured:

```json
{
  "viewport": { "width": 1159, "height": 862 },
  "inputValue": "2026-05-23T14:55",
  "inputType": "datetime-local",
  "inputRect": { "width": 190, "height": 36 },
  "inputClientWidth": 188,
  "inputPaddingLeft": "12px",
  "inputPaddingRight": "12px",
  "inputCssWidth": "190px",
  "applyRect": { "width": 63.484375, "height": 32 },
  "gapBetweenInputAndApply": 8,
  "controlsRect": { "width": 285.484375 }
}
```

The screenshot captured during that run is:

```text
```

The screenshot shows the custom input displaying `05/23/2026, 02:55` with the
calendar affordance pressed against the time text. The page header above it
shows the precise selected range as `Since May 23, 02:55:07 PM`, so the custom
range is a PM time, but the native input presentation does not have visible room
to show the `PM` indicator.

I also measured the rendered font against the native control's available text
area:

```json
{
  "font": "16px / 24px Inter, ui-sans-serif, system-ui, -apple-system, \"system-ui\", \"Segoe UI\", sans-serif",
  "inputCssWidth": "190px",
  "inputClientWidth": 188,
  "paddingLeft": "12px",
  "paddingRight": "12px",
  "measured": {
    "05/23/2026, 02:55 PM": 164.609375,
    "05/23/2026, 02:55": 136.8984375,
    "05/23/2026, 2:55 PM": 154.84375,
    "May 23, 2026, 02:55 PM": 178.65625
  },
  "value": "2026-05-23T14:55"
}
```

The host input has 188 px client width and 24 px of horizontal padding, leaving
164 px before the native calendar affordance is considered. The localized
`05/23/2026, 02:55 PM` text alone measures 164.609375 px. That means the full
date/time plus AM/PM marker already exceeds the padded text area, and the
calendar affordance makes the crowding unavoidable.

The issue is stable across normal desktop widths because the input is fixed at
190 px:

```json
[
  {
    "viewportWidth": 1280,
    "panelWidth": 563.1875,
    "inputCssWidth": 190,
    "inputContentWidthMinusPadding": 164,
    "measuredWithPm": 164.609375
  },
  {
    "viewportWidth": 1159,
    "panelWidth": 520,
    "inputCssWidth": 190,
    "inputContentWidthMinusPadding": 164,
    "measuredWithPm": 164.609375
  },
  {
    "viewportWidth": 1100,
    "panelWidth": 520,
    "inputCssWidth": 190,
    "inputContentWidthMinusPadding": 164,
    "measuredWithPm": 164.609375
  }
]
```

This proves the bug is not an intermittent data problem. The stored value is
correct, but the rendered custom datetime control is too narrow for the native
localized time display at the target desktop widths.

## Source Evidence

`src/spy/ui/src/App.tsx:680-690` renders the custom date/time as a native
`datetime-local` input inside the timeline range toolbar:

```tsx
<div className="ml-auto flex items-center gap-2">
  <Clock aria-hidden="true" className="text-stone-500" size={16} />
  <Input
    aria-label="Custom start time"
    className="w-[190px]"
    type="datetime-local"
    value={props.customStart}
    onChange={(event) => {
      props.onCustomStart(event.target.value);
    }}
  />
```

`src/spy/ui/src/components/ui/input.tsx:11-14` gives every input 12 px left and
right padding:

```tsx
"h-9 w-full rounded-md border border-stone-300 bg-white px-3 text-sm text-stone-950 shadow-sm outline-none"
```

Because the custom input overrides only width with `w-[190px]`, the actual text
area is the fixed width minus border and padding. In Chromium's native
`datetime-local` rendering, that is not enough for the localized date/time,
AM/PM, and calendar affordance.

## Root Cause

`SPY-QA-25` is a browser UI sizing bug in `TimelineControls`.

The implementation gives a native `datetime-local` control a hard-coded 190 px
width while also applying shared input padding. Native datetime controls reserve
space for browser-managed date/time fields and a calendar affordance. At the
normal desktop widths used by QA, the visible left panel has enough overall
space, but the fixed input width constrains the native control so tightly that
the PM field is clipped or visually crowded.

The API, spy service, store, and custom range state are not the root cause. The
runtime proof shows the input value is correct (`2026-05-23T14:55`) and the page
header preserves the PM range. The failure is the input presentation.

## Proposed Fix

Fix `SPY-QA-25` in `src/spy/ui/src/App.tsx` and, if needed, the shared input
styling:

- Give the custom datetime control more horizontal room at desktop widths,
  either by increasing its width or by letting the date/time cluster wrap onto
  its own row when the range toolbar is narrow.
- Keep the `Custom` range segment and `Apply` command from `SPY-QA-24` intact.
- Avoid relying on native `datetime-local` internals for a width that barely
  fits one locale. Leave enough slack for AM/PM plus the calendar affordance.
- Add Playwright coverage that measures the custom input at the normal desktop
  viewport and proves the control has sufficient width for the PM display.

## Fix Status

Fixed on 2026-05-24.

Implementation summary:

- Increased the custom datetime input from 190 px to 240 px while preserving
  the existing custom range segment and Apply command behavior.
- Added Playwright coverage at the original `1159 x 862` QA viewport. The test
  measures the rendered input's usable text area against `05/23/2026, 02:55 PM`
  and requires at least 32 px of slack for the native calendar/time affordance.

Verification:

- `bun run typecheck`
- `bun run test:spy-ui:e2e`
- `bun run lint`
- `bun run test:spy-ui:unit`
