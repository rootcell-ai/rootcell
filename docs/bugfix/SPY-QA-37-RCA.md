# SPY-QA-37 RCA: Spy Verification Baseline Fails Lint

This RCA was written before any product-code fix for the highest-priority spy
defect I could prove at diagnosis time.

Status after rerun: the lint issue described here was fixed before I made any
product-code changes. `bun run lint` now passes, and the affected spy Playwright
coverage still passes.

## Priority Selection

- `PLAN.md:830-1080` marks every listed V1 manual browser QA spy bug from
  `SPY-QA-01` through `SPY-QA-36` closed.
- `PLAN.md:1121-1131` keeps `bun run lint` in the required verification
  baseline for follow-up fixes.
- At diagnosis time, the tree failed that baseline command in spy-specific
  Playwright test code.
- Runtime spy checks I ran did not reveal a higher-priority product regression:
  `bun run typecheck`, Python shim unit tests, `bun run test:spy-ui:unit`,
  `bun run test` with localhost permission, and `bun run test:spy-ui:e2e` with
  localhost/browser permission pass.

Therefore the highest-priority reproducible spy defect at diagnosis time was
the lint baseline failure, because it blocked the documented verification gate
for future spy fixes.

## Bug

At diagnosis time, `bun run lint` failed on the current tree:

```text
/Users/jmp/Library/Mobile Documents/com~apple~CloudDocs/projects/agent-vm/src/spy/ui/e2e/spy-ui.playwright.ts
  422:33  error  Unnecessary optional chain on a non-nullish value  @typescript-eslint/no-unnecessary-condition

✖ 1 problem (1 error, 0 warnings)
```

A focused lint run on just the spy Playwright file produces the same error:

```text
bun eslint src/spy/ui/e2e/spy-ui.playwright.ts

src/spy/ui/e2e/spy-ui.playwright.ts
  422:33  error  Unnecessary optional chain on a non-nullish value  @typescript-eslint/no-unnecessary-condition
```

Screenshot evidence is not applicable: this is a static verification failure,
not a rendered browser defect.

## Reproduction

From the repository root:

```sh
bun run lint
```

Observed result: command exits with code `1` and reports the
`@typescript-eslint/no-unnecessary-condition` error above.

For a smaller reproduction:

```sh
bun eslint src/spy/ui/e2e/spy-ui.playwright.ts
```

Observed result: command exits with code `1` with the same line `422:33`
diagnostic.

## Root Cause Evidence

`package.json:7` defines the lint baseline as:

```json
"lint": "eslint \"src/**/*.{ts,tsx,js,mjs,cjs}\" eslint.config.ts vitest.config.ts"
```

That includes `src/spy/ui/e2e/spy-ui.playwright.ts`.

`eslint.config.ts:10-11` enables `typescript-eslint`'s type-checked strict and
stylistic rule sets. The reported rule is
`@typescript-eslint/no-unnecessary-condition`.

The failing code is in the SPY-QA-36 regression coverage at
`src/spy/ui/e2e/spy-ui.playwright.ts:415-424`:

```ts
const metrics = await started.evaluate((element) => {
  const styles = getComputedStyle(element);
  return {
    clientWidth: element.clientWidth,
    overflow: styles.overflow,
    scrollWidth: element.scrollWidth,
    textOverflow: styles.textOverflow,
    value: element.textContent?.trim(),
    whiteSpace: styles.whiteSpace,
  };
});
```

The linter's JSON output identifies exactly that optional chain and suggests
removing it:

```json
{
  "ruleId": "@typescript-eslint/no-unnecessary-condition",
  "message": "Unnecessary optional chain on a non-nullish value.",
  "line": 422,
  "column": 33,
  "suggestions": [
    { "desc": "Remove unnecessary optional chain" }
  ]
}
```

This proves the RCA:

- the documented lint command includes the spy Playwright file
- the active ESLint config enables type-aware unnecessary-condition checking
- the only reported lint error points to `element.textContent?.trim()`
- the linter says the optional chain is unnecessary and suggests replacing it
  with a normal property access

## Non-Causes Checked

- `bun run typecheck` passes, so this is not a TypeScript compile failure.
- `python3 -m unittest discover -s proxy -p 'test_*.py'` passes, so this is not
  a Python capture shim regression.
- `bun run test` passes when localhost binding is allowed, so the spy store,
  service, adapter, UI unit helpers, and Vitest unit suite are not currently
  failing.
- `bun run test:spy-ui:e2e` passes when localhost/browser permissions are
  available, so the SPY-QA-36 browser behavior covered by this test is still
  good. The failure is the test's lint compliance, not the UI behavior under
  test.

## Proposed Fix

Fix only the lint violation in `src/spy/ui/e2e/spy-ui.playwright.ts`:

```ts
value: element.textContent.trim(),
```

The preceding assertion already requires the selected Started metric to contain
visible text:

```ts
await expect(started).toContainText("May");
```

After the one-line test fix, rerun:

```sh
bun run lint
bun run test:spy-ui:e2e
```

No product UI, API, capture, normalization, persistence, or provisioning code
should change for this bug.

## Rerun After User Fix

After the lint fix landed, I reran the nearby spy verification checks:

- `bun run lint`: pass
- `bun run typecheck`: pass
- `python3 -m unittest discover -s proxy -p 'test_*.py'`: pass, 25 tests
- `bun run test:spy-ui:unit`: pass, 20 tests
- `bun run test`: pass with localhost bind permission, 47 Bun tests and 87
  Vitest tests
- `bun run test:spy-ui:e2e`: pass with localhost/browser permission, 27 tests

The non-escalated `bun run test` and `bun run test:spy-ui:e2e` attempts still
hit the known sandbox localhost listener restriction, then passed when run with
the required permissions.
