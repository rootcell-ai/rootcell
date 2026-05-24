# SPY-QA-21 RCA: Clear Spy Data Dialog Does Not Own Focus

## Scope

This RCA covers the highest-priority reproducible spy bug in the current tree:
`SPY-QA-21`.

Triage notes:

- `PLAN.md` marks all P0 spy bugs closed.
- `PLAN.md:963-964` lists `SPY-QA-20` first among unchecked P1 items, but I
  could not reproduce it in the current UI. A pending call with all usage fields
  set to `null` rendered `read -`, `write -`, `cache read -`, and
  `cache write -`; the row contained neither `usage usage n/a` nor any standalone
  `usage` text.
- `SPY-QA-21` is the next unchecked P1 item and is reproducible.
- This document was written before any product-code fix for `SPY-QA-21`.

## Bug Definition

`PLAN.md:965-967` defines the current bug:

```text
[P1] SPY-QA-21: Fix modal focus management for Clear spy data. Focus stays
on the background icon button, the background is not effectively inert, and
Escape did not close the dialog during QA.
```

## Reproduction Used

I used the current spy UI through Vite and a headless Chromium probe with mocked
same-origin API responses:

```sh
bun run dev:spy-ui -- --port 4788
node /private/tmp/spy_qa21_clear_dialog_probe.mjs
```

The probe loaded `http://127.0.0.1:4788/?since=0`, waited for a timeline row,
clicked the `Clear spy data` icon button, inspected focus state, pressed
`Escape`, then pressed `Tab` four times.

## Runtime Proof

Before implementation, the tree produced this output:

```json
{
  "afterOpen": {
    "activeElementTag": "BUTTON",
    "activeElementLabel": "Clear spy data",
    "activeElementText": "",
    "mainInert": false,
    "dialogCount": 1
  },
  "afterEscape": {
    "dialogVisible": true,
    "activeElementTag": "BUTTON",
    "activeElementLabel": "Clear spy data",
    "activeElementText": ""
  },
  "focusedAfterTabs": [
    {
      "tag": "BUTTON",
      "label": null,
      "text": "Live",
      "insideDialog": false
    },
    {
      "tag": "BUTTON",
      "label": null,
      "text": "10 min",
      "insideDialog": false
    },
    {
      "tag": "BUTTON",
      "label": null,
      "text": "1 hour",
      "insideDialog": false
    },
    {
      "tag": "BUTTON",
      "label": null,
      "text": "Today",
      "insideDialog": false
    }
  ]
}
```

This proves all three reported symptoms:

- Opening the dialog leaves focus on the background `Clear spy data` button.
- Pressing `Escape` leaves the dialog visible.
- Tabbing moves focus through background range controls instead of staying inside
  the dialog.

## Pre-Fix Source Evidence

`src/spy/ui/src/App.tsx:520-522` opens the dialog by setting `clearOpen` to
`true`, but does not save or move focus.

`src/spy/ui/src/App.tsx:596-605` renders `ClearDialog` as a child of the same
`main` element as the background app. There is no inert wrapper around the
background while the dialog is open.

`src/spy/ui/src/App.tsx:1638-1659` implements `ClearDialog` as plain markup:

- The wrapper has `role="dialog"`, `aria-modal="true"`, and
  `aria-labelledby="clear-title"`.
- There is no ref, `useEffect`, `autoFocus`, or focus-trap logic.
- There is no `onKeyDown` or document-level key handler for `Escape`.
- Cancel and Clear buttons work only when directly clicked.

`src/spy/ui/src/components/ui/button.tsx:25-43` is a normal forwarded-ref button
component. It does not provide dialog-specific focus behavior.

## Root Cause

`SPY-QA-21` is a browser focus-management bug in the dialog composition.

The dialog sets ARIA semantics but does not implement the imperative behavior a
modal needs. `aria-modal="true"` announces modal intent to assistive technology,
but it does not move focus, trap focus, make the background inert, close on
`Escape`, or restore focus after close.

Because the clicked header button remains `document.activeElement`, the next
`Tab` continues from that button's normal DOM position into the timeline range
controls. Since the dialog is rendered inside the same `main` subtree and no
background subtree is marked inert, keyboard navigation can continue through the
background app while the dialog is visible.

## Proposed Fix

Fix `SPY-QA-21` in `src/spy/ui/src/App.tsx`:

- Render the app shell and dialog as siblings so the app shell can be marked
  inert while the dialog is open.
- Store a ref to the `Clear spy data` trigger and restore focus to it when the
  dialog closes.
- Give `ClearDialog` refs for the dialog container and primary focus target.
  Focus the Cancel button on mount.
- Handle `Escape` inside the dialog and close it when not actively clearing.
- Trap `Tab` and `Shift+Tab` within enabled focusable controls in the dialog.
- Preserve the existing clear action behavior and disabled state while clearing.
- Add Playwright coverage that opens the dialog, proves focus enters it, proves
  `Tab` stays inside it, proves `Escape` closes it, and proves focus returns to
  the trigger.

## Expected Post-Fix Proof

The same reproduction should show:

- `afterOpen.activeElementText` is `Cancel` or `Clear`, and
  `insideDialog: true`.
- `mainInert` is `true` for the background app shell, or an equivalent app-shell
  inert flag is present.
- After pressing `Escape`, `dialogVisible` is `false`.
- Reopening the dialog and pressing `Tab` cycles between dialog controls only.
- After close, focus returns to the `Clear spy data` trigger button.

## Fix Status

Implemented on 2026-05-24.

Changed `src/spy/ui/src/App.tsx` so the Clear Spy Data dialog is rendered as a
sibling of the app shell. The app shell receives `inert` while the dialog is
open, and the dialog owns focus:

- The header `Clear spy data` trigger is stored in a ref.
- Cancel receives focus on dialog mount.
- `Tab` and `Shift+Tab` are trapped within enabled dialog controls.
- `Escape` closes the dialog when a clear operation is not actively running.
- Closing the dialog restores focus to the header trigger.

Added Playwright coverage in `src/spy/ui/e2e/spy-ui.playwright.ts` proving that
the dialog focuses Cancel on open, makes the app shell inert, cycles focus
between Cancel and Clear, closes on Escape, removes inert from the app shell,
and restores focus to the trigger.

Post-fix browser proof from the in-app browser sanity check:

```json
{
  "afterOpen": {
    "activeText": "Cancel",
    "dialogVisible": true,
    "insideDialog": true,
    "mainInert": true
  },
  "afterEscape": {
    "activeLabel": "Clear spy data",
    "dialogVisible": false,
    "insideDialog": false,
    "mainInert": false
  }
}
```

Verification run:

- `bun run typecheck`
- `bun run test:spy-ui:unit`
- `bun run build:spy-ui`
- `./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts -g "traps focus"`
- `./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts`
