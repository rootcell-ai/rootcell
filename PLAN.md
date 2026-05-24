# Rootcell Browser Spy Plan

## Goal

Replace the current `rootcell spy --tui` / terminal spy workflow with an opt-in,
firewall-hosted browser system for inspecting LLM provider traffic.

The system should make it easy to answer:

- What did the harness send to the model?
- How much visible context was included with a short request?
- Which sections are system context, tools, history, current user input,
  assistant output, thinking/reasoning, cache markers, and provider metadata?
- What did the provider report for input, output, cache read, and cache write
  token usage?
- How did this request differ from the previous comparable request?
- What happened on the exact network request/response when deeper inspection is
  needed?

The first implementation targets Pi.dev using Amazon Bedrock. The architecture
must make future direct Anthropic, OpenAI, Claude Code, Codex, Cursor, and
multi-conversation support straightforward, but those are not v1 scope.

## Decisions

- `./rootcell spy` launches the browser UI. It no longer tails the terminal.
- Remove the old Textual TUI and old NDJSON spy format. There is no migration or
  compatibility requirement.
- The spy system is opt-in. `ROOTCELL_SPY_ENABLED=false` is the default.
- When enabled, capture is always-on even when the browser is closed.
- Capture and the web service run on the firewall VM.
- The browser reaches the service through a rootcell-managed SSH local port
  forward. No public web port is exposed.
- The browser UI is a local operator tool, not a hardened multi-user web app.
  No auth system, no collaboration, and no public exposure in v1.
- Only LLM-provider traffic is captured. Non-provider HTTPS traffic must never be
  spooled or persisted.
- Spy does not broaden network access. Bedrock/provider endpoints still must be
  allowed through the normal DNS/HTTPS allowlists for the harness to use them.
- Python remains only as a minimal mitmproxy shim. The main spy system is
  TypeScript under `src/spy`.
- The Python shim provider-gates and redacts auth headers/query credentials,
  then writes bounded raw provider events to a spool.
- TypeScript owns validation, provider normalization, persistence, retention,
  API, SSE, and UI serving.
- SQLite is the persistent store.
- V1 stores normalized semantic content by default. Exact raw payload storage is
  optional via `ROOTCELL_SPY_STORE_RAW=false`.
- Request/response bodies that pass provider gating are sensitive and may
  contain secrets. Do not attempt body secret redaction beyond binary/media
  summarization.
- Desktop-only UI. Do not spend v1 scope on mobile support.
- No keyboard shortcut requirement. Design the browser UX on its own terms, not
  as a TUI clone.
- Token counting for highlighted text and per-block token estimates are v1.5,
  not v1.
- Automated compaction detection is v1.5, not v1.
- Broader charts/visual regression screenshots are v1.5 or later.

## Architecture

### Firewall Components

Provision these components on every firewall VM, even when spy is disabled:

- Minimal Python mitmproxy shim, replacing `proxy/agent_spy.py` and
  `proxy/agent_spy_tui.py`.
- TypeScript spy service under `src/spy`.
- Built static React app served by the TypeScript service.
- Persistent directories:
  - SQLite store: `/var/lib/rootcell-spy/spy.sqlite`
  - transient spool: `/var/spool/rootcell-spy/`
  - generated config: `/etc/agent-vm/spy.env`

When `ROOTCELL_SPY_ENABLED=false`, the service should be stopped/disabled and
the shim must not write spool files. Existing spy data is preserved until the
user enables spy and retention runs, or explicitly clears it.

### Python Shim

The shim must be tiny and traffic-safe:

- Check generated spy config/marker before doing any capture work.
- Detect only registered LLM provider candidates, starting with Bedrock Runtime
  host/path patterns.
- Redact auth headers and credential query parameters.
- Emit separate spool events for request, response metadata/body, error, and
  stream/chunk observations when available.
- Do not reassemble streams in Python. If mitmproxy exposes safe chunk hooks,
  write one sanitized spool event per observed chunk. Otherwise write the
  provider response body and let TypeScript decode logical stream frames.
- Enforce `ROOTCELL_SPY_SPOOL_MAX_BYTES` before appending.
- Never open SQLite.
- Never perform deep provider normalization.
- Never alter allow/deny decisions or block agent traffic if capture fails.

If the spool is full, the shim should stop writing new capture payloads and, if
there is room, write a small rate-limited dropped-capture marker. Agent traffic
must continue under the existing firewall policy.

### TypeScript Service

Use Bun and TypeScript. Prefer Bun built-ins and pure JS/TS dependencies. Avoid
native npm packages unless they are explicitly target-built by Nix for the
firewall architecture.

The service responsibilities:

- Validate spool events with Zod.
- Ingest and delete spool files after successful commit.
- Decode Bedrock payloads and AWS event-stream frames.
- Pair request/response events by flow id.
- Persist provider calls, normalized blocks, stream events, raw payloads when
  enabled, health counters, and service metadata.
- Run SQLite migrations on startup.
- Enforce retention by age and size while running.
- Serve a same-origin JSON API, SSE endpoint, and built React assets.
- Expose health/status data for capture and service state.

Use Bun's native HTTP server for v1 unless routing becomes painful. Use Bun's
SQLite support if available in the pinned guest Bun; otherwise choose a
Nix-provisioned, target-native SQLite option.

### Build And Delivery

Static frontend assets may be built on the host because HTML, CSS, and browser
JavaScript bundles are architecture-neutral.

The TypeScript service runtime and dependencies must be target-native on the
firewall VM:

- Do not copy host `node_modules` into the firewall VM.
- Do not rely on macOS-built native npm artifacts.
- Avoid native npm dependencies in `src/spy` where feasible.
- If a native dependency becomes necessary, build/provision it through Nix for
  the firewall target architecture.
- The firewall should not download npm packages or CDN assets at runtime.

### Browser UI

Use React + TypeScript + Vite, Tailwind, and local shadcn/ui-style components.
Vendor only the needed shadcn components. Do not depend on CDN assets, remote
fonts, or runtime package downloads.

The first screen should be a live conversation-analysis surface:

- Default load mode is "live from now"; do not auto-load historical events.
- `./rootcell spy` passes a viewer launch timestamp so the UI starts clean.
- Historical loading is explicit through time range controls such as last
  10 minutes, last hour, today, and custom range.
- Timeline rows are provider calls styled as conversation events.
- Each request/response pair is directly selectable.
- The right-side inspector is call-native: it shows exactly one provider call.
- The inspector includes request details, response details, network metadata,
  headers, usage, cache markers, stream events on demand, and diff against the
  previous comparable request.

Performance requirements:

- Virtualize the live timeline.
- Fetch summaries first and details on demand.
- Paginate historical queries.
- Keep stream events and raw payload details collapsed and loaded only on
  request.
- Use semantic highlighting instead of editor-style highlighting as the primary
  visual language.
- Avoid rendering giant JSON/code blocks into the DOM.

Semantic highlighting should distinguish:

- provider/request envelope
- harness/system context
- user-visible messages
- prior conversation history
- current user input
- assistant output
- thinking/reasoning
- tool definitions
- tool calls and tool results
- cache markers
- media summaries
- unknown/unclassified content

JSON/code highlighting inside raw detail panels is secondary and should only be
used when cheap and bounded.

## Configuration

Seed these settings into `.env.defaults` as explicit defaults/comments:

```sh
ROOTCELL_SPY_ENABLED=false
# ROOTCELL_SPY_RETENTION_DAYS=7
# ROOTCELL_SPY_MAX_BYTES=6442450944
# ROOTCELL_SPY_SPOOL_MAX_BYTES=1073741824
# ROOTCELL_SPY_STORE_RAW=false
# ROOTCELL_SPY_BIND=127.0.0.1
# ROOTCELL_SPY_PORT=6174
```

Defaults:

- Spy disabled unless `ROOTCELL_SPY_ENABLED=true`.
- Retain for 7 days.
- Total spy store budget: 6 GiB.
- Spool budget: 1 GiB.
- Raw exact payload storage disabled.
- Firewall service binds `127.0.0.1:6174`.

`./rootcell spy` should choose host-local port `6174` when available and fall
back to another available local port if needed. The SSH tunnel forwards the
host-local port to `127.0.0.1:6174` on the firewall VM.

## CLI And Provisioning

### `rootcell provision`

Always provision the spy service files, UI assets, directories, config template,
and systemd units.

When enabled:

- Render `/etc/agent-vm/spy.env`.
- Enable/start the TypeScript spy service.
- Enable shim writes through generated config/marker.
- Preserve existing spy data.

When disabled:

- Render config with spy disabled.
- Stop/disable the TypeScript spy service.
- Ensure the shim returns without spooling.
- Preserve existing spy data.

Do not implement migration/remediation for existing small disks. There are no
existing users to support.

### `rootcell spy`

Required behavior:

- If spy is disabled, print clear instructions to set
  `ROOTCELL_SPY_ENABLED=true` in the selected instance `.env` and run
  `./rootcell provision`.
- If service files/assets are missing or stale, tell the user to run
  `./rootcell provision`; do not auto-provision.
- Ensure the firewall VM and service are reachable.
- Start an SSH local port forward through the provider abstraction.
- Print the local URL.
- Open the browser by default, with `--no-open` available.
- Stay in the foreground to keep the tunnel alive.
- Exit on Ctrl-C, closing only the tunnel.

Remove `--tui`, `--raw`, and `--no-dedupe` from the user-facing CLI.

Implement host-side launcher and tunnel lifecycle in TypeScript using provider
and transport abstractions. Avoid POSIX shell assumptions because Windows host
support is a future goal.

## Data Model

Use Zod schemas and SQLite migrations checked into `src/spy`.

V1 durable unit:

- `provider_call`

Attached records:

- request event metadata
- response event metadata
- normalized request blocks
- normalized response blocks
- stream events decoded from provider payloads
- usage records reported by the provider
- optional raw sanitized payload records
- content hashes for repeated-context and diffing
- health/drop/error counters

Reserve future grouping concepts such as `turn_id` or conversation grouping, but
do not build turn grouping behavior in v1.

Normalized blocks should preserve:

- original order
- role/type
- source/provenance
- provider payload location when possible
- character and byte size
- content hash
- cache marker metadata
- media summaries instead of full binary/media bytes

Do not compute or display per-block token estimates in v1.

## API Shape

Endpoint names are provisional, but v1 should expose these boundaries:

- `GET /api/health`
- `GET /api/calls?since=&provider=&model_id=&operation=&status=&cursor=&limit=`
- `GET /api/calls/:id`
- `GET /api/calls/:id/diff`
- `GET /api/calls/:id/stream-events`
- `GET /api/search?q=&since=&provider=&model_id=&operation=&status=&cursor=&limit=`
- `POST /api/clear`
- `GET /api/events` for SSE

Use SSE for small live notifications such as new/updated call summaries and
health changes. Use normal paginated/detail endpoints for content.

Do not enable broad CORS. V1 does not need a per-launch access token, auth
system, CSP/security-header hardening, or public web exposure.

`POST /api/clear` should:

- Take an ingestion lock.
- Stop ingestion briefly.
- Delete captured call data and pending spool files.
- Reset relevant capture counters.
- Store a clear baseline timestamp/generation.
- Resume ingestion.
- Keep schema/migration metadata.

## Persistence And Retention

SQLite is the source of truth. Spool files are transient and sensitive.

Retention runs inside the TypeScript service only:

- Run on startup and periodically while the service is running.
- Enforce age and size caps.
- Delete oldest `provider_call` rows first.
- Cascade delete related normalized blocks, stream events, and raw payloads.
- Enforce spool cleanup after successful ingestion.

No separate systemd retention timer.

If the TypeScript service is stopped, the Python shim can only fill the bounded
spool, then it must stop writing.

## Provider And Harness Layers

Keep two independent extension layers:

- Provider adapters answer "what happened on the wire?"
- Harness analyzers answer "what does this mean for Pi/Codex/Claude Code/etc?"

V1 provider:

- Amazon Bedrock only.
- Decode Bedrock Runtime request/response shapes.
- Decode AWS event-stream frames in TypeScript.
- Extract provider-reported usage, status, metrics, stop reasons, text,
  thinking/reasoning, tool deltas, and cache markers.

V1 harness:

- Pi.dev only.
- Use empirical fixtures to classify obvious Pi-added context and provenance.
- Fall back to generic Bedrock roles and `unknown` when unsure.

Do not introduce LiteLLM or any translation proxy. The point of spy is to
observe real harness/provider behavior, not normalize traffic through another
provider abstraction.

## UI V1 Scope

V1 includes:

- Desktop-only browser UI.
- Live-from-now default timeline.
- Explicit historical time range loading.
- Search and filtering by time, provider/model, event type, and normalized text.
- Provider call summaries with status, duration, model, operation, and
  provider-reported usage totals.
- Request composition summary using exact structural measures:
  - section presence
  - message count
  - character/byte size by section
  - tool count and tool schema size
  - cache markers
  - media summaries
  - provider-reported total input/output/cache usage when available
- Clear visual distinction between short current user input and large repeated
  system/tool/history context.
- Repeated/new/changed cues based on block content hashes compared to the
  previous comparable request.
- Cache markers clearly visible in timeline summaries and inspector details.
- Call-native right inspector.
- Diff against previous comparable request.
- On-demand stream event section.
- Network metadata and headers.
- Raw payload panels only when raw storage is enabled; otherwise show that raw
  storage was disabled.
- Health/settings area showing enabled state, DB size, spool size, caps,
  retention days, dropped capture count, last ingest time, and service version.
- Manual "clear spy data" action with confirmation.

V1 excludes:

- Automated compaction detection.
- Highlighted text token counting.
- Local token estimates.
- Exact provider token-count calls.
- Broad charts/dashboards.
- Mobile support.
- Keyboard shortcut requirements.
- Annotations/bookmarks/labels.
- Import/export.
- Multi-instance aggregation.
- Multi-conversation grouping.
- Public access/auth hardening.

## Roadmap

### Completed

- Captured sanitized real Pi/Bedrock traffic from the existing running
  `default` instance using Pi provider `amazon-bedrock` and model
  `us.anthropic.claude-sonnet-4-6`.
- Added `src/spy/fixtures/bedrock-pi-us-sonnet-4-6.ndjson` with real
  request/response pairs for simple streaming, two-turn history, cache markers,
  toolUse, toolResult, and provider-reported usage.
- Added initial `src/spy` TypeScript contract:
  - Zod spool event, provider call, normalized block, usage, stream event, raw
    payload, and diff schemas.
  - AWS event-stream decoder with CRC validation.
  - V1 SQLite migration helper and initial schema.
  - Fixture validation, event-stream decoding, and migration tests.
- Verified `bun run typecheck`, `bun run lint`, `bun run test`, direct
  `bun:sqlite` migration execution, and a fixture credential audit.
- Replaced the mitmproxy-facing Python capture path with a minimal Bedrock
  spool shim:
  - Reads `/etc/agent-vm/spy.env` and captures only when
    `ROOTCELL_SPY_ENABLED=true`.
  - Provider-gates Bedrock Runtime request, response, and error events.
  - Redacts auth headers and credential query parameters before spooling.
  - Writes one atomic schema-shaped JSON file per event under
    `/var/spool/rootcell-spy`.
  - Enforces `ROOTCELL_SPY_SPOOL_MAX_BYTES` and emits rate-limited dropped
    markers when the spool is full.
  - Stores AWS event-stream responses as base64 with
    `body_encoding=aws-eventstream` for TypeScript decoding.
  - Added firewall group/tmpfiles/systemd sandbox permissions so mitmproxy can
    write the sensitive spool path.
  - Added Python unit coverage for disabled/default behavior, config parsing,
    Bedrock detection, redaction, event-stream response encoding, provider-gated
    errors, spool cap behavior, dropped markers, and failure swallowing.
- Implemented the TypeScript Bedrock adapter on top of the captured fixtures:
  - Added `src/spy/bedrock.ts` with `normalizeBedrockCall` and
    `normalizeBedrockSpoolEvents` entrypoints.
  - Normalizes paired Bedrock request/response spool events into provider
    calls, semantic request/response blocks, provider-reported usage records,
    decoded stream events, and opt-in raw payload records.
  - Supports the captured Bedrock Converse Stream request shape, AWS
    event-stream response decoding, response text reconstruction, tool use
    reconstruction, usage extraction, stable IDs, stable content hashes, and
    conservative Pi/Bedrock provenance classification.
  - Added fixture-backed unit coverage for all five real Pi/Bedrock
    request/response pairs, request block classification, response tool/text
    extraction, usage extraction, stream events, raw payload gating, and hash
    stability.
  - Verified `bun run typecheck`, `bun run lint`, and `bun run test`.
- Implemented SQLite persistence, retention, and clear-data for spy capture:
  - Added `src/spy/store.ts` with `openSpyStore`, spool batch ingestion,
    request persistence, response completion, retention, clear-data, health
    snapshots, and close lifecycle.
  - Added request-only and response-only Bedrock normalization entrypoints while
    preserving the paired fixture normalizer.
  - Added typed HTTP event records and a schema v2 migration with
    `normalized_block_fts` synchronization triggers.
  - Persists pending and completed provider calls, HTTP metadata, normalized
    blocks, usage records, stream events, optional raw payloads, dropped/error
    counters, and service metadata.
  - Defers unmatched response spool files, deletes malformed spool files after
    recording counters/metadata, and deletes valid spool files only after
    successful commit.
  - Converted `src/spy` tests to Bun's native test runner so `bun:sqlite` runs
    directly, with the remaining unit tests still running under Vitest.
  - Added fixture-backed store coverage for ingestion, pending-to-complete
    updates, idempotency, raw payload gating, malformed/drop/error events,
    retention with FTS cleanup, and clear-data.
  - Verified `bun run typecheck`, `bun run lint`, and `bun run test`.
- Implemented the TypeScript spy web service, API, SSE, and static asset
  serving:
  - Added `src/spy/service.ts` and `src/bin/spy-service.ts` for the Bun HTTP
    service runtime.
  - Added environment-backed service config with V1 defaults for bind address,
    port, SQLite path, spool path, retention, size caps, raw payload storage,
    ingestion cadence, and retention cadence.
  - Extended `src/spy/store.ts` with read-side APIs for paginated call
    summaries, call details, stream event pages, FTS search, and previous-call
    request diffs.
  - Implemented same-origin JSON endpoints for health, call list/detail, diff,
    stream events, search, and confirmed clear-data.
  - Implemented SSE notifications for initial connection, health changes, call
    changes, clear-data events, and keepalive comments.
  - Added static asset serving with index fallback for browser routes and path
    traversal rejection.
  - Added fixture-backed Bun coverage for API behavior, pagination, raw payload
    gating, clear-data confirmation, SSE updates, static serving, and bad input
    handling.
  - Verified `bun run typecheck`, `bun run lint`, and `bun run test`.
- Implemented the React desktop spy UI with virtualized timeline and call
  inspector:
  - Added a Vite + React + TypeScript app under `src/spy/ui` with Tailwind,
    local shadcn-style primitives, lucide icons, and TanStack virtualization.
  - Added UI package scripts for dev, build, unit tests, and Playwright e2e
    tests, plus TSX-aware lint/typecheck wiring and locked frontend
    dependencies.
  - Built the live-from-now conversation-analysis screen with explicit
    historical range controls, search, status/model/block-kind filters,
    virtualized provider-call timeline rows, SSE refresh, and call selection.
  - Built the call-native inspector with request/response block rendering,
    semantic highlighting, composition summaries, provider usage, request diff,
    network metadata and headers, on-demand stream event loading, raw payload
    availability, health/settings data, and confirmed clear-data.
  - Added a fixture-backed UI test server and Playwright coverage for app load,
    SSE live updates, call selection, inspector sections, historical loading,
    search, stream events on demand, and clear-data confirmation.
  - Reduced the service SSE keepalive interval so long-lived browser event
    streams stay open under Bun's default idle timeout.
  - Verified `bun run typecheck`, `bun run lint`, `bun run test`,
    `bun run test:spy-ui:unit`, `bun run build:spy-ui`, and
    `bun run test:spy-ui:e2e`.
- Wired browser spy provisioning and launcher:
  - Added host build scripts for the bundled Bun spy service and static React UI
    artifacts.
  - Added the firewall `rootcell-spy.service`, persistent store/spool
    directories, generated `/etc/agent-vm/spy.env`, and provision-time
    enable/start or disable/stop behavior.
  - Added a systemd generator so the firewall service is wanted only when the
    generated spy env enables it, while the Nix unit remains installed in every
    firewall VM.
  - Replaced the old `rootcell spy` terminal/TUI launcher with a browser
    launcher using an SSH local port forward and `--no-open`.
  - Removed the old user-facing `rootcell spy --tui`, `--raw`, and
    `--no-dedupe` CLI options from argument parsing.
  - Added provider/transport local port forwarding support shared by Lima and
    AWS EC2.
  - Verified `bun run typecheck`, `bun run lint`, `bun run build:spy`,
    `bun run test`, and targeted firewall Nix service evaluation.
  - Ran live provider integration against the already provisioned `default`
    Lima VMs: enabled spy provisioning, confirmed firewall service health,
    verified host-local tunnel fallback to port 6175, checked agent traffic
    still routes through the firewall allowlist, closed the tunnel, and restored
    the instance to `ROOTCELL_SPY_ENABLED=false`.
- Raised firewall disk/root volume defaults to 64 GiB and verified provider
  contracts:
  - Updated Lima firewall sizing to emit `disk: "64GiB"` while preserving the
    agent `60GiB` disk default and existing CPU/RAM defaults.
  - Updated the AWS EC2 firewall root EBS default to 64 GiB while preserving the
    agent 60 GiB default and explicit root-volume environment overrides.
  - Updated provider docs to describe the Lima and AWS firewall/agent disk
    defaults and AWS override environment variables.
  - Added unit coverage for AWS default Terraform variables, AWS override
    behavior, Lima YAML disk rendering, provider docs, and the spy CLI flag
    removal regression where `spy --tui --help` must still fail.
  - Rebased onto `origin/main`, retained the merged Lima control-path restart
    fix, and raised generated ProxyJump SSH `ConnectTimeout` to 15 seconds after
    repeated integration failures showed Lima's vsock-backed SSH endpoint could
    accept a connection but miss the previous 5 second banner deadline.
  - Verified `bun run typecheck`, `bun run lint`, `bun run test`,
    `bun run test:integration`, and `bun run test:integration:clean`.
  - Confirmed fresh Lima integration VM sizing with `limactl list`:
    `firewall-test` uses `64GiB` and `agent-test` remains `60GiB`.
- Removed the old terminal/TUI spy implementation:
  - Trimmed `proxy/agent_spy.py` to the mitmproxy-facing Bedrock spool shim.
  - Deleted the Textual TUI module, terminal tail workflow, and Python tests for
    that legacy path.
  - Stopped provisioning `agent_spy_tui.py` and the legacy
    `/run/agent-vm-spy` NDJSON directory.
  - Updated host provisioning and integration assertions so `agent_spy.py` is
    treated as a shipped shim, not an executable terminal tool.
  - Updated main/proxy docs so `./rootcell spy` is only the browser launcher
    over the SSH tunnel, with `--no-open` as the supported non-default flag.
  - Added regression coverage that rejects the removed `--tui`, `--raw`, and
    `--no-dedupe` paths and checks the firewall module no longer references the
    removed TUI shim or runtime directory.
  - Verified `python3 -m compileall proxy`, Python unit discovery,
    `bun run typecheck`, `bun run lint`, `bun run test`, cleanup `rg` checks,
    and the full `bun run test:integration` suite.
- Documented the browser spy:
  - Added `src/spy/README.md` covering enablement, launch flow, data locations,
    retention settings, clear-data behavior, privacy/security implications,
    troubleshooting, API shape, provider/harness organization, and build/test
    commands.
  - Added brief links from the main README and proxy README.
  - Verified `git diff --check`, stale legacy spy wording checks, and
    `bun run lint`.
- Added runtime validation for browser API and SSE payloads:
  - Added `src/spy/api-contracts.ts` as a browser-safe shared Zod contract
    module for health, call pages, details, diffs, stream-event pages,
    clear-data results, and SSE event payloads.
  - Rewired the React UI types and API client to infer from shared schemas and
    parse every successful JSON response instead of trusting generic
    `fetchJson<T>()` casts.
  - Replaced unchecked browser SSE parsing with named event payload validation
    for `hello`, `health`, `calls-changed`, and `cleared`, surfacing malformed
    event data as a concise UI error.
  - Updated service tests to validate real endpoint and SSE output through the
    shared contracts, and added UI API tests for invalid response payloads and
    malformed SSE payloads.
  - Verified `bun run typecheck`, `bun run lint`, `bun run test` with localhost
    bind permission, `bun run test:spy-ui:unit`, and `git diff --check`.
- Completed the V1 request composition summary:
  - Added shared `SpyRequestComposition` API contracts and included
    `requestComposition` in `GET /api/calls/:id` detail responses.
  - Computes request-only structural measures from persisted normalized blocks
    and provider usage in TypeScript: total blocks/messages/chars/bytes,
    per-section presence/counts/sizes, tool schema size, cache marker summary,
    media summary, and provider-reported usage.
  - Replaced the old mixed request/response block summary with a request-native
    browser panel while keeping request and response block lists unchanged.
  - Added fixture-backed store/service/UI/e2e coverage for simple prompts,
    history, toolUse/toolResult, cache markers, raw-disabled, and raw-enabled
    cases.
  - Verified `bun run typecheck`, `bun run lint`, `bun run build:spy`,
    `bun test src/spy --timeout 10000`, `bun run test`,
    `bun run test:spy-ui:unit`, and `bun run test:spy-ui:e2e` with localhost
    bind/browser permissions where required.
- Completed the V1 health/settings surface:
  - Added explicit `service.enabled`, `store.droppedCaptureCount`, and
    `store.lastIngestAt` fields to `/api/health` and SSE health payloads.
  - Kept diagnostic counters and metadata available while moving required UI
    state off metadata inference and onto typed API fields.
  - Updated the browser health panel to show enabled state, DB size, spool size,
    store/spool caps, retention days, dropped capture count, and last ingest
    time without adding service/API versioning.
  - Added store, service, shared-contract, UI API, and Playwright coverage for
    the required health fields.
  - Verified `bun run typecheck`, `bun run lint`, `bun run build:spy`,
    `bun test src/spy --timeout 10000`, `bun run test:spy-ui:unit`, and
    `bun run test:spy-ui:e2e` with localhost bind/browser permissions where
    required.
- Completed V1 timeline filtering:
  - Locked the V1 event-type definition to provider-call operation
    (`provider_call.operation`), leaving stream event types as inspector detail.
  - Extended `/api/calls` and `/api/search` to apply time, provider, model,
    operation, status, and normalized-text filters before pagination.
  - Updated the browser timeline controls to send provider/model/operation/status
    filters to the API instead of post-filtering paged results locally.
  - Added store, service, UI API, and Playwright coverage for filtered calls,
    filtered search, invalid provider/status query values, and search constrained
    by the active operation filter.
  - Verified `bun run typecheck`, `bun run lint`, `bun run build:spy`,
    `bun run test`, `bun run test:spy-ui:unit`, `bun run test:spy-ui:e2e`, and
    `git diff --check` with localhost bind/browser permissions where required.
- Completed V1 completion validation on 2026-05-23:
  - Ran the full V1 baseline: `bun run typecheck`, `bun run lint`,
    `python3 -m unittest discover -s proxy -p 'test_*.py'`,
    `bun run build:spy`, `bun run test`, `bun run test:spy-ui:unit`,
    `bun run test:spy-ui:e2e`, `bun run test:integration`, and
    `bun run test:integration:clean`.
  - Localhost-bound tests required the normal localhost/browser permissions; no
    product, packaging, or test defects were found in the baseline.
  - Ran the live smoke against the `default` Lima instance: enabled spy,
    provisioned, launched `./rootcell spy --no-open`, verified `/api/health`,
    captured real Pi/Bedrock `converse-stream` calls, inspected API detail,
    diff, stream events, browser timeline/detail, and health, then cleared
    data.
  - Fixed one live-smoke UI defect where a selected pending call detail could
    remain stale after SSE updated the call summary to complete. The browser now
    refetches selected detail when the selected summary status/content changes.
  - Rebuilt and reprovisioned the patched spy UI, then confirmed the browser
    inspector updated without reselecting the row and showed completed duration,
    usage, request composition, repeated/changed diff labels, response blocks,
    and health data.
  - Restored `ROOTCELL_SPY_ENABLED=false`, reprovisioned, confirmed
    `./rootcell spy --no-open` refuses to launch while disabled, the
    `rootcell-spy.service` is inactive, the SQLite store is preserved, the spool
    is empty, and a disabled-state Pi/Bedrock call writes no spool files.

### V1

Build the Bedrock/Pi browser spy:

- [x] Define spool event schema, normalized provider schema, and SQLite schema.
- [x] Capture sanitized real Pi/Bedrock fixtures to ground the schema and
  adapter work.
- [x] Add initial AWS event-stream decoder.
- [x] Replace Python spy with minimal provider-gated spool shim.
- [x] Implement TypeScript Bedrock adapter on top of the captured fixtures.
- [x] Implement SQLite persistence, migrations, retention, and clear-data.
- [x] Implement TS web service, API, SSE, and static asset serving.
- [x] Implement React desktop UI with virtualized timeline and call inspector.
- [x] Wire `rootcell provision`, systemd service config, and `rootcell spy`
   launcher/tunnel.
- [x] Remove old user-facing `rootcell spy --tui`, `--raw`, and `--no-dedupe`
  CLI flags.
- [x] Raise firewall disk/root volume defaults to 64 GiB.
- [x] Remove old TUI/terminal spy implementation files, tests, and docs.
- [x] Add `src/spy/README.md` and brief links from main/proxy docs.
- [x] Complete the final V1 acceptance pass against the `default` Lima instance.
  - Ran the full baseline, live spy smoke, clear-data check, disabled-state
    capture check, and restored `ROOTCELL_SPY_ENABLED=false`.
  - Fixed the selected-call detail refresh defect found during the live smoke.

### V1 Review Findings

Review date: 2026-05-23.

The implementation history above is complete, and the V1-specific validation
commands pass when local listener permissions are available. All V1 review
findings are complete:

- [x] Add runtime validation for browser API and SSE payloads.
  - Added shared Zod schemas for health, call pages, details, diffs,
    stream-event pages, clear-data results, and SSE event payloads.
  - Replaced unchecked client parsing such as generic `fetchJson<T>()` casts and
    `JSON.parse(event.data) as SpyServiceHealth` with schema-backed parsing.
  - Kept browser-facing parsed values typed from the shared schema module
    instead of importing server-only store/service types into the UI.
  - Added UI/API unit coverage for invalid response payloads and malformed SSE
    payloads, plus service coverage that parses real API/SSE output through the
    shared contracts.
- [x] Complete the health/settings surface required by V1.
  - Added explicit `service.enabled`, `store.droppedCaptureCount`, and
    `store.lastIngestAt` fields to `/api/health` and SSE health payloads.
  - Kept counters and metadata for diagnostics while making the UI use explicit
    health fields instead of inferring V1 status from partial metadata.
  - Updated the browser health panel to show enabled state, DB size, spool size,
    store/spool caps, retention days, dropped capture count, and last ingest
    time.
  - Added store, service, UI API, and Playwright coverage that fails when
    required health fields are absent.
- [x] Complete V1 timeline filtering.
  - V1 requires filtering by time, provider/model, event type, and normalized
    text.
  - V1 event type means the provider-call operation stored as
    `provider_call.operation`; stream event types remain inspector detail, not
    timeline filters.
  - `/api/calls` and `/api/search` apply time, provider, model, operation,
    status, and normalized-text filters consistently before pagination.
  - The browser timeline exposes provider, operation, status, model, time range,
    and normalized-text filters without client-side post-filtering of paged
    results.
- [x] Expand the request composition summary to the exact V1 structural
  measures.
  - Added shared request composition Zod schemas and types, then exposed
    `requestComposition` on call detail responses.
  - Computes the exact V1 request measures from normalized blocks and usage in
    the TypeScript store instead of deriving them ad hoc in React.
  - The UI now shows a request-only composition panel with section presence,
    message count, character/byte size by section, tool schema size, cache
    marker summary, media summary, and provider-reported usage.
  - Added fixture-backed tests for simple prompts, history, toolUse/toolResult,
    cache markers, raw-disabled, raw-enabled, API contract validation, and the
    browser composition surface.

### V1 Manual Browser QA Findings

QA date: 2026-05-23.

Manual test context:

- Re-enabled spy on the `default` Lima instance, launched `./rootcell spy
  --no-open`, and inspected the browser UI through the local SSH tunnel.
- Captured a longer Pi.dev session using Amazon Bedrock model
  `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
- Added a temporary large cache-anchor system prompt to force provider cache
  accounting, then verified calls with cache write and cache read values in the
  API and browser inspector.
- Observed 17 real Bedrock `converse-stream` calls, including a call with
  provider usage `input 10`, `output 32`, `cache read 10175`, and `cache write
  29`, and a later long call with `input 10`, `output 2641`, `cache write
  4570`, `total 7221`, 515 stream events, and 35 request blocks. The latest
  live retry call showed `input 10`, `output 262`, `cache write 7195`, `total
  7467`, 72 stream events, and 38 request blocks.
- Created additional live Pi/Bedrock turns while the browser was open and
  verified the timeline count and health values updated without refresh. A long
  call visibly transitioned from pending with `output 0 B`, `usage n/a`, and
  `duration pending` to complete with `output 7.5 KiB`, `usage 7.2k tok`, and
  `duration 13 s`.
- Cross-checked the browser against `/api/health` and `/api/calls`; the API
  reported 17 calls, 0 pending calls, 0 dropped captures, 0 B spool, 1.9 MiB
  DB size, and the same cache-heavy usage values shown in the inspector.
- Continued the QA loop after 05:30 PM with a fresh Live spy URL. By 05:40 PM
  `/api/health` reported 22 provider calls, 0 pending calls, 0 dropped captures,
  0 B spool, and 2.7 MiB DB size. The newest Pi/Bedrock call showed provider
  usage `input 10`, `output 104`, `cache read 5123`, `cache write 77`, `total
  5314`, 36 stream events, and 23 request blocks.
- While `Today` was selected, a new 05:40:59 PM Pi/Bedrock call appeared live
  without refresh, taking the visible Today count to 23 calls. The API reported
  `input 10`, `output 98`, `cache read 5200`, `cache write 81`, `total 5389`,
  29 stream events, and 26 request blocks.
- A later 05:45:03 PM health-live Pi/Bedrock call took the visible Today count
  to 24 calls. The API reported `input 10`, `output 105`, `cache read 5281`,
  `cache write 79`, `total 5475`, 30 stream events, and 29 request blocks.

Checks that passed:

- The cache-heavy call's Usage Records panel showed `input 10`, `output 32`,
  `cache read 10175`, `cache write 29`, and `total 10246`.
- The latest long cache-write call's Usage Records panel showed `input 10`,
  `output 2641`, `cache read 0`, `cache write 4570`, and `total 7221`.
- The latest live retry call's API and timeline values matched at `input 27 KiB`,
  `output 2.6 KiB`, `usage 7.5k tok`, `duration 2.5 s`, and Usage Records
  showed `input 10`, `output 262`, `cache read 0`, `cache write 7195`, and
  `total 7467`.
- Health updated after the live call and matched the API: Enabled, DB size
  1.9 MiB, spool 0 B, dropped captures 0, last ingest May 23 05:14:10 PM,
  Calls 17, Pending 0, Schema 2.
- The 05:37:36 PM cache-read/write call matched between API and UI after
  selection: the row showed `input 17 KiB`, `output 1.3 KiB`, `usage 5.3k tok`,
  `duration 1.6 s`, and the inspector showed `in 10 · out 104 · cache
  5,123/77`.
- The Today range updated in place when the 05:40:59 PM call completed, and the
  row showed the expected `input 18 KiB`, `output 1.2 KiB`, `usage 5.4k tok`,
  `duration 1.4 s`; selecting it showed `in 10 · out 98 · cache 5,200/81`.
- The 05:45:03 PM call also appeared live in Today, and the row/API/inspector
  agreed at `input 19 KiB`, `output 1.2 KiB`, `usage 5.5k tok`, `duration 1.4 s`,
  and `in 10 · out 105 · cache 5,281/79`.
- Browser console logs stayed empty after the post-5:30 live-update, search,
  filtering, and inspector-selection checks.
- Pending provider calls render live in the timeline and update in place after
  completion; the latest long turn matched the API values after completion.
- No-result search and no-result status filtering clear the old inspector detail
  and show an explicit empty inspector state.
- Raw payloads correctly report that raw storage is disabled or no raw payloads
  are stored.

Prioritized fix handoff:

Priority scale: P0 blocks ordinary UI use or hides core data; P1 is high-impact
workflow correctness/usability; P2 is important clarity or inspection quality;
P3 is polish, minor copy, or secondary accessibility.

- [x] [P0] SPY-QA-01: Rework the two-column page layout so the timeline and
  inspector own their scroll containers instead of letting `main` hide overflow.
  Today/long-call views can put rows, footer controls, and lower inspector panels
  thousands of pixels below the visible viewport.
  - Fixed on 2026-05-23: changed the spy UI shell to a fixed header plus
    shrinkable body grid, added `min-h-0` to the timeline and inspector scroll
    owners, and covered the clipping regression in Playwright.
- [x] [P0] SPY-QA-02: Fix hidden top-level scrolling. Focus/opening lower
  inspector panels can set `main.scrollTop` despite `overflow-hidden`, pushing
  the global header and range controls offscreen with no visible page scrollbar.
  - Closed on 2026-05-24 as stale/no-repro in the current tree after a
    dedicated RCA in `docs/bugfix/SPY-QA-02-RCA.md`: lower inspector navigation
    and stream-event loading kept `main.scrollTop=0`, `main` had no hidden
    scroll range, and the existing Playwright guard for buried inspector
    navigation passed.
- [x] [P0] SPY-QA-03: Fix timeline row and footer overlap. Rows in the short
  10-minute view overlap each other by about 12 px, hit-testing can return two
  row buttons at one point, and the call-count/Load More footer can cover row
  content.
  - Fixed on 2026-05-23: timeline rows now use actual virtualizer measurement
    instead of a too-small fixed estimate, and the footer sits outside the
    timeline scroll viewport so it cannot overlay row content. Added Playwright
    coverage for adjacent row overlap and footer coverage at max scroll.
- [x] [P0] SPY-QA-04: Make long inspectors navigable. The inspector often
  measures taller than the visible viewport, Request/Response Blocks open by
  default for huge calls, and Usage Records/Network/Stream/Raw/Health become
  effectively buried.
  - Fixed on 2026-05-23: added a sticky inspector section navigator, made
    high-volume Request/Response block sections start collapsed, and covered
    the navigation regression in Playwright.
- [x] [P1] SPY-QA-05: Virtualize or paginate Stream Events and reset stale loaded
  stream state on call/range changes. Loading 72-765 events renders hundreds or
  thousands of inline lines and can leave the operator stranded in an old deep
  scroll position.
  - Fixed on 2026-05-23: stream events now render through a bounded 25-event
    window with collapsed payload previews, and loaded stream state is cleared
    when selecting a new call or changing timeline context. Added Playwright
    coverage with a synthetic 250-event stream response.
- [x] [P1] SPY-QA-06: Reset inspector scroll and panel state when selecting a new
  call, or expose an explicit reset affordance. Selecting a different call after
  deep stream inspection can keep `scrollTop` thousands of pixels down.
  - Fixed on 2026-05-23: re-clicking the already-selected timeline row now
    clears loaded stream state, remounts inspector sections so lower panels
    close, and scrolls the inspector to the top. Added Playwright coverage for
    the deep stream-inspection reset path.
- [x] [P1] SPY-QA-07: Clarify selected-call pinning while live calls arrive.
  New rows appear above the selected row, but the inspector stays on the older
  call without an explicit pinned/auto-follow state.
  - Fixed on 2026-05-23: the inspector now shows a `Pinned` badge and `Follow
    Latest` button when the selected call is older than the newest visible
    timeline row, while preserving pinned inspection by default.
- [x] [P1] SPY-QA-08: Keep URL/query state in sync with selected time range and
  distinguish fixed `since` URLs from true Live mode. Reloading old `since` URLs
  can show historical data while the header still says `Live from now`.
  - Fixed on 2026-05-23: the browser now parses URL range state as a coherent
    `preset`/`since` pair, treats fixed `since` URLs as non-live unless
    `preset=live` is explicit, and writes canonical range query state when the
    operator changes Live, 10 min, 1 hour, Today, or Custom. Added unit and
    Playwright coverage for fixed `since` URLs, range changes, and reloads.
- [x] [P1] SPY-QA-09: Decide whether `10 min` and `1 hour` are rolling windows or
  fixed snapshots, then label/update them consistently. Refresh currently keeps
  the original fixed start.
  - Fixed on 2026-05-23: `10 min` and `1 hour` now act as rolling windows on
    refresh and SSE reloads, dynamic preset URLs no longer persist stale
    `since` timestamps, and Playwright coverage verifies the refreshed API query
    start advances.
- [x] [P1] SPY-QA-10: Keep service Health reachable independently of selected
  calls. Empty search/filter results clear the inspector and remove access to
  health even though `/api/health` is still valid.
  - Fixed on 2026-05-23: the no-call inspector state now renders service Health
    independently of selected call detail and hides the call-section navigator
    when no selected-call sections exist. Added Playwright coverage for an empty
    Pending filter result.
- [x] [P1] SPY-QA-11: Improve empty-state copy for active filters/search. A
  Pending filter in Today with 23 completed calls says "No provider calls in this
  range" instead of explaining that filters excluded the calls.
  - Fixed on 2026-05-24: timeline empty states now distinguish unconstrained
    range emptiness from active search/provider/model/operation/status query
    constraints. Filtered or searched empty results say no calls match the
    current search or filters, while true range-empty states such as clear-data
    keep the range-only copy. Added Playwright coverage for filtered empty
    states and preserved clear-data coverage for the range-empty copy.
- [x] [P1] SPY-QA-12: Add a single clear/reset control for search and filters.
  Recovering the full list currently requires clearing text, resetting multiple
  selects, and submitting again.
  - Closed on 2026-05-24 as a product enhancement, not a current bug. The
    existing controls can recover the full list; a future reset affordance
    should be tracked outside the bug backlog if needed.
- [x] [P1] SPY-QA-13: Make search results explain why they matched. Rows need
  snippets/highlights; exact-looking hyphenated marker searches currently behave
  like broad token matches and can return surprising older calls.
  - Closed on 2026-05-24 as a product enhancement, not a current bug. Search is
    functioning as normalized FTS token search; snippets/highlights would be an
    explanatory feature.
- [x] [P1] SPY-QA-14: Clarify search scope and include or explicitly exclude call
  ids/model ids/metadata. Visible call-id fragments return no results while the
  placeholder only says `Search text`.
  - Fixed on 2026-05-24: `/api/search` now matches normalized block text plus
    visible provider-call metadata including call ids, flow ids, model ids,
    provider, operation, and status. The UI search label now names the expanded
    scope, and store/service/Playwright coverage proves call-id, model-fragment,
    and normalized-text searches.
- [x] [P1] SPY-QA-15: Submit search on Enter. The input updates but results do not
  change until the Search button is clicked.
  - Closed on 2026-05-24 as stale/no-repro in the current tree. The search input
    is inside a form with `onSubmit`, and Enter submits the search.
- [x] [P1] SPY-QA-16: Group related provider calls into Pi turns/sessions or show
  prompt snippets. Tool-use cycles appear as adjacent unrelated Haiku rows.
  - Closed on 2026-05-24 as a product enhancement, not a current bug. Turn or
    session grouping belongs in a future UX scope if needed.
- [x] [P1] SPY-QA-17: Make diff baseline scope explicit. Live/ranged views can
  diff against a prior request outside the visible range without saying so.
  - Fixed on 2026-05-24: the browser Diff section now labels the previous
    request as a global baseline across stored comparable calls, and shows an
    `outside current range` or `outside current Live window` badge when the
    baseline is older than the active timeline range. Added Playwright coverage
    for a visible ranged call whose diff baseline is outside that range.
- [x] [P1] SPY-QA-18: Surface cache read/write in the timeline summary and rename
  or clarify the `cache 2` marker badge. Cache-read and cache-write calls look
  nearly identical from the row alone.
  - Fixed on 2026-05-24: timeline rows now show provider `read`, `write`,
    `cache read`, and `cache write` token values separately, remove the
    ambiguous request cache-marker count badge, and move byte sizes/duration
    into the row metadata line. Added Playwright coverage for a cache-heavy
    call proving the row no longer shows total `tok` usage or `cache 2`.
- [x] [P1] SPY-QA-19: Fix Bedrock reasoning classification. Prior-history
  `reasoningContent` and signature-only reasoning chunks show as `Unknown`
  instead of thinking/reasoning metadata.
  - Fixed on 2026-05-24: the Bedrock adapter now classifies request
    `reasoningContent` and response reasoning deltas as `thinking`, including
    nested `reasoningText.text` and signature-only reasoning metadata. Added
    adapter coverage for prior-history reasoning, nested response reasoning
    text, and signature-only response reasoning chunks.
- [x] [P1] SPY-QA-20: Fix pending-row formatting. Pending rows can render
  `usage usage n/a`.
  - Closed on 2026-05-24 as stale/no-repro in the current tree. The RCA in
    `docs/bugfix/SPY-QA-21-RCA.md` proves a mocked pending row with null usage
    renders explicit `read`, `write`, `cache read`, and `cache write` metrics
    with `-` values and no `usage` text.
- [x] [P1] SPY-QA-21: Fix modal focus management for Clear spy data. Focus stays
  on the background icon button, the background is not effectively inert, and
  Escape did not close the dialog during QA.
  - Fixed on 2026-05-24: the Clear Spy Data dialog now renders outside the
    inert app shell, focuses Cancel on open, traps Tab/Shift+Tab inside the
    dialog, closes on Escape, and restores focus to the header trigger. Added
    Playwright coverage for the modal focus loop and Escape close path.
- [x] [P2] SPY-QA-22: Make request composition responsive. Provider usage and
  cache read/write suffixes truncate, and the section table clips horizontally
  at the normal in-app browser width.
  - Fixed on 2026-05-24: Request Composition metrics now use responsive
    two/four-column layout with wrapping detail text, and the section table uses
    narrower fitting tracks instead of hidden horizontal clipping. Added
    Playwright coverage at 1100 px proving Provider usage and section-table
    content fit without hidden overflow.
- [x] [P2] SPY-QA-23: Move or scope the block-kind filter. It lives under Request
  Blocks, affects request and response blocks, persists across call selection,
  and can make Response Blocks look empty.
  - Fixed on 2026-05-24: moved the block-kind filter to an inspector-level
    toolbar above both Request Blocks and Response Blocks, labeled its
    request/response scope, and changed filtered-empty block lists to explain
    that the selected kind has no blocks in that section. Added Playwright
    coverage for the shared filter scope and call-selection persistence.
- [x] [P2] SPY-QA-24: Improve custom-range state. `Apply` stays green while all
  range pills are inactive, lacks ARIA state, and minute precision rounded a
  prior `since` down to `:00`.
  - Fixed on 2026-05-24: Custom is now an explicit active range segment with
    `aria-pressed` state, `Apply` is styled as a command instead of selected
    state, and no-op applies preserve second-level `since` values. Added
    Playwright coverage for active custom state, ARIA state, no-op precision
    preservation, and intentional changed-minute commits.
- [x] [P2] SPY-QA-25: Expand or restyle the custom datetime input so the AM/PM
  and time controls are not cramped at the normal desktop width.
  - Fixed on 2026-05-24: widened the custom datetime input and added
    Playwright coverage at the original normal desktop QA viewport proving the
    control has measurable slack for the PM display.
- [x] [P2] SPY-QA-26: Reduce visual noise in stream-event JSON. Opaque Bedrock
  `p` fields dominate the event payload and look like rendering artifacts.
  - Closed on 2026-05-24 as a product enhancement, not a current bug. The field
    is real provider metadata; redaction/summarization should be tracked outside
    the bug backlog if desired.
- [x] [P2] SPY-QA-27: Improve Network Metadata readability. Paths truncate and
  URL-encoded model punctuation such as `%3A0` makes the request target harder
  to verify.
  - Fixed on 2026-05-24: Network Metadata now formats HTTP targets for display
    without changing the raw persisted path, decodes readable model punctuation
    such as `%3A0` to `:0`, splits path/query into wrapping detail rows, keeps
    the raw encoded target available, and wraps long header values. Added
    formatter unit coverage and Playwright coverage proving the decoded target
    is visible without hidden horizontal overflow at 1100 px.
- [x] [P2] SPY-QA-28: Show the full provider model id somewhere prominent. The
  normal row/header omit the `us.anthropic.` Bedrock namespace.
  - Fixed on 2026-05-24: the inspector Summary panel now shows a prominent
    wrapped `Model ID` field with the exact provider model id, while preserving
    compact row/header labels. Added Playwright coverage proving the row remains
    shortened but the selected-call summary exposes
    `us.anthropic.claude-sonnet-4-6`.
- [x] [P2] SPY-QA-29: Fix sticky inspector header overlap. Scrolled detail content
  can slide underneath the fixed title/status area and appear clipped.
  - Fixed on 2026-05-24: split the inspector into a non-scrolling header and a
    dedicated detail scroll body, updated section navigation/reset to target the
    body, and added Playwright coverage proving scrolled detail content is not
    present underneath the header hit-test area.
- [x] [P2] SPY-QA-30: Add ARIA state for selected timeline row and active range
  segment. Current active/selected states are visual only.
  - Fixed on 2026-05-24: confirmed range segments already exposed
    `aria-pressed`, added `aria-current` to the selected timeline row button,
    and added Playwright coverage proving row selection state moves between
    selected calls while active range state remains exposed.
- [x] [P2] SPY-QA-31: Improve timeline row accessible names. `aria-label` only
  exposes `Open call <id>` and hides visible model/status/time/usage context from
  assistive technology.
  - Fixed on 2026-05-24: timeline row accessible names now include the call id,
    model, status, start time, operation, provider usage classes, byte sizes,
    duration, and request/response block counts. Added Playwright coverage that
    locates rows by the richer accessible name and verifies model/cache-usage
    context is exposed.
- [x] [P2] SPY-QA-32: Make the disconnected SSE `Reconnect` badge either a real
  control or passive status text. It currently reads like a clickable action.
  - Fixed on 2026-05-24: disconnected SSE now renders as passive `SSE offline`
    status text with a status role instead of an action-like `Reconnect` label.
    Added Playwright coverage that forces `/api/events` offline and proves no
    `Reconnect` control is exposed.
- [x] [P2] SPY-QA-33: Reduce nested scroll traps in large JSON/detail panels.
  Stream events and other large detail payloads can catch wheel input and make it
  awkward to continue through the inspector.
  - Closed on 2026-05-24 as a product enhancement, not a proved current bug. The
    bounded detail panes are intentional; any alternate detail-pane interaction
    should be tracked outside the bug backlog.
- [x] [P3] SPY-QA-34: Fix singular/plural call count grammar (`1 calls`).
  - Fixed on 2026-05-24: added a shared count formatter for singular/plural UI
    labels and used it in the timeline footer so one visible provider call now
    renders `1 call` instead of `1 calls`. Added unit coverage for count labels
    and Playwright coverage for a one-call filtered timeline.
- [x] [P3] SPY-QA-35: Loosen timeline row chips/badges. Long token labels,
  token values, and timestamps can wrap or clip into awkward multi-line
  fragments.
  - Fixed on 2026-05-24: timeline usage now renders as one compact, fit-content
    metric pill with `down arrow` for read, `up arrow` for write, `R` for cache
    read, and `W` for cache write. Cache metrics are omitted when the provider
    does not report cache usage, while exact full meanings remain in titles,
    `aria-label`s, and the row accessible name. The timestamp is protected from
    wrapping, markers share the same size/line-height as token values, and
    Playwright coverage measures the cache-heavy row at 1100 px to ensure the
    usage pill does not stretch or clip.
- [x] [P3] SPY-QA-36: Prevent top inspector summary cards from truncating
  important values such as exact `Started` time.
  - Fixed on 2026-05-24: changed the inspector Summary metrics from a fixed
    four-column layout to a two-column layout at normal inspector widths, with
    four columns only at very wide desktop sizes. Metric values now wrap instead
    of using ellipsis truncation, and Playwright coverage proves the exact
    `Started` timestamp does not clip at the reproduced 1280 px viewport.

ID-keyed evidence notes:

These notes are retained only where they clarify an open bug ID. They are not
separate tasks.

- SPY-QA-22: Request composition has correct provider usage text in the DOM, but
  the visible cache read/write suffix can truncate at normal desktop width. The
  section table is also wider than its visible card without a responsive
  treatment.
- SPY-QA-25: The custom datetime input is cramped at the normal desktop browser
  width; the stored value is correct, but the AM/PM/time affordance is visually
  crowded.
- SPY-QA-29: The sticky inspector call header can visually cover scrolled detail
  content, leaving rows partially clipped at the top of the detail pane.
- SPY-QA-30: Selected timeline row lacked ARIA state while active time-range
  segments already exposed `aria-pressed`; fixed by exposing `aria-current` on
  the selected timeline row.
- SPY-QA-31: Timeline row accessible names now expose visible model, status,
  time, operation, usage, size, duration, and block-count context.
- SPY-QA-32: The disconnected SSE badge now renders passive `SSE offline`
  status text instead of the action-like `Reconnect` label.
- SPY-QA-34: The timeline count footer can display `1 calls`.
- SPY-QA-35: Timeline row usage now uses one compact fit-content metric pill,
  preserving full labels through `aria-label`/title text; cache metrics are
  omitted when absent, and timestamps are protected from wrapping.
- SPY-QA-36: Top inspector summary cards can truncate important values such as
  the exact `Started` timestamp.

Free-form notes removed from the active bug list:

- Search result snippets/highlights, combined reset controls, Pi turn/session
  grouping, stream-event JSON summarization, and alternate nested-detail
  scrolling are product enhancements rather than current bugs.
- Historical `since` URL labeling, URL/range sync, timeline clipping, row/footer
  overlap, stream-event over-rendering, deep inspector reset, hidden top-level
  scrolling, and long-call section navigation are stale duplicates of
  `SPY-QA-01` through `SPY-QA-10`, which are closed and covered by existing
  Playwright tests.

Keep the verification baseline for the follow-up fixes:

- `bun run typecheck`
- `bun run lint`
- `python3 -m unittest discover -s proxy -p 'test_*.py'`
- `bun run build:spy`
- `bun run test` (requires permission to bind localhost in this workspace)
- `bun run test:spy-ui:unit`
- `bun run test:spy-ui:e2e` (requires localhost/browser permissions)
- `bun run test:integration`
- `bun run test:integration:clean`

### V1.5

Add analysis depth:

- Exact/estimated token counting for highlighted text, blocks, sections, and
  whole requests.
- Provider-routed token-count backend; browser never calls LLM providers
  directly.
- Per-block token provenance: `provider_reported`, `provider_counted`,
  `estimated`, or `unavailable`.
- Automated compaction candidate detection:
  - Pi-specific request patterns from fixtures.
  - Generic fallback heuristics.
  - Labels that distinguish Pi-specific candidates from heuristic candidates.
- Dedicated compaction investigation view.
- Visual regression/screenshot checks.

### V2

Broaden scope:

- Direct Anthropic provider adapter.
- OpenAI provider adapter.
- Additional harness analyzers for Claude Code, Codex, Cursor, and others.
- Multiple simultaneous conversation grouping.
- Rich token/time/cache charts and dashboards.
- Export/archive workflows if real use shows demand.
- Stronger auth/security model only if any non-local exposure is introduced.

## Capacity Defaults

Completed firewall disk defaults:

- Lima firewall disk: 64 GiB.
- AWS firewall root volume: 64 GiB.
- Keep agent disk default unchanged.

Current CPU/RAM defaults remain unchanged. Existing instances are not migrated
or resized automatically.

Keep validating CPU/RAM with fixtures and live captures, then raise them only if
the service, SQLite ingestion, or UI serving needs more headroom. Disk is cheap;
do not optimize the service around artificially tiny capacity.

## Security And Privacy

This feature persists decrypted LLM prompts and responses.

Security model:

- Disabled by default.
- SSH tunnel only.
- No public web listener.
- Service binds firewall-local `127.0.0.1`.
- Header/query credential redaction is mandatory.
- No body secret redaction.
- Binary/media payloads summarized by default.
- Raw exact payload storage disabled by default.
- Spool is sensitive even when raw storage is disabled.
- Retention and manual clear are required.
- Capture failure must not affect agent traffic.
- EBS encryption / disk-at-rest posture should be reviewed for AWS, but v1 does
  not add a separate application-level encryption layer.

The docs must clearly state that if a prompt contains a secret, the spy store may
contain that secret until retention or manual clear removes it.

## Failure Modes

Define user-visible behavior and recovery for:

- Spy disabled.
- Service not provisioned or stale.
- SSH tunnel failure.
- TypeScript service down.
- SQLite locked/corrupt.
- Spool full.
- Store retention limit reached.
- Retention cleanup failure.
- Mitmproxy shim error.
- Bedrock adapter parse failure.
- SSE disconnect.
- Dropped capture events.

Hard invariant: spy failures must not block, slow significantly, or change
network traffic allow/deny decisions.

## Testing

V1 tests:

- Python shim unit tests:
  - enabled/disabled gating
  - Bedrock provider candidate detection
  - auth header/query redaction
  - spool cap behavior
  - no-write behavior when disabled/full
- TypeScript unit tests:
  - Zod schema validation
  - Bedrock request/response normalization
  - AWS event-stream decoding
  - usage/cache marker extraction
  - repeated/new/changed hash classification
  - Pi provenance classification from fixtures
- SQLite tests:
  - migrations
  - ingest idempotence/retry behavior
  - request/response pairing
  - retention by age and size
  - clear-data baseline
  - cascade deletes
- API tests:
  - health
  - pagination
  - detail loading
  - diff endpoint
  - stream events endpoint
  - search
  - clear
  - SSE notifications
- Playwright functional tests without screenshot baselines:
  - app loads in local fixture mode
  - receives SSE update
  - selects a call
  - opens inspector sections
  - loads historical range
  - searches
  - loads stream events on demand
  - clears data
- Integration tests:
  - full provider contract flow with Lima user-v2 VMs
  - clean provisioning cycle from deleted integration VMs and network state
  - rootcell-managed VM stop/start restart path
  - Lima control-path availability after VM restarts
  - host SSH to firewall and proxied agent aliases
  - firewall service and spy asset provisioning checks
  - DNS, HTTPS, request-regex, and SSH policy enforcement
  - CLI smoke test against a fresh named instance
  - Lima firewall disk default `64GiB` while agent remains `60GiB`
  - AWS Terraform variables render firewall root volume `64` by default
  - AWS root-volume environment overrides still win

Fixture strategy:

- Initial sanitized real Pi/Bedrock fixture capture is complete for
  `us.anthropic.claude-sonnet-4-6`.
- Add handcrafted minimal fixtures only as supplements for targeted edge cases.
- Add more sanitized real captures as the Bedrock adapter, shim, and UI expose
  concrete gaps.
- Cover normal calls, streaming, tool calls/results, cache markers, large
  history, error responses, disabled capture, raw disabled, and raw enabled.

Completed validation for the 64 GiB firewall default:

- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run test:integration`
- `bun run test:integration:clean`

## Documentation

The detailed operator/developer doc is `src/spy/README.md`.

It is briefly referenced from `README.md` and `proxy/README.md`.

The doc covers:

- Enabling spy in the instance `.env`.
- Running `./rootcell provision`.
- Launching `./rootcell spy`.
- Data locations.
- Retention settings.
- Disk sizing defaults.
- Privacy/security implications.
- Clear-data behavior.
- Service health and troubleshooting.
- Removed TUI/terminal flags.
- How provider and harness adapters are organized.

## Non-Goals

- No LiteLLM or request translation proxy.
- No old TUI or old NDJSON compatibility.
- No public web exposure.
- No auth system in v1.
- No multi-provider support in v1.
- No multi-instance UI in v1.
- No multi-conversation grouping in v1.
- No automated compaction detection in v1.
- No highlighted-text token counting in v1.
- No local token estimates in v1.
- No mobile optimization.
- No keyboard shortcut parity with the TUI.
- No annotations/bookmarks/labels.
- No import/export.
- No in-UI settings editing.
- No body secret redaction beyond auth headers/query credentials.

## Post-V1 Technical Validations

No V1-specific open questions or investigations remain.

- Continue measuring firewall CPU/RAM under larger Bedrock/Pi captures before
  changing CPU/RAM defaults.
- Revisit true mitmproxy chunk arrival timing only if a later analysis view
  needs wall-clock stream timing beyond decoded logical stream events.
