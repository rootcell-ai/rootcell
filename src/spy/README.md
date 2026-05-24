# Browser Spy

The browser spy is an opt-in local operator view for inspecting LLM provider
traffic captured on the firewall VM. V1 targets Pi using Amazon Bedrock Runtime.
It shows request composition, response blocks, provider-reported usage, cache
markers, stream events, HTTP metadata, and diffs against the previous comparable
request.

The spy is not a public service. The TypeScript service binds inside the
firewall VM, and `./rootcell spy` reaches it through a rootcell-managed SSH local
port forward.

## Scope

V1 includes:

- Amazon Bedrock provider normalization.
- Pi-oriented harness classification where the captured fixtures make it clear.
- SQLite persistence, retention, manual clear, JSON API, SSE, and React UI.
- Semantic request/response blocks, repeated/new/changed request cues, provider
  usage records, stream event inspection, and network metadata.

V1 does not include:

- OpenAI, direct Anthropic, Codex, Claude Code, Cursor, or multi-provider UI.
- Multi-conversation grouping.
- Automated compaction detection.
- Public exposure, authentication, or collaboration features.
- The old terminal/TUI spy or old NDJSON format.

## Enable And Launch

Spy is disabled by default for every instance.

1. Edit the selected instance environment:

   ```bash
   ./rootcell edit env
   ```

2. Set:

   ```sh
   ROOTCELL_SPY_ENABLED=true
   ```

3. Re-provision so the firewall VM receives `/etc/agent-vm/spy.env` and the
   service state is updated:

   ```bash
   ./rootcell provision
   ```

4. Launch the browser view:

   ```bash
   ./rootcell spy
   ```

`./rootcell spy` checks that the firewall VM, service unit, service assets, and
`/api/health` are reachable before opening the tunnel. It prints the local URL
and stays in the foreground so the SSH tunnel remains alive. Ctrl-C closes only
the tunnel.

Use `--no-open` to print the URL without opening a browser:

```bash
./rootcell spy --no-open
```

The old `--tui`, `--raw`, and `--no-dedupe` flags are intentionally removed.

## Capture Model

The firewall VM always ships the spy components, but capture only runs when the
generated `/etc/agent-vm/spy.env` enables it. When disabled, the TypeScript
service is stopped and the Python shim returns without writing spool files.

The Python shim in `proxy/agent_spy.py` is deliberately small:

- Detects Bedrock Runtime calls by host and REST path.
- Redacts auth headers, cookies, and credential query parameters.
- Writes one bounded JSON spool event per request, response, error, or dropped
  capture marker.
- Stores AWS event-stream response bodies as base64 with
  `body_encoding=aws-eventstream`.
- Stops writing when the spool cap is reached, while allowing agent traffic to
  continue.
- Swallows capture failures so spy problems do not alter firewall allow/deny
  decisions.

The TypeScript service owns validation, ingestion, provider normalization,
SQLite persistence, retention, API responses, SSE notifications, and static UI
serving.

## Data Locations

On the firewall VM:

- `/etc/agent-vm/spy.env` - generated runtime configuration.
- `/etc/agent-vm/spy-service.js` - bundled Bun service.
- `/etc/agent-vm/spy-ui/` - built React UI assets.
- `/var/spool/rootcell-spy/` - transient sensitive spool files from mitmproxy.
- `/var/lib/rootcell-spy/spy.sqlite` - persistent SQLite store.

The spool and SQLite database may contain decrypted prompt and response bodies.
Treat both as sensitive.

## Configuration

Instance `.env` settings are rendered into `/etc/agent-vm/spy.env` during
`./rootcell provision`.

```sh
ROOTCELL_SPY_ENABLED=false
# ROOTCELL_SPY_RETENTION_DAYS=7
# ROOTCELL_SPY_MAX_BYTES=6442450944
# ROOTCELL_SPY_SPOOL_MAX_BYTES=1073741824
# ROOTCELL_SPY_STORE_RAW=false
# ROOTCELL_SPY_TOKEN_COUNT_MODE=provider
# ROOTCELL_SPY_BIND=127.0.0.1
# ROOTCELL_SPY_PORT=6174
```

Defaults:

- Spy disabled unless `ROOTCELL_SPY_ENABLED=true`.
- Retain captured calls for 7 days.
- Limit the SQLite store to 6 GiB.
- Limit pending spool files to 1 GiB.
- Do not persist exact raw payload records by default.
- Count tokens through Bedrock CountTokens; no local token estimates are shown.
- Bind the firewall-local service to `127.0.0.1:6174`.

`./rootcell spy` tries host-local port `6174` first and falls back to the next
available port. The remote service port remains `ROOTCELL_SPY_PORT`.

Additional service-only environment variables exist for tests and development:
`ROOTCELL_SPY_DB_PATH`, `ROOTCELL_SPY_SPOOL_DIR`,
`ROOTCELL_SPY_STATIC_DIR`, `ROOTCELL_SPY_INGEST_INTERVAL_MS`,
`ROOTCELL_SPY_RETENTION_INTERVAL_MS`, and
`ROOTCELL_SPY_INGEST_BATCH_LIMIT`. `ROOTCELL_SPY_BEDROCK_REGION` can override
the AWS region used for provider token counting.

## Token Counting

The API and browser expose token counts for whole requests, request sections,
blocks, and selected text. Each count is labeled with provenance:
`provider_reported`, `provider_counted`, or `unavailable`.

Default behavior uses Bedrock CountTokens for whole-request, section, block,
and selected-text counts. Whole-request counts use the captured provider request
body when available so they preserve the real request context: messages, system
prompt, tool config, cache hints, and provider overhead. Standalone block,
section, and selection counts are wrapped as a minimal user message regardless
of the original block role or kind. That keeps per-fragment attribution
consistent and avoids provider validation rules for incomplete assistant turns.

The browser never calls Bedrock directly. Bedrock CountTokens is called with the
base Anthropic model ID because Bedrock inference-profile IDs such as
`us.anthropic.*` can be valid for inference but rejected for token counting.

Provider token counting can send captured prompt text back to Bedrock. When
provider mode is enabled, `./rootcell provision` forwards only Bedrock-relevant
credential environment variables into `/etc/agent-vm/spy.env`, and installs that
file as `0640 root:rootcell-spy`.

## Capacity Defaults

New Lima firewall VMs default to a 64 GiB disk. New AWS firewall VMs default to
a 64 GiB root EBS volume. The agent VM disk default remains 60 GiB. Existing
instances are not resized automatically.

## Retention And Clear

Retention runs inside the TypeScript service on startup and periodically while
the service is active. It deletes oldest calls first by age, then by SQLite size
budget. Related blocks, HTTP events, usage records, stream events, and optional
raw payload rows are deleted through cascade behavior.

The UI exposes a confirmed clear-data action. Clear-data:

- Takes the store write lock.
- Deletes captured provider calls and related rows.
- Deletes pending spool files.
- Resets health counters.
- Stores a clear generation and baseline timestamp.
- Keeps schema and migration metadata.

If the service is stopped, retention does not run. The Python shim can only fill
the bounded spool and then emit rate-limited dropped markers when space allows.

## API

The service exposes same-origin JSON endpoints:

- `GET /api/health`
- `GET /api/calls?since=&provider=&model_id=&operation=&status=&cursor=&limit=`
- `GET /api/calls/:id`
- `GET /api/calls/:id/diff`
- `GET /api/calls/:id/stream-events`
- `GET /api/search?q=&since=&provider=&model_id=&operation=&status=&cursor=&limit=`
- `POST /api/clear` with `{"confirm": true}`
- `GET /api/events` for SSE

The browser uses SSE for small live notifications and paginated JSON endpoints
for content. Broad CORS is not enabled.

## Security And Privacy

This feature persists decrypted LLM prompts and responses. Header and query
credential redaction is mandatory, but body secret redaction is intentionally
not attempted. If a prompt contains a secret, the spy store may contain that
secret until retention or manual clear removes it.

Security posture:

- Disabled by default.
- Firewall-local bind address.
- Host access only through the SSH tunnel opened by `./rootcell spy`.
- No public listener, auth system, or collaboration model in V1.
- Raw exact payload persistence disabled by default.
- Spool files are sensitive even when raw payload records are disabled.
- Spy failures must not block, slow significantly, or change agent traffic
  allow/deny decisions.

## Troubleshooting

`./rootcell spy` reports the common readiness failures directly:

- Disabled or stale generated config: set `ROOTCELL_SPY_ENABLED=true`, then run
  `./rootcell provision`.
- Missing service files or browser assets: run `./rootcell provision`.
- Inactive `rootcell-spy.service`: run `./rootcell provision`, then retry.
- Unhealthy service: inspect the service journal on the firewall VM.
- Tunnel failure: check provider VM reachability and SSH config.

Useful firewall checks:

```bash
ssh -F <instance-dir>/ssh/config rootcell-firewall -- \
  journalctl -u rootcell-spy.service -f

ssh -F <instance-dir>/ssh/config rootcell-firewall -- \
  systemctl status rootcell-spy.service

ssh -F <instance-dir>/ssh/config rootcell-firewall -- \
  curl -sS http://127.0.0.1:6174/api/health

ssh -F <instance-dir>/ssh/config rootcell-firewall -- \
  du -sh /var/lib/rootcell-spy /var/spool/rootcell-spy
```

For capture-specific failures, also inspect mitmproxy logs:

```bash
ssh -F <instance-dir>/ssh/config rootcell-firewall -- \
  journalctl -u mitmproxy-transparent -u mitmproxy-explicit -f
```

If the spool is full, either clear spy data from the UI, reduce retained data,
or raise `ROOTCELL_SPY_SPOOL_MAX_BYTES` and provision again.

## Developer Map

- `proxy/agent_spy.py` - mitmproxy-facing Bedrock spool shim.
- `src/spy/schemas.ts` - Zod schemas and TypeScript contracts.
- `src/spy/eventstream.ts` - AWS event-stream decoder.
- `src/spy/bedrock.ts` - Bedrock provider adapter and Pi classification.
- `src/spy/migrations.ts` - SQLite migrations.
- `src/spy/store.ts` - ingestion, persistence, retention, search, diff, and
  health snapshots.
- `src/spy/service.ts` - Bun HTTP service, API, SSE, and static file serving.
- `src/spy/ui/` - React desktop UI.
- `src/spy/fixtures/` - sanitized real Pi/Bedrock captures used by tests.
- `src/bin/spy-service.ts` - service entry point bundled for the firewall VM.

Provider adapters answer what happened on the wire. Harness analyzers answer
what the captured structure means for a specific harness. V1 has Bedrock as the
provider layer and Pi as the harness layer.

## Build And Test

Common checks:

```bash
bun run typecheck
bun run lint
bun run test
```

Spy-specific builds and UI tests:

```bash
bun run build:spy
bun run test:spy-ui:unit
bun run test:spy-ui:e2e
```

During provisioning, `./rootcell` runs `bun run build:spy`, copies the generated
`dist/spy-service.js` and `dist/spy-ui` artifacts into the firewall VM's guest
flake source, and lets Nix install them into `/etc/agent-vm`. Guest rebuilds use
an explicit `path:` flake reference so copied generated assets remain visible
even if the guest source directory has stale Git metadata. Clean flake evals
still tolerate missing local `dist/` output because `dist/` is ignored by git.
Do not copy host `node_modules` into the VM; the service bundle is
architecture-neutral TypeScript/JavaScript and uses the firewall VM's Bun
runtime.
