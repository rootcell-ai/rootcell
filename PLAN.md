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
- `GET /api/calls?since=&cursor=&limit=`
- `GET /api/calls/:id`
- `GET /api/calls/:id/diff`
- `GET /api/calls/:id/stream-events`
- `GET /api/search`
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

### V1

Build the Bedrock/Pi browser spy:

- [x] Define spool event schema, normalized provider schema, and SQLite schema.
- [x] Capture sanitized real Pi/Bedrock fixtures to ground the schema and
  adapter work.
- [x] Add initial AWS event-stream decoder.
- [x] Replace Python spy with minimal provider-gated spool shim.
- [ ] Implement TypeScript Bedrock adapter on top of the captured fixtures.
- [ ] Implement SQLite persistence, migrations, retention, and clear-data.
- [ ] Implement TS web service, API, SSE, and static asset serving.
- [ ] Implement React desktop UI with virtualized timeline and call inspector.
- [ ] Wire `rootcell provision`, systemd service config, and `rootcell spy`
   launcher/tunnel.
- [ ] Raise firewall disk/root volume defaults to 64 GiB.
- [ ] Remove old TUI/terminal spy flags, tests, and docs.
- [ ] Add `src/spy/README.md` and brief links from main/proxy docs.

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

Change firewall disk defaults:

- Lima firewall disk: 64 GiB.
- AWS firewall root volume: 64 GiB.
- Keep agent disk default unchanged.

Keep current CPU/RAM defaults as starting points, but validate with fixtures and
raise them if the service, SQLite ingestion, or UI serving needs more headroom.
Disk is cheap; do not optimize the service around artificially tiny capacity.

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
  - clears data

Fixture strategy:

- Initial sanitized real Pi/Bedrock fixture capture is complete for
  `us.anthropic.claude-sonnet-4-6`.
- Add handcrafted minimal fixtures only as supplements for targeted edge cases.
- Add more sanitized real captures as the Bedrock adapter, shim, and UI expose
  concrete gaps.
- Cover normal calls, streaming, tool calls/results, cache markers, large
  history, error responses, disabled capture, raw disabled, and raw enabled.

## Documentation

Add `src/spy/README.md` as the detailed operator/developer doc.

Briefly reference it from `README.md` and `proxy/README.md`.

Docs should cover:

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

## Open Technical Validations

- Confirm Bun's SQLite support is available and suitable in the pinned Nixpkgs
  firewall runtime.
- Validate whether mitmproxy can safely expose true streaming chunk timing. If
  not, persist logical stream events decoded from completed AWS event-stream
  bodies and label real arrival timing unavailable.
- Measure firewall CPU/RAM under representative Bedrock/Pi streaming and
  large-history fixtures, then decide whether to raise defaults.
- Confirm systemd `DynamicUser` plus persistent `StateDirectory`/spool
  permissions cleanly support TS service ownership and mitmproxy append access.
- Finalize the exact provider-neutral spool schema after the first Bedrock/Pi
  fixture pass.
