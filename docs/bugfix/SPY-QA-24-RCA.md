# SPY-QA-24 RCA: Custom Range State Rounds Seconds And Hides Active State

This RCA was written before implementation for the highest-priority open spy bug
at diagnosis time: `SPY-QA-24`.

## Priority Selection

- At diagnosis time, `PLAN.md` listed `SPY-QA-24` as the first unchecked bug.
- All P0 and P1 spy QA findings before it were marked complete or closed.
- `SPY-QA-24` was therefore the highest-priority open spy bug I could act on.
- This document was written before any product-code fix for `SPY-QA-24`.

## Bug Definition

`PLAN.md` defined the bug:

```text
[P2] SPY-QA-24: Improve custom-range state. `Apply` stays green while all
range pills are inactive, lacks ARIA state, and minute precision rounded a
prior `since` down to `:00`.
```

## Reproduction Evidence

I built the current UI and ran the existing fixture spy service:

```sh
bun run build:spy-ui
bun run src/spy/ui/test-server.ts --port 4974 --static dist/spy-ui
```

Then I opened:

```text
http://127.0.0.1:4974/?preset=custom&since=1779562507
```

Before clicking `Apply`, the live DOM state was:

```json
{
  "href": "http://127.0.0.1:4974/?preset=custom&since=1779562507",
  "header": "Since May 23, 02:55:07 PM",
  "inputType": "datetime-local",
  "inputValue": "2026-05-23T14:55",
  "inputStep": null,
  "buttons": [
    { "text": "Live", "primaryStyled": false, "ariaPressed": null, "ariaCurrent": null, "ariaSelected": null },
    { "text": "10 min", "primaryStyled": false, "ariaPressed": null, "ariaCurrent": null, "ariaSelected": null },
    { "text": "1 hour", "primaryStyled": false, "ariaPressed": null, "ariaCurrent": null, "ariaSelected": null },
    { "text": "Today", "primaryStyled": false, "ariaPressed": null, "ariaCurrent": null, "ariaSelected": null },
    { "text": "Apply", "primaryStyled": true, "ariaPressed": null, "ariaCurrent": null, "ariaSelected": null }
  ]
}
```

That proves the first two parts of the bug:

- The persisted state is custom, but none of the range pills appears active.
- `Apply` is the only green/primary control, so it is acting as the visual
  active-state indicator.
- Neither `Apply` nor the inactive range pills expose `aria-pressed`,
  `aria-current`, or `aria-selected`.

After clicking `Apply` without changing the input, the live DOM and URL state
became:

```json
{
  "href": "http://127.0.0.1:4974/?preset=custom&since=1779562500",
  "preset": "custom",
  "since": "1779562500",
  "header": "Since May 23, 02:55:00 PM",
  "inputValue": "2026-05-23T14:55",
  "applyAriaPressed": null,
  "applyAriaCurrent": null,
  "applyAriaSelected": null
}
```

That proves the destructive rounding path: a valid second-level custom URL
`1779562507` was rewritten to `1779562500` solely by applying the displayed
minute-precision input.

## Pre-Fix Source Evidence

Before implementation, `src/spy/ui/src/api.ts` correctly preserved an explicit
custom `since` from the URL. This is why the header initially showed
`02:55:07 PM`.

The pre-fix `src/spy/ui/src/App.tsx` then converted the custom timestamp to the
`datetime-local` value by slicing the ISO string to 16 characters:

```ts
return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
```

That stripped seconds before the operator touched anything.

The pre-fix `applyCustomStart` path parsed the minute-only input and committed
it as the new custom range:

```ts
const next = secondsFromDatetimeLocal(customStart);
if (next !== null) {
  setTimelineRange("custom", next);
}
```

Because the browser input no longer contained seconds, this produced `:00` for
any prior second-level value.

The pre-fix range controls rendered only `Live`, `10 min`, `1 hour`, and
`Today` as segmented range buttons. There was no custom segment. The custom
state was represented by making the `Apply` command button primary:

```tsx
<Button size="sm" variant={props.preset === "custom" ? "primary" : "secondary"} onClick={props.onApplyCustomStart}>
  Apply
</Button>
```

The pre-fix `SegmentButton.active` mapping only changed visual variants and did
not add an ARIA state attribute.

## Root Cause

`SPY-QA-24` is a custom-range state-model and control-semantics bug in the
browser UI.

The application stores custom range state with second precision, but the only
editable control for that state is a minute-precision `datetime-local` input.
The UI immediately derives `customStart` from the precise `since` value by
dropping seconds. The later `Apply` action treats that lossy display value as
the source of truth and writes it back to URL/application state.

Separately, the range control presents four segmented presets plus a command
button. Since custom has no segment, the app uses the command button's primary
styling to imply the current custom state. That makes a command look like a
selected state, leaves all true range segments inactive, and exposes no
machine-readable selected state.

The API, service, and store are not the root cause. The initial custom URL value
is parsed and preserved correctly until the browser control serializes it
through the minute-only input.

## Proposed Fix

Fix `SPY-QA-24` in `src/spy/ui/src/App.tsx`:

- Make custom range an explicit range segment/state in the same control group as
  Live, 10 min, 1 hour, and Today.
- Add ARIA selected/pressed state to range segments so active range state is not
  visual-only.
- Treat `Apply` as a command button, not the active-state indicator. It should
  not stay primary simply because `preset === "custom"`.
- Preserve existing seconds when the displayed custom minute has not changed, or
  store enough draft state to avoid rewriting a precise URL to `:00` on a no-op
  apply.

## Regression Coverage

Added Playwright coverage for:

- Loading `/?preset=custom&since=1779562507` shows custom as the active range
  state through a range segment with ARIA state.
- `Apply` is not the sole selected-state indicator and does not expose stale
  selected styling.
- Clicking `Apply` without changing the minute input keeps the URL at
  `since=1779562507`.
- Changing the custom datetime to a different minute still commits the new
  custom range intentionally.

## Fix Status

Fixed on 2026-05-24.

Implementation summary:

- Added a `Custom` range segment beside Live, 10 min, 1 hour, and Today.
- Added `aria-pressed` to range segment buttons.
- Kept `Apply` as a command button instead of the selected-state indicator.
- Preserved second-level `since` precision when applying an unchanged
  minute-precision custom draft.

Verification:

- `bun run typecheck`
- `bun run lint`
- `bun run test:spy-ui:unit`
- `bun run test:spy-ui:e2e`
