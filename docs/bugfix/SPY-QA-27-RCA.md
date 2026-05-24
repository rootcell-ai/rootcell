# SPY-QA-27 RCA: Network Metadata Request Targets Are Truncated And URL-Encoded

This RCA was written before implementation for the highest-priority open spy bug
at diagnosis time: `SPY-QA-27`.

## Priority Selection

- `PLAN.md:1010-1012` lists `SPY-QA-27` as the first unchecked spy bug.
- All P0 and P1 spy QA findings are complete or closed in `PLAN.md`.
- `SPY-QA-22` through `SPY-QA-26` are also complete or closed.
- `SPY-QA-27` is therefore the highest-priority open spy bug in the current
  prioritized handoff.
- This document was written before any product-code fix for `SPY-QA-27`.

## Bug Definition

`PLAN.md:1010-1012` defines the bug:

```text
[P2] SPY-QA-27: Improve Network Metadata readability. Paths truncate and
URL-encoded model punctuation such as `%3A0` makes the request target harder
to verify.
```

`PLAN.md:1049-1050` keeps the same evidence note:

```text
Network metadata paths truncate and retain URL-encoded model punctuation such as
`%3A0`, making request targets harder to verify.
```

## Runtime Proof

I built the current spy UI and started the existing fixture spy service:

```sh
bun run build:spy-ui
bun run src/spy/ui/test-server.ts --port 5097 --static dist/spy-ui
```

The local fixture server required normal localhost permission and then listened
on:

```text
http://127.0.0.1:5097
```

I then ran a headless Playwright probe against the rendered browser UI at an
1100 x 850 viewport. The probe selected a call, routed the call detail response
to include this realistic Bedrock target, and measured the live Network
Metadata DOM:

```text
/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse-stream?X-Amz-Credential=%5Bredacted%5D&trace=abc
```

Probe output before any product-code fix:

```json
{
  "sectionWidth": 540,
  "pathText": "POST /model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse-stream?X-Amz-Credential=%5Bredacted%5D&trace=abc",
  "pathClientWidth": 402,
  "pathScrollWidth": 877,
  "pathRectWidth": 402,
  "pathOverflow": "hidden",
  "pathTextOverflow": "ellipsis",
  "pathWhiteSpace": "nowrap",
  "pathContainsEncodedColon": true,
  "pathContainsDecodedColon": false,
  "headerText": "application/vnd.amazon.eventstream; charset=utf-8; x-rootcell-proof=abcdefghijklmnopqrstuvwxyz0123456789",
  "headerClientWidth": 282,
  "headerScrollWidth": 635,
  "headerOverflow": "hidden",
  "headerTextOverflow": "ellipsis",
  "headerWhiteSpace": "nowrap"
}
```

This proves the reported bug:

- The request target needs 877 px but receives only 402 px.
- The rendered CSS is `overflow: hidden`, `text-overflow: ellipsis`, and
  `white-space: nowrap`, so the path is forcibly truncated.
- The user-visible target contains `%3A0`.
- The user-visible target does not contain the decoded model suffix `:0`.

The header measurement is not part of the tracked bug, but it shows the same
Network Metadata panel uses the same truncation pattern for other long network
values.

## Source Evidence

`proxy/agent_spy.py:139-152` redacts only sensitive query values and then
reassembles the URL from `split.path` plus `urllib.parse.urlencode(redacted)`.
That preserves URL-encoded path punctuation and encodes the redacted query value:

```text
/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse-stream?X-Amz-Credential=%5Bredacted%5D&trace=abc
```

A direct shim check confirms that behavior:

```text
_redact_path(...) ->
/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse-stream?X-Amz-Credential=%5Bredacted%5D&trace=abc
```

The same shim correctly decodes the model id for provider detection:

```json
{
  "provider": "bedrock",
  "model_id": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "operation": "converse-stream",
  "streaming": "true"
}
```

`src/spy/store.ts:826-842` persists `event.path` exactly into `http_event.path`.
The store is preserving the captured network event; it is not producing a
display-ready version.

`src/spy/ui/src/App.tsx:1418-1430` renders Network Metadata. The request target
is a single inline span:

```tsx
<span className="truncate text-sm font-medium">{event.method} {event.path}</span>
```

`truncate` applies the measured no-wrap hidden-overflow ellipsis. No UI helper
decodes a display path, separates method/path/query, gives the request target a
wrapping layout, or exposes the full readable target in a prominent place.

## Root Cause

`SPY-QA-27` is a browser Network Metadata presentation bug.

The capture and store layers keep the raw redacted HTTP path, which is the right
durable network record. That raw value can contain URL-encoded punctuation from
Bedrock model IDs, such as `%3A0`, and URL-encoded redaction markers from query
redaction, such as `%5Bredacted%5D`.

The browser UI then uses that raw persistence value as the only human-facing
request target and places it in a single truncating flex row. At normal inspector
width, the path is too long to fit, so the browser hides the right side with an
ellipsis. Since the UI never derives a decoded display label, the operator sees
encoded model punctuation even when the shim already knows the decoded model id.

The API data, provider detection, and SQLite persistence are not the root cause.
They preserve correct raw network data. The missing layer is a readable UI
presentation for redacted HTTP targets.

## Proposed Fix

Fix `SPY-QA-27` in `src/spy/ui/src/App.tsx` and nearby UI helpers:

- Keep the raw persisted `event.path` unchanged.
- Add a browser-only formatter for HTTP request targets that:
  - safely parses path-plus-query strings without requiring an absolute URL;
  - decodes path segment punctuation for display, including `%3A0` to `:0`;
  - preserves redacted query semantics while displaying readable values such as
    `[redacted]` where possible;
  - falls back to the raw path if parsing or decoding fails.
- Render Network Metadata with a readable multi-line layout instead of one
  truncating span:
  - method/status as compact metadata;
  - decoded display path as wrapping monospace or copyable text;
  - query string separately when present;
  - raw target available as secondary detail or `title`/copy text.
- Avoid decoding or changing data before auth/query redaction. This should be a
  display-only change.
- Consider applying the same wrapping treatment to long header values in the
  Network Metadata panel, since the runtime probe showed identical truncation
  mechanics there.

## Regression Coverage

Add Playwright coverage for a mocked Bedrock Network Metadata record whose path
contains:

```text
/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse-stream?X-Amz-Credential=%5Bredacted%5D&trace=abc
```

The test should prove:

- the visible Network Metadata target includes
  `us.anthropic.claude-haiku-4-5-20251001-v1:0`;
- `%3A0` is not the primary visible model suffix;
- the request target does not have hidden horizontal overflow at the normal
  desktop QA viewport;
- the raw encoded path remains available somewhere if needed for exact network
  inspection.

## Fix Status

Fixed on 2026-05-24.

Implementation summary:

- Added `formatHttpTarget` in `src/spy/ui/src/format.ts` as a display-only
  formatter for redacted HTTP targets.
- Kept the raw stored `event.path` unchanged while decoding readable display
  punctuation such as `%3A0` to `:0`.
- Reworked Network Metadata in `src/spy/ui/src/App.tsx` so method/status,
  decoded path, decoded query, and raw target are separate readable rows.
- Kept the raw encoded target available under `Raw target`.
- Changed long header names/values in the Network Metadata panel to wrap
  instead of truncating.
- Added unit coverage for encoded target formatting and invalid percent-escape
  fallback.
- Added Playwright coverage proving the decoded Bedrock model id is visible,
  `%3A0` is not the primary visible suffix, the path has no hidden horizontal
  overflow at the normal 1100 px QA viewport, and the raw encoded target remains
  available.

Verification:

- `bun test src/spy/ui/src/format.test.ts --timeout 10000`
- `bun run typecheck`
- `bun run lint`
- `bun run build:spy-ui`
- `./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts -g "network metadata"`
- `bun run test:spy-ui:unit`
- `./node_modules/.bin/playwright test -c src/spy/ui/playwright.config.ts`
- `bun run build:spy`
- `bun run test` with localhost permission for spy service tests
- `git diff --check`
