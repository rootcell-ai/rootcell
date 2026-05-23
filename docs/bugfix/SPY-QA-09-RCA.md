# SPY-QA-09 RCA: Relative Time Ranges Behave As Fixed Snapshots

## Scope

This RCA covers the highest-priority open spy bug I could prove in the current
tree after reading `PLAN.md`: `SPY-QA-09`.

Triage notes:

- `SPY-QA-02` remains the only open P0 in `PLAN.md`, but it did not reproduce in
  the current production-built UI. Lower inspector navigation and stream-event
  loading kept the top-level `main` fixed at `scrollTop=0`.
- `SPY-QA-06` is the first open P1, but it also did not reproduce. Selecting a
  different call from a deep inspector scroll position reset the inspector to
  `scrollTop=0` and closed the opened detail sections.
- `SPY-QA-09` is the first open P1 with concrete current evidence.

No implementation code has been changed for this RCA.

## Reproduction Used

- Built the current UI with `bun run build:spy-ui`.
- Started the fixture-backed spy UI service with:
  `bun src/spy/ui/test-server.ts --port 0 --static dist/spy-ui`
- The service selected `http://127.0.0.1:28375`.
- Opened the production build at `http://127.0.0.1:28375/?since=0`.
- Used Playwright Chromium in the default `1280 x 720` viewport.

The fixture server is enough to prove this bug because range state and refresh
behavior are browser-side UI state. They do not depend on live provider traffic.

## Higher-Priority No-Repro Proof

After loading the app, selecting the first call, jumping to Health, opening
Stream Events, loading stream events, opening Raw Payloads, and jumping back to
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
  "header": { "rect": { "top": 0, "bottom": 64, "height": 64 } },
  "aside": {
    "clientHeight": 656,
    "scrollHeight": 2303,
    "scrollTop": 1647,
    "overflowY": "auto",
    "rect": { "top": 64, "bottom": 720, "height": 656 }
  },
  "openDetails": [
    "spy-inspector-stream",
    "spy-inspector-raw",
    "spy-inspector-health"
  ],
  "rowCount": 5
}
```

This is a no-repro for `SPY-QA-02`: the scroll movement stayed inside the
inspector, and the hidden top-level `main` did not scroll or push the global
header offscreen.

After forcing the inspector to its deepest scroll position and selecting another
timeline call:

```json
{
  "before": {
    "aside": { "scrollTop": 1647, "scrollHeight": 2303, "clientHeight": 656 },
    "openDetails": [
      "spy-inspector-stream",
      "spy-inspector-raw",
      "spy-inspector-health"
    ]
  },
  "after": {
    "main": { "scrollTop": 0, "scrollHeight": 720, "clientHeight": 720 },
    "header": { "rect": { "top": 0, "bottom": 64, "height": 64 } },
    "aside": { "scrollTop": 0, "scrollHeight": 1442, "clientHeight": 656 },
    "openDetails": []
  }
}
```

This is a no-repro for `SPY-QA-06`: the current build resets inspector scroll
and panel state when the selected call changes.

## Proof

After clicking the `10 min` range button:

```json
{
  "href": "http://127.0.0.1:28375/?since=1779579245&preset=10m",
  "subtitle": "Since May 23, 07:34:05 PM",
  "active": ["10 min"],
  "since": 1779579245,
  "now": 1779579845,
  "ageSeconds": 600
}
```

After waiting 3.2 seconds and clicking the in-app `Refresh calls` button:

```json
{
  "href": "http://127.0.0.1:28375/?since=1779579245&preset=10m",
  "subtitle": "Since May 23, 07:34:05 PM",
  "active": ["10 min"],
  "since": 1779579245,
  "now": 1779579848,
  "ageSeconds": 603
}
```

This proves the current UI labels the selected range as `10 min` while using a
fixed `since` timestamp. Refreshing the app's call list does not advance the
window start. The query remains `preset=10m`, the active control remains
`10 min`, and the visible subtitle stays fixed even though the real window age
has moved past 10 minutes.

The same source path handles `1 hour`, so the bug applies to both relative range
buttons listed in `PLAN.md`.

## Source Evidence

Relevant current code:

- `src/spy/ui/src/format.ts:21-30` computes `10m` and `1h` as relative offsets
  from the current clock only when `secondsForPreset()` is called.
- `src/spy/ui/src/App.tsx:366-373` calls `secondsForPreset()` only when the
  operator clicks a preset button, then stores the resulting absolute `since`.
- `src/spy/ui/src/App.tsx:383-388` persists that absolute `since` into React
  state, the custom datetime value, and the URL query.
- `src/spy/ui/src/App.tsx:493-495` makes `Refresh calls` call `loadCalls()` only.
  It does not recompute `since` for relative presets.
- `src/spy/ui/src/App.tsx:160-190` sends the stored `since` value to the call
  list API.
- `src/spy/ui/src/App.tsx:481-482` renders the subtitle from the stored `since`,
  while the active range button still says `10 min` or `1 hour`.
- `src/spy/ui/src/api.ts:70-83` records the current absolute timestamp in the
  URL as `preset=10m&since=<fixed timestamp>` or
  `preset=1h&since=<fixed timestamp>`.

## Root Cause

`SPY-QA-09` is a browser range-state model bug.

The UI represents a relative preset with the same state shape as a custom fixed
range: `{ preset, since }`. When the user selects `10 min` or `1 hour`, the app
immediately resolves the relative preset into an absolute timestamp and then
only stores that timestamp. Later refreshes have no branch that says "this is a
relative preset; recompute its start before querying." As a result, the label
continues to advertise a relative range while the query behaves like a fixed
snapshot.

The URL model reinforces the same problem by storing both `preset=10m` and a
fixed `since`. Reloading can restore the old fixed timestamp while still making
the UI present the range as `10 min`.

## Proposed Fix

Fix `SPY-QA-09` by making relative and fixed range state explicit:

- Treat `10m`, `1h`, and `today` as rolling presets.
- Keep `live` as a fixed viewer-session start until the operator explicitly
  selects `Live` again.
- Treat `custom` as the only fixed user-selected timestamp range.
- Derive the API `since` timestamp from the active preset when loading calls,
  refreshing, and handling `calls-changed` SSE updates.
- For `10m` and `1h`, recompute `since` before each refresh/load so the visible
  range is actually rolling.
- Preserve URL shareability by recording `preset=10m` or `preset=1h` without
  requiring a stale fixed `since`, or by ignoring stored `since` for dynamic
  presets on load.
- Add unit coverage for dynamic range URL parsing and Playwright coverage that
  selects `10 min`, advances time, clicks refresh, and verifies the query start
  advances.

`Today` can continue to resolve to the current local start of day; recomputing
it on refresh is harmless and handles midnight rollover correctly.

## Fix Status

Implemented on 2026-05-23.

Changed `src/spy/ui/src/api.ts` so dynamic preset URLs such as `preset=10m`,
`preset=1h`, and `preset=today` resolve from the current clock instead of a
stale stored `since` value. The URL writer now removes `since` for those dynamic
presets and keeps `since` only for `custom`.

Changed `src/spy/ui/src/App.tsx` so non-paginated call loads recompute `since`
for rolling presets before querying the API. Pagination keeps the current
window start so cursor queries do not mix windows. `Live from now` remains a
fixed viewer-session range until the operator clicks `Live` again.

Added regression coverage:

- `src/spy/ui/src/api.test.ts` verifies dynamic preset parsing, current-clock
  `since` resolution, and canonical URLs without stale dynamic `since` values.
- `src/spy/ui/e2e/spy-ui.playwright.ts` verifies that refreshing `10 min`
  advances the API `since` parameter while preserving `preset=10m` in the URL.

Verification commands:

- `bun test src/spy/ui/src --timeout 10000`
- `bun run typecheck`
- `bun run test:spy-ui:e2e`
- `bun run lint`
