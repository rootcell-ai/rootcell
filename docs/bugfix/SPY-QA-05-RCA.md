# SPY-QA-05 RCA: Stream Events Render Inline And Persist Across Range Changes

## Scope

This RCA covers the highest-priority spy bug that is open and reproducible in
the current tree: `SPY-QA-05`.

Triage note: `SPY-QA-02` is still the only open P0 in `PLAN.md`, but I could
not reproduce it in the current built UI. The earlier `SPY-QA-01` and
`SPY-QA-04` fixes appear to keep `main` constrained. Because this fix request
requires actual evidence before implementation, I am not proposing a
`SPY-QA-02` code change from the old QA note alone.

## Reproduction Used

Baseline build:

- Ran `bun run build:spy-ui`.
- Started the existing fixture-backed spy UI service at
  `http://127.0.0.1:26737`.
- Opened `/?since=0` in the Codex in-app browser.
- Clicked the inspector `Health` and `Stream` section navigator buttons, then
  loaded stream events for the selected fixture call.

High-volume stream reproduction:

- Started an API-compatible synthetic local server at
  `http://127.0.0.1:59006` serving the built `dist/spy-ui` assets.
- The server returned one complete Bedrock call with `streamEventCount=250`.
- The `/api/calls/:id/stream-events` endpoint respected the UI's current
  `limit=100` request and returned `nextCursor` until all 250 events were
  loaded.
- Opened `http://127.0.0.1:59006/?since=0`, jumped to `Stream Events`, clicked
  `Load Stream Events`, clicked `Load More Stream Events` twice, then changed
  the time range to `Today`.

The high-volume server used API-shaped data only; no application code was
changed to produce this proof.

## P0 Triage Proof

The current UI did not reproduce the hidden top-level scroll failure called out
in `SPY-QA-02`. After opening lower inspector sections and loading stream
events in the fixture-backed UI, `main.scrollTop` remained `0`, the header
remained at the top of the viewport, and `main.scrollHeight` equaled
`main.clientHeight`.

Representative browser measurements after opening `Health`, opening `Stream`,
and loading the fixture stream events:

```json
{
  "main": {
    "clientHeight": 720,
    "scrollHeight": 720,
    "scrollTop": 0,
    "overflowY": "hidden"
  },
  "header": { "top": 0, "bottom": 64, "height": 64 },
  "aside": {
    "clientHeight": 656,
    "scrollHeight": 2935,
    "scrollTop": 1030,
    "maxScrollTop": 2279
  },
  "stream": {
    "open": true,
    "height": 1251
  },
  "streamPreCount": 6
}
```

That is a no-repro for `SPY-QA-02`, not a fix. It only explains why this RCA
moves to the next highest-priority open spy bug with current evidence.

## Proof

Initial high-volume stream state before loading events:

```json
{
  "stream": {
    "open": false,
    "height": 46,
    "elementCount": 6
  },
  "streamPreCount": 0,
  "aside": {
    "clientHeight": 656,
    "scrollHeight": 1969,
    "maxScrollTop": 1313
  },
  "health": {
    "top": 1967,
    "bottom": 2013
  }
}
```

After clicking `Load Stream Events`, the UI rendered the first API page of 100
events inline:

```json
{
  "streamPreCount": 100,
  "streamPreScrollHeightSum": 24800,
  "stream": {
    "open": true,
    "height": 27511,
    "elementCount": 505
  },
  "aside": {
    "clientHeight": 656,
    "scrollHeight": 29434,
    "maxScrollTop": 28778
  },
  "health": {
    "top": 28028,
    "bottom": 28074
  },
  "streamButtons": [
    { "text": "Load More Stream Events", "disabled": false }
  ]
}
```

After clicking `Load More Stream Events` once, the UI appended another 100
events and kept all previous event DOM nodes mounted:

```json
{
  "streamPreCount": 200,
  "streamPreScrollHeightSum": 49600,
  "stream": {
    "height": 54911,
    "elementCount": 1005
  },
  "aside": {
    "scrollHeight": 56834,
    "maxScrollTop": 56178
  }
}
```

After clicking `Load More Stream Events` a second time, all 250 events were
mounted inline:

```json
{
  "streamPreCount": 250,
  "streamPreScrollHeightSum": 62000,
  "stream": {
    "height": 68611,
    "elementCount": 1255
  },
  "aside": {
    "clientHeight": 656,
    "scrollHeight": 70534,
    "scrollTop": 56178,
    "maxScrollTop": 69878
  },
  "health": {
    "top": 14354,
    "bottom": 14400
  },
  "streamButtons": [
    { "text": "Load More Stream Events", "disabled": true }
  ]
}
```

After changing the range to `Today`, the loaded stream state persisted:

```json
{
  "streamPreCount": 250,
  "streamPreScrollHeightSum": 62000,
  "stream": {
    "open": true,
    "height": 68611,
    "elementCount": 1255
  },
  "aside": {
    "scrollHeight": 70534,
    "scrollTop": 56178,
    "maxScrollTop": 69878
  }
}
```

This reproduces the core `SPY-QA-05` behavior in a deterministic way:

- The UI loads stream events in pages, but every loaded event remains rendered
  inline.
- The stream section grows from `46 px` closed to `68,611 px` with 250 events.
- The inspector scroll height grows to `70,534 px`, while the visible inspector
  viewport is only `656 px`.
- The `Health` panel is pushed thousands of pixels away after stream expansion.
- The loaded stream state and deep inspector `scrollTop` survive a range change.

## Source Evidence

Relevant current code:

- `src/spy/ui/src/api.ts:25-26` defines `DEFAULT_STREAM_LIMIT = 100`.
- `src/spy/ui/src/api.ts:70-75` always requests stream events with
  `limit=100`, adding only a cursor when loading more.
- `src/spy/store.ts:530-545` supports cursor pagination and returns
  `nextCursor`, so the backend already exposes a bounded stream-event page.
- `src/spy/ui/src/App.tsx:362-380` stores loaded stream events in one
  `streamState.items` array and appends more pages with
  `[...(current?.items ?? []), ...page.items]`.
- `src/spy/ui/src/App.tsx:1245-1262` renders
  `props.streamState.items.map(...)` directly, producing one event card and one
  `<pre>` payload block per loaded stream event.
- `src/spy/ui/src/App.tsx:1254-1255` formats and renders each full event payload
  preview inline, clipped to 4,000 characters but still mounted as DOM text.
- `src/spy/ui/src/App.tsx:144-174` reloads calls when time range/filter/search
  state changes and intentionally preserves the selected call when it is still
  present in the new result set.
- `src/spy/ui/src/App.tsx:291-319` resets `streamState` only when the selected
  call detail version changes. A range change that keeps the same selected call
  does not clear stream events or reset inspector scroll.
- `src/spy/ui/src/App.tsx:794-814` makes the entire inspector a single
  `overflow-auto` scroll container, so the high-volume stream panel expands the
  same scroll stack that contains `Raw Payloads` and `Health`.

## Root Cause

`SPY-QA-05` is a browser-side rendering/state problem, not a backend pagination
problem.

The backend stream-event endpoint is paginated. The UI requests 100 events per
page and receives `nextCursor` correctly, but `loadStreamEvents(true)` appends
each page into a single `streamState.items` array. `StreamPanel` then maps every
loaded item into a fully mounted card with a JSON `<pre>`.

Because stream events are rendered inside the same linear inspector scroll
container as the rest of the call detail, high-volume calls turn the inspector
into a tens-of-thousands-of-pixels document. Lower panels such as `Raw Payloads`
and `Health` remain technically in the DOM but become operationally buried.

The stale-state part has a separate but related cause: time range changes reload
the timeline but preserve the selected call if that call is still in the new
result set. Since `streamState` is reset only when the selected call detail
version changes, loaded stream events and the inspector's deep scroll position
survive the range change.

## Proposed Fix

Fix `SPY-QA-05` in the inspector stream-event path:

- Keep the backend cursor pagination as-is.
- Render the stream-event list with virtualization or a bounded page window
  instead of mapping every loaded event into mounted DOM nodes.
- Avoid nested scroll traps inside every event payload. Keep each event payload
  collapsed by default or render a short summary with an explicit expand action.
- Reset stream state when the active time range, search, metadata filters, or
  selected call changes. If preserving a selected call across range changes is
  desired, still clear loaded stream events because the operator changed the
  timeline context.
- Reset the inspector scroll owner to the top when the selected call changes or
  when stream state is cleared by a range/filter/search change.
- Add Playwright coverage with a synthetic high-volume stream response proving
  that loading 250 events does not mount 250 event payload blocks and that a
  range change clears the loaded stream panel.

## Fix Status

Implemented.

Changed `src/spy/ui/src/App.tsx` so loaded stream events render through a
bounded 25-event window instead of mounting every loaded event. Event payloads
start collapsed, and expanding one payload mounts only that payload preview.

Changed stream state handling so selecting a different call or changing the
timeline context clears loaded stream events and resets the inspector scroll
owner to the top.

Added Playwright coverage in `src/spy/ui/e2e/spy-ui.playwright.ts` with a
synthetic 250-event Bedrock stream response proving that:

- Loading all 250 events leaves only 25 event cards mounted.
- Payload `<pre>` blocks are not mounted while collapsed.
- The inspector and stream section stay below the previous runaway heights.
- Changing the range to `Today` clears loaded stream events and resets
  inspector scroll.

Verification commands:

- `bun run typecheck`
- `bun run lint`
- `bun run build:spy-ui`
- `bun run test:spy-ui:unit`
- `bun run test:spy-ui:e2e`
- `bun run test`
- `git diff --check`
