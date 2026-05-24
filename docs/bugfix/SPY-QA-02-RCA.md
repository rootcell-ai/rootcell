# SPY-QA-02 RCA: Hidden Top-Level Scrolling

## Scope

This RCA covers what was the highest-priority open spy item in `PLAN.md`:
`SPY-QA-02`.

`PLAN.md` describes the failure as lower inspector focus or panel opening setting
`main.scrollTop` even though `main` uses `overflow-hidden`, which pushes the
global header and range controls above the visible viewport without a visible
page scrollbar.

## Triage Result

`SPY-QA-02` does not reproduce in the current tree. The current evidence points
to a stale open checkbox for a symptom that was removed by the completed
`SPY-QA-01` layout fix.

No product-code fix should be made from the old QA note alone. After review,
`SPY-QA-02` was closed in `PLAN.md` as no-repro in the current implementation,
while keeping the existing Playwright guard that verifies this failure mode.

## Reproduction Attempt

I used the production-built spy UI and the fixture-backed spy UI test server:

- `bun run build:spy-ui`
- `bun run src/spy/ui/test-server.ts --port 4682 --static dist/spy-ui`
- Opened `http://127.0.0.1:4682/?since=0` in headless Chromium.
- Used the `1159 x 862` viewport mentioned in the manual QA notes.
- Selected the first provider call.
- Jumped to lower inspector sections through the section navigator:
  `Network`, `Stream`, `Raw`, and `Health`.
- Loaded stream events when the stream panel exposed the load control.

## Proof

Runtime DOM metrics after the attempted reproduction:

```json
{
  "viewport": {
    "width": 1159,
    "height": 862
  },
  "document": {
    "documentElementScrollTop": 0,
    "bodyScrollTop": 0
  },
  "main": {
    "scrollTop": 0,
    "scrollHeight": 862,
    "clientHeight": 862,
    "rect": {
      "top": 0,
      "bottom": 862,
      "height": 862
    },
    "overflowY": "hidden"
  },
  "header": {
    "rect": {
      "top": 0,
      "bottom": 64,
      "height": 64
    }
  },
  "aside": {
    "scrollTop": 2002,
    "scrollHeight": 2800,
    "clientHeight": 798,
    "rect": {
      "top": 64,
      "bottom": 862,
      "height": 798
    },
    "overflowY": "auto"
  },
  "health": {
    "top": 523,
    "bottom": 842,
    "height": 319
  },
  "openSections": [
    "inspector-section-network",
    "inspector-section-stream",
    "inspector-section-raw",
    "inspector-section-health"
  ]
}
```

Key observations:

- `main.scrollTop` stayed `0`.
- `main.scrollHeight` equals `main.clientHeight` at `862`, so the top-level
  container has no hidden scroll range in this layout.
- `documentElement.scrollTop` and `body.scrollTop` also stayed `0`.
- The global header remained visible at y=`0..64`.
- The scroll movement happened in `aside`, which is the intended inspector
  scroll owner.
- The lower Health section remained visible inside the viewport at y=`523..842`.

The existing Playwright regression for this same class of bug also passes:

```text
$ bunx playwright test -c src/spy/ui/playwright.config.ts -g "jumps to buried inspector sections from the section navigator"
Running 1 test using 1 worker
  ✓  1 src/spy/ui/e2e/spy-ui.playwright.ts:251:1 › jumps to buried inspector sections from the section navigator (4.8s)

  1 passed (5.4s)
```

## Source Evidence

Current layout code constrains the page to two viewport rows and makes the body
grid shrinkable:

- `src/spy/ui/src/App.tsx:493` sets `main` to
  `grid h-screen min-h-0 grid-rows-[4rem_minmax(0,1fr)] overflow-hidden`.
- `src/spy/ui/src/App.tsx:526` sets the body grid to `min-h-0 overflow-hidden`.
- `src/spy/ui/src/App.tsx:527` makes the timeline column `min-h-0`.

The current section navigation still calls `scrollIntoView`, which is the path
that would reveal `SPY-QA-02` if a top-level scroll range still existed:

- `src/spy/ui/src/App.tsx:1018-1035` renders the inspector section navigator.
- `src/spy/ui/src/App.tsx:1050-1055` opens details sections and calls
  `target?.scrollIntoView({ block: "start" })`.

The existing e2e guard asserts that this navigation path scrolls the inspector,
not `main`:

- `src/spy/ui/e2e/spy-ui.playwright.ts:251-311`
- Initial assertion: `mainScrollTop` is `0`.
- After jumping to Health: `asideScrollTop` is greater than `0`,
  `mainScrollTop` remains `0`, and the header remains at the top of the
  viewport.

## Root Cause

The original `SPY-QA-02` symptom depended on `main` having hidden overflow with
a real internal scroll range. In that older layout, browser focus movement or
`scrollIntoView` could satisfy the requested scroll by moving the hidden
top-level container, which made the global header disappear even though no page
scrollbar was available.

The current layout no longer gives `main` a scroll range. The measured
`main.scrollHeight === main.clientHeight`, and lower-section navigation moves
only the inspector `aside`. That matches the completed `SPY-QA-01` RCA: the
actual shared cause was the old page shell allowing content-driven heights to
exceed the visible viewport while `main` clipped the overflow.

## Plan Status

Do not change product code for `SPY-QA-02` unless a new reproduction is found.

`PLAN.md` now closes `SPY-QA-02` as stale/no-repro in the current tree, with
this RCA as the proof. The next actual implementation bug to diagnose should be
the highest-priority remaining reproducible item after that.
