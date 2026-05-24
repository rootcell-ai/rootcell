# SPY-QA-32 RCA: Disconnected SSE Badge Looks Like an Action

This RCA was written before implementation for the highest-priority open spy
bug in the current tree: `SPY-QA-32`.

## Priority Selection

- `PLAN.md` lists all P0 and P1 spy QA findings as fixed or closed.
- The remaining open spy bugs are `SPY-QA-32` at P2, followed by P3 polish
  items `SPY-QA-34`, `SPY-QA-35`, and `SPY-QA-36`.
- Therefore `SPY-QA-32` is the highest-priority open spy bug.
- This document was written before any product-code fix for `SPY-QA-32`.

## Bug Definition

`PLAN.md` defines the bug:

```text
[P2] SPY-QA-32: Make the disconnected SSE `Reconnect` badge either a real
control or passive status text. It currently reads like a clickable action.
```

The ID-keyed evidence note restates the expected diagnosis:

```text
SPY-QA-32: The disconnected SSE badge is labeled `Reconnect` but behaves as
passive auto-recovering status, so the label reads like a clickable action.
```

## Current Reproduction

I reproduced the issue against the fixture-backed spy UI before changing
product code.

Commands used:

```sh
bun run src/spy/ui/test-server.ts --port 4974 --static dist/spy-ui
```

The first non-escalated localhost bind attempts failed with `EADDRINUSE`, which
is consistent with the workspace's localhost binding restrictions. The approved
localhost server run succeeded and reported:

```text
rootcell spy UI test server listening on http://127.0.0.1:4974
```

I opened `http://127.0.0.1:4974/?since=0`, waited for fixture timeline rows and
the connected `SSE` header badge, then stopped the fixture server so the
browser's `EventSource` moved into its disconnected auto-retry path.

Screenshot captured before a fix:


The screenshot shows the header presenting an amber `Reconnect` badge next to
the refresh and clear icon buttons.

## DOM Proof

After the disconnect, the header state measured in the browser was:

```json
{
  "buttonsNamedReconnect": 0,
  "headerText": "Rootcell SpySince Dec 31, 07:00:00 PMReconnectraw off",
  "reconnectBadge": {
    "ariaLabel": null,
    "className": "inline-flex h-6 items-center rounded-md border px-2 text-xs font-medium border-amber-200 bg-amber-50 text-amber-800 gap-1",
    "onclick": null,
    "rect": {
      "height": 24,
      "width": 97,
      "x": 1017,
      "y": 20
    },
    "role": null,
    "tabIndex": null,
    "tagName": "SPAN",
    "text": "Reconnect"
  }
}
```

This proves the bug:

- The visible disconnected label is exactly `Reconnect`.
- No button named `Reconnect` exists.
- The visible `Reconnect` UI is a non-focusable `span`, not a control.
- The element has no role, no `tabindex`, and no click handler.

## Source Evidence

`src/spy/ui/src/App.tsx` renders the header connection state with `Badge`, a
plain `span` component:

```tsx
<Badge tone={sseConnected ? "teal" : "amber"} className="gap-1">
  {sseConnected ? <Wifi aria-hidden="true" size={13} /> : <WifiOff aria-hidden="true" size={13} />}
  {sseConnected ? "SSE" : "Reconnect"}
</Badge>
```

`src/spy/ui/src/components/ui/badge.tsx` confirms that `Badge` renders a
non-interactive `span`:

```tsx
return (
  <span className={cn("inline-flex h-6 items-center rounded-md border px-2 text-xs font-medium", toneClass[tone], className)}>
    {children}
  </span>
);
```

The SSE lifecycle in `src/spy/ui/src/App.tsx` creates a single `EventSource`.
Its error handler only marks the connection as disconnected:

```tsx
const source = new EventSource("/api/events");
const onError = (): void => {
  setSseConnected(false);
};
```

There is no user-invoked reconnect function. Reconnect behavior is the
browser's passive `EventSource` retry behavior.

## Root Cause

`SPY-QA-32` is caused by labeling passive connection status with an imperative
verb.

The UI says `Reconnect`, which reads like a command next to real icon buttons
for refresh and clear. But the badge is only status text. The underlying
behavior is automatic SSE retry through the existing `EventSource`; there is no
manual reconnect action wired to the visible badge.

## Proposed Fix

Use passive status language for the disconnected SSE state:

- Change the disconnected badge text from `Reconnect` to `SSE offline`.
- Keep the connected state as `SSE`.
- Keep the badge as passive status text rather than adding a redundant manual
  control, since `EventSource` already retries automatically and the existing
  refresh button handles manual call-list refresh.
- Add Playwright coverage proving the disconnected state renders `SSE offline`
  and does not expose a clickable `Reconnect` control.
- Update `PLAN.md` after implementation to mark `SPY-QA-32` complete.

## Verification Plan

After implementation:

```sh
bun run typecheck
bun run lint
bun run test:spy-ui:unit
bun run test:spy-ui:e2e
```

The e2e suite requires localhost/browser permission in this workspace.

## Implemented Fix

Changed `src/spy/ui/src/App.tsx` so the disconnected SSE state renders as
passive `SSE offline` status text instead of the action-like `Reconnect` label.
The connected state remains `SSE`.

Changed `src/spy/ui/src/components/ui/badge.tsx` so `Badge` can pass standard
`span` attributes through to the rendered element. The SSE badge now exposes
`role="status"` with an explicit accessible name for the connected and offline
states.

Added Playwright coverage in `src/spy/ui/e2e/spy-ui.playwright.ts` that aborts
`/api/events`, verifies `SSE offline` is exposed as status text, and proves no
`Reconnect` button or visible `Reconnect` label remains.

Updated `PLAN.md` to mark `SPY-QA-32` complete.

After-fix screenshot:


Measured after the fix:

```json
{
  "ariaLabel": "SSE offline",
  "buttonsNamedReconnect": 0,
  "rect": {
    "height": 24,
    "width": 98,
    "x": 1016,
    "y": 20
  },
  "role": "status",
  "text": "SSE offline"
}
```

This proves the disconnected state is now passive status text and no longer
advertises a non-existent `Reconnect` action.

## Verification Completed

```sh
bun run typecheck
bun run lint
bun run test:spy-ui:unit
bun run test:spy-ui:e2e
```

Results:

- `bun run typecheck`: passed.
- `bun run lint`: passed.
- `bun run test:spy-ui:unit`: passed, 19 tests.
- `bun run test:spy-ui:e2e`: first sandboxed attempt built the UI but failed
  to bind the local fixture server; rerun with localhost bind permission passed,
  25 tests.
