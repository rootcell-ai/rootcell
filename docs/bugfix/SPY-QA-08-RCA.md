# SPY-QA-08 RCA: Fixed Since URLs Render As Live And Range State Does Not Update The URL

## Scope

This RCA covers the highest-priority open spy bug I could prove in the current
tree after reading `PLAN.md`: `SPY-QA-08`.

Triage notes:

- `SPY-QA-02` remains the only open P0 in `PLAN.md`, but it still does not
  reproduce in the current built UI. Opening lower inspector panels, loading
  stream events, and jumping back to Health kept `main.scrollTop=0`, kept the
  global header at `top=0`, and kept `main.scrollHeight === main.clientHeight`.
- `SPY-QA-06` also did not reproduce in the current built UI. Selecting a
  different call after deep inspector scrolling reset the inspector to
  `scrollTop=0`.
- The next open P1 with concrete current evidence is `SPY-QA-08`.

No implementation code has been changed for this RCA.

## Reproduction Used

- Built the current UI with `bun run build:spy-ui`.
- Started the fixture-backed spy UI service with:
  `bun src/spy/ui/test-server.ts --port 4689 --static dist/spy-ui`
- Opened the built UI at `http://127.0.0.1:4689/?since=0`.
- Used browser DOM measurements against the production build in the default
  1280 x 720 viewport.

The fixture server is enough to prove the state bug because `?since=0` is a
fixed historical URL, regardless of whether the loaded fixture calls are recent.

## Higher-Priority No-Repro Proof

After opening Health, opening Stream, loading stream events, and jumping back to
Health:

```json
{
  "viewport": { "width": 1280, "height": 720 },
  "main": {
    "clientHeight": 720,
    "scrollHeight": 720,
    "scrollTop": 0,
    "overflowY": "hidden",
    "rect": { "top": 0, "bottom": 720, "height": 720 }
  },
  "header": { "top": 0, "bottom": 64, "height": 64 },
  "aside": {
    "clientHeight": 656,
    "scrollHeight": 2265,
    "scrollTop": 1609,
    "overflowY": "auto",
    "rect": { "top": 64, "bottom": 720, "height": 656 }
  },
  "stream": {
    "open": true,
    "cards": 6,
    "rect": { "top": -278, "bottom": 303, "height": 581 }
  },
  "health": {
    "open": true,
    "rect": { "top": 381, "bottom": 700, "height": 319 }
  }
}
```

This is a no-repro for `SPY-QA-02`: the lower-panel navigation is owned by the
inspector scroll container, and the hidden top-level `main` container does not
scroll.

After selecting another timeline call from that deep inspector position:

```json
{
  "main": {
    "clientHeight": 720,
    "scrollHeight": 720,
    "scrollTop": 0,
    "rect": { "top": 0, "bottom": 720, "height": 720 }
  },
  "header": { "top": 0, "bottom": 64, "height": 64 },
  "aside": {
    "clientHeight": 656,
    "scrollHeight": 1457,
    "scrollTop": 0,
    "rect": { "top": 64, "bottom": 720, "height": 656 }
  },
  "openDetails": []
}
```

This is a no-repro for `SPY-QA-06`: selecting a different call resets the
inspector scroll and closes the opened detail sections in the current build.

## Proof

Initial load from a fixed historical URL:

```json
{
  "href": "http://127.0.0.1:4689/?since=0",
  "search": "?since=0",
  "subtitle": "Live from now",
  "activeRangeButtons": ["Live"],
  "visibleRows": 5
}
```

The UI is using `since=0` from the URL to load calls, but the visible range state
claims the page is `Live from now` and highlights `Live`.

After clicking `10 min`:

```json
{
  "href": "http://127.0.0.1:4689/?since=0",
  "search": "?since=0",
  "subtitle": "Since May 23, 07:17:53 PM",
  "activeRangeButtons": ["10 min"],
  "visibleRows": 5
}
```

The internal range state changed, but the browser URL stayed `?since=0`.

After reloading that same URL:

```json
{
  "href": "http://127.0.0.1:4689/?since=0",
  "search": "?since=0",
  "subtitle": "Live from now",
  "activeRangeButtons": ["Live"],
  "visibleRows": 5
}
```

This proves the round-trip failure:

- A fixed `since` URL is not distinguished from true live mode on initial load.
- Changing the selected range does not update the URL.
- Reloading brings back the stale `since=0` query while the UI again labels the
  view as `Live from now`.

## Source Evidence

Relevant current code:

- `src/spy/ui/src/api.ts:28-35` parses `?since=` into a number and returns it
  as the initial call query timestamp.
- `src/spy/ui/src/App.tsx:124-126` initializes `preset` independently as
  `"live"` while initializing `since` and `customStart` from
  `initialSinceFromLocation(window.location)`.
- `src/spy/ui/src/App.tsx:163-165` passes the parsed `since` value into the
  call-list API query.
- `src/spy/ui/src/App.tsx:365-383` updates React state when a range changes,
  but does not update `window.history` or the query string.
- `src/spy/ui/src/App.tsx:477-479` renders `Live from now` solely from
  `preset === "live"`, even when `since` came from a fixed URL.
- `src/spy/ui/src/App.tsx:701-710` makes the active segment visual depend on
  the same `preset` state, not on the URL-derived mode.

## Root Cause

`SPY-QA-08` is a browser state-model bug.

The app stores two related pieces of timeline state separately:

- `since`, which controls the API query and may come from `window.location`.
- `preset`, which controls the range label and active range segment.

On startup, `since` is hydrated from the URL, but `preset` is always initialized
to `"live"`. That creates an impossible state: a fixed historical `since` value
with a live-mode label.

Range changes have the inverse problem. `setPresetSince()` and
`applyCustomStart()` update React state only. They never push or replace the
browser URL, so the URL can continue to advertise an old `since` value after the
visible range has changed. Reloading then rehydrates from the stale URL and
recreates the wrong live/fixed state.

## Proposed Fix

Fix `SPY-QA-08` by making the range URL and range state a single coherent model:

- Derive the initial preset from `window.location.search`.
  - No `since` query means true live mode.
  - A valid `since` query means a fixed/custom range unless it exactly matches a
    known preset that the URL explicitly records.
- Store enough URL state to distinguish true live mode from a fixed `since`
  timestamp. A `mode` or `preset` query parameter would make this explicit.
- Update the URL with `history.replaceState` or `history.pushState` whenever the
  operator changes Live, 10 min, 1 hour, Today, or Custom.
- Keep `./rootcell spy` launch URLs that include a viewer launch timestamp from
  being labeled `Live from now`; those are fixed since URLs unless the URL
  explicitly says they are live.
- Add UI unit or Playwright coverage that loads `/?since=0`, verifies it is not
  labeled live, changes the range, verifies the URL changes, reloads, and
  verifies the same range state is restored.

## Fix Status

Implemented.

Changed `src/spy/ui/src/api.ts` so initial browser range state is parsed as a
coherent `{ preset, since }` pair. A URL with `?since=` but no explicit
`preset=live` now starts as a fixed/custom range instead of being labeled live.

Changed `src/spy/ui/src/App.tsx` so range changes update the browser URL:

- `Live` writes `preset=live` and removes `since`.
- `10 min`, `1 hour`, `Today`, and `Custom` write both `preset` and the fixed
  `since` timestamp used by the API query.

Added regression coverage:

- `src/spy/ui/src/api.test.ts` covers fixed `since` parsing, explicit live mode,
  invalid URL values, and canonical range URL construction.
- `src/spy/ui/e2e/spy-ui.playwright.ts` covers loading `/?since=0` as non-live,
  changing to `10 min`, preserving that state through reload, switching to
  `Live`, and preserving live state through reload.

Verification commands:

- `bun run typecheck`
- `bun test src/spy/ui/src --timeout 10000`
- `bun run lint`
- `bun run build:spy-ui`
- `bun run test:spy-ui:e2e`
