# Cursor Spy Bugs

## 2026-05-27 - Cursor startup/tool capability capture

### BUG-015 - Cursor `/compress` summary is duplicated as request context

Status: fixed in working tree and verified against the live `jmp` call.

Live evidence:

- Spy call: `call-cursor-d4286793-0c7d-4c6e-88a1-0834257e1b41`
- The captured `RunSSE` request body was only 43 bytes and contained just a
  request id frame: `6b08ac2c-5983-4d28-bb66-56987606d33a`.
- The generated compaction summary appeared once as response output, which is
  expected, and once as a request-side `prior-conversation-history` block, which
  was incorrect.
- The duplicated request-side payload came from a Cursor response-stream message
  shaped like:
  `role=user`, `content="[Previous conversation summary]: ..."`,
  `providerOptions.cursor.isSummary=true`.

Trigger evidence:

- The nearby support call `call-cursor-3379ecbb-ae82-46b7-8c9b-84bc64924739`
  captured `TrackEvents` JSON with
  `eventName=cli.slash_command.used`, `command=compress`, and
  `source=builtin`.
- The telemetry timestamp was `1779885494915`; the compaction `RunSSE` call
  started at `1779885495.0277288`, about 113 ms later.
- The two normal turns before compaction were:
  - `call-cursor-1a377a65-b69b-4a38-8014-3106d09d72ae` with current user input
    `Please summarize this repository.`
  - `call-cursor-8b3fff29-1400-42ba-8426-87c2f4dc84cf` with current user input
    `Please update this so that it uses Python instead of TypeScript.`

Root cause: Cursor handles `/compress` as a builtin client/control command, not
as normal current-user model input. The Cursor adapter intentionally mines
response-stream role messages for echoed request context because Cursor
`RunSSE` requests are often tiny and server-side context is otherwise hidden.
For compaction, that heuristic treated Cursor's synthetic summary state message
as request history for the same call.

Fix: response-stream messages with `providerOptions.cursor.isSummary=true` are
no longer promoted into request-context blocks. The summary remains available as
response output and in raw stream events.

Compaction detection notes for future UI work:

- Confirmed Cursor compaction should be detected as a multi-call workflow, not a
  normal user turn.
- Strong detection signal: a `TrackEvents` support call with
  `eventName=cli.slash_command.used`, `command=compress`, `source=builtin`,
  followed by a nearby `RunSSE` whose stream contains
  `providerOptions.cursor.isSummary=true`.
- Fallback/probable signal when telemetry is absent: a `RunSSE` with
  `isSummary=true`, no `current-user-input` block, summary-shaped assistant
  output, and request-context conversation metadata.
- The UI should eventually label this as a compaction/state-transition event
  such as `/compress triggered conversation compaction`, rather than showing it
  as a normal prompt/response turn.

Verification:

- Added a regression test for `providerOptions.cursor.isSummary=true`.
- `bun test src/spy/cursor.test.ts --timeout 10000`
- `bun run typecheck`
- `bun run lint`
- `./rootcell provision`
- Backfilled `call-cursor-d4286793-0c7d-4c6e-88a1-0834257e1b41` from its saved
  raw response payload; live store verification reports `requestSummary=0` and
  `responseSummary=1`.

### BUG-014 - Cursor protobuf text is mojibake when frames contain UTF-8 strings

Status: fixed in working tree and verified against the saved live raw payload.

Live evidence:

- Spy call: `call-cursor-f835ca09-621e-43e2-92dd-169c8e6ee917`
- The assistant output and tool result blocks showed mojibake such as
  `â`, `â`, `ââ`, `âº`, `Â·`, and `Cursorâs`.
- The expected text was normal UTF-8 punctuation and box drawing, for example
  `Harness ──protobuf──► Server ──internal──► Composer inference`.

Root cause: Cursor Connect/protobuf frames are binary protobuf, not whole-frame
UTF-8 text. The previous decoder tried whole-frame UTF-8 first, and when that
failed because protobuf tags/length prefixes are binary, it decoded the entire
frame as Latin-1 before searching for embedded JSON. That preserved ASCII JSON
syntax but corrupted every non-ASCII UTF-8 byte sequence inside JSON strings.
For example, UTF-8 bytes for `──` (`e2 94 80 e2 94 80`) became
`ââ` after Latin-1 decoding.

Fix: Connect/protobuf frames no longer fall back to Latin-1 whole-frame text.
The adapter now decodes protobuf length-delimited fields first, then extracts
JSON/text from those exact UTF-8 string field bytes. Whole-frame text extraction
is used only when the entire payload is valid UTF-8.

Verification:

- Re-normalizing the saved raw response payload for
  `call-cursor-f835ca09-621e-43e2-92dd-169c8e6ee917` now reports
  `containsMojibake=false` and includes
  `Harness ──protobuf──► Server ──internal──► Composer inference`.
- After `./rootcell provision`, the existing live call was re-normalized by
  submitting its saved raw response through the normal spy spool ingest path.
  The live detail API now reports zero blocks matching `[âÂ]`; assistant output
  and tool results show `→`, `—`, `──`, `►`, `·`, and `Cursor’s` correctly.
- A direct live store scan found 17 historical Cursor calls with stale
  normalized mojibake blocks. Re-submitting those saved raw responses through
  spool ingest raised the response ingest counter and left zero normalized
  blocks matching `[âÂ]` in the live SQLite store.
- Added a regression test that builds a protobuf frame whose JSON string
  contains `──`, `►`, `—`, `’`, and `·`; the frame as a whole is invalid UTF-8
  because of protobuf length-prefix bytes, and normalization still returns the
  correct Unicode text.
- `bun test src/spy/cursor.test.ts`
- `bun run typecheck`
- `bun run lint`
- `bun run build:spy`

### BUG-013 - Cursor support traffic overwhelms the spy timeline

Status: fixed in working tree and verified live after `./rootcell provision`.

After widening Cursor capture to preserve every Cursor API request, the spy UI
started showing many support RPCs that are not useful as conversation
request/response pairs, including `BidiAppend`, `SubmitLogs`, `TrackEvents`,
`traces`, and privacy/config polling.

Fix: the call list now has a `traffic` scope. The default `conversation`
scope hides Cursor support RPCs unless the user explicitly selects one of those
operations. The `all` scope still exposes every captured Cursor request for
raw protocol investigation.

Verification:

- `traffic=conversation` returned 53 Cursor calls with only `Run` and `RunSSE`.
- `traffic=all` returned 120 Cursor calls including `BidiAppend`, telemetry,
  traces, privacy/config polling, and `RunSSE`.
- `traffic=conversation&operation=BidiAppend` still returned BidiAppend calls,
  so explicit operation filters can inspect support traffic.
- `./rootcell provision`
- `bun run build:spy`
- `bun run typecheck`
- `bun run lint`

### BUG-012 - Cursor BidiAppend raw protobuf request data is not promoted

Status: fixed in working tree and verified against the saved post-restart
capture.

Live evidence:

- Spy call: `call-cursor-99ec2eaf-9b30-499d-b650-936259490d43`
- The raw `BidiAppend` request body was 334,642 bytes, but request composition
  only showed the HTTP provider envelope.
- The outer protobuf field 1 contained an ASCII hex-encoded inner protobuf
  message. Decoding that inner message exposed the current user prompt,
  `composer-2.5`, and 12 Cursor skill files from
  `/home/luser/.cursor/skills-cursor/.../SKILL.md`.
- A scan of the same capture did not find `ClientSideToolV2` enum capability
  IDs, but reverse-engineering evidence indicates older/alternate Cursor agent
  requests may send supported tools as enum IDs instead of JSON schemas.

Fix: Cursor request normalization now decodes raw protobuf bodies, recurses into
hex-encoded BidiAppend data fields, promotes BidiAppend envelope metadata,
current-user protobuf messages, Cursor skill file contents, model markers, and
known `ClientSideToolV2` enum capability lists when present.

Verification:

- Saved live `BidiAppend` request re-normalizes to 16 request blocks and
  80,327 request bytes: HTTP envelope, decoded BidiAppend envelope, current
  user input, 12 Cursor skill blocks, and model marker.
- `bun test src/spy/cursor.test.ts src/spy/store.test.ts`
- `bun run typecheck`
- `bun run lint`

### BUG-011 - Cursor setup RPCs may be hidden by capture gating

Status: diagnostic capture widened in working tree and hot-deployed to the live
firewall.

Live evidence:

- Spy call: `call-cursor-e623f954-fcca-4aec-b7ac-7fb78c1cbd7f`
- This call was made after restarting Cursor CLI, but the captured `RunSSE`
  request body was still only 43 bytes.
- The `RunSSE` response metadata reported `Tool definitions` as 24,509 bytes,
  but the exact schema text was not present in the captured RunSSE protobuf
  frames.
- No separate startup/setup call appeared in the store because the proxy only
  captured Cursor `Run`, `RunSSE`, and `StreamUnifiedChat` operations.

Diagnostic fix: Cursor detection now captures every request to known Cursor API
hosts and wildcard `*.cursor.sh` hosts, including startup, auth, analytics,
config/model, repository, and bidi operations. Cursor request/response bodies
are stored as base64 plus sha256 so raw protobuf bytes are preserved even when
they happen to decode as UTF-8.

Live deployment:

- Installed updated `/etc/agent-vm/agent_spy.py` on the `jmp` firewall.
- Restarted `mitmproxy-explicit.service` and `mitmproxy-transparent.service`.
- Verified both mitmproxy services are active and the deployed shim checksum
  matches the local file.

## 2026-05-27 - Cursor protobuf context section metadata

### BUG-010 - Cursor request composition omits protobuf context-section metadata

Status: fixed in working tree and verified against the captured live call payload.

Live evidence:

- Spy call: `call-cursor-70693ea3-5926-41d0-bb0d-a4c778d80e94`
- Before the fix, the detail API/UI showed only 4 request blocks:
  - provider envelope
  - Cursor system prompt
  - one large harness/rules/skills block
  - current user input
- The Cursor response stream also carried protobuf section metadata for hidden
  or cached request-context sections, including `tools`, `subagents`, and
  `conversation`, but the normalizer only used JSON-like role messages.
- Re-normalizing the live raw response with the fixed adapter adds metadata
  request blocks for:
  - `Tool definitions`: 24,509 bytes
  - `Subagent definitions`: 714 bytes
  - `Conversation`: 3,580 bytes
- After hot-deploying the rebuilt spy service and backfilling that call, the
  live detail API/UI reports 7 request blocks and 47 KiB of request context.

Fix: Cursor response normalization now walks decoded protobuf frames for
request-context section metadata and promotes sections that are not otherwise
represented by exact captured text. The store also treats these metadata blocks
as response-derived request blocks so repeated response persistence remains
idempotent.

Verification:

- `bun test src/spy/cursor.test.ts src/spy/store.test.ts`
- `bun run typecheck`
- `bun run lint`
- `bun run test:spy` with localhost listener permissions

## 2026-05-26 22:41 EDT - Fresh Cursor UI verification

Fresh real run:

- VM: `jmp`
- CLI: `cursor-agent -p --trust --sandbox enabled --model composer-2.5-fast --output-format stream-json`
- Prompt marker: `CURSOR_UI_VERIFY_DELTA_2243`
- Cursor session: `b0f7c5ec-b883-4ada-81dc-0272ff7cf0f9`
- Cursor request id: `c25955cb-afa3-40d0-924e-aaa6878dc15a`
- CLI model: `Composer 2.5 Fast`
- CLI response: `CURSOR_UI_VERIFY_DELTA_2243`
- CLI usage: `inputTokens=7922`, `outputTokens=58`, `cacheReadTokens=2848`, `cacheWriteTokens=0`
- Spy call: `call-cursor-99a14bd7-49aa-435b-b953-f2eb6ebb12e4`

Final post-provision run:

- VM: `jmp`
- CLI: `cursor-agent -p --trust --sandbox enabled --model composer-2.5-fast --output-format stream-json`
- Prompt marker: `CURSOR_UI_VERIFY_FINAL_2321`
- Cursor session: `6ca1c42d-c77c-4b64-aaf4-018b00a469a1`
- Cursor request id: `1e6cbdd8-0f24-4481-9393-7198d720c4aa`
- CLI model: `Composer 2.5 Fast`
- CLI response: `CURSOR_UI_VERIFY_FINAL_2321`
- CLI usage: `inputTokens=7931`, `outputTokens=52`, `cacheReadTokens=2848`, `cacheWriteTokens=0`
- Spy call: `call-cursor-7eb22349-13bb-48ab-ad2f-b91948b1a07a`
- UI showed request system prompt, harness context, current user input, assistant response, redacted auth headers, role-labeled stream events, and Cursor-specific unavailable token records.
- Running `cursor-agent status` afterward did not add unrelated Cursor auth/status traffic to the spy timeline.

### BUG-001 - Cursor request semantic blocks are missing

Status: fixed in working tree and verified live at 2026-05-26 22:53 EDT.

The spy UI shows only one request block for the fresh Cursor call:

- `Provider Envelope`: `POST api2.cursor.sh/agent.v1.AgentService/RunSSE`

It does not show the actual current user prompt, Cursor system prompt, tool definitions, rules, skills, MCP context, subagent definitions, or conversation context as request-side semantic blocks.

Expected: Cursor calls should expose request composition similarly to Bedrock/Pi and Claude Code, including at least current user input and system/tool context when the captured Cursor payload contains it.

Follow-up verification:

- Spy call: `call-cursor-182261cf-88d0-4526-b4a5-60b3751f586c`
- Prompt marker: `CURSOR_UI_VERIFY_TOOL_2300`
- Request blocks: 4
- Request composition now shows:
  - provider envelope
  - Cursor system prompt
  - Cursor harness context / rules / environment
  - current user input
- UI Request Blocks section includes the actual prompt: `Use your file listing tool to inspect this directory, then reply with exactly one final line: CURSOR_UI_VERIFY_TOOL_2300`

### BUG-002 - Cursor token usage is not shown

Status: fixed in working tree and verified live at 2026-05-27 05:58 EDT.

The Cursor CLI result reports usage for the same request:

- `inputTokens=7922`
- `outputTokens=58`
- `cacheReadTokens=2848`
- `cacheWriteTokens=0`

The spy UI shows `usage n/a`, `read -`, `write -`, and no usage records for the call.

Current likely cause: Cursor's HTTP response capture does not currently expose a normalized provider usage object, even though the CLI stdout has usage. The live captured HTTP stream for `call-cursor-182261cf-88d0-4526-b4a5-60b3751f586c` has no provider usage object; the UI correctly shows `usage n/a`.

Final post-provision evidence: `call-cursor-7eb22349-13bb-48ab-ad2f-b91948b1a07a` also has CLI usage (`inputTokens=7931`, `outputTokens=52`, `cacheReadTokens=2848`, `cacheWriteTokens=0`) but the spy UI/API show `Usage Records: No provider usage record`. The final live stream's trailing `line` payload is `{}`, with no `inputTokens`/`outputTokens` object.

Useful Cursor fallback signals that are available now:

- Request and response byte sizes.
- Request composition by semantic block type.
- Stream event count.
- Raw payload availability.
- Tool call and tool result blocks.

Fix: spy now tees decrypted Cursor response stream chunks, persists the raw chunk bytes even when raw payload storage is disabled, reassembles Connect frames, and exposes each raw Connect frame/protobuf payload as stream-event wire data. Provider usage is only a derived annotation from the observed Cursor final usage envelope.

Final live verification:

- Spy call: `call-cursor-3825fcc9-d848-4c78-8e23-d6902bd73b15`
- Prompt marker: `RCSPY_CURSOR_WIRE_002`
- CLI usage: `inputTokens=7931`, `outputTokens=61`, `cacheReadTokens=2848`, `cacheWriteTokens=0`
- Spy summary usage: `inputTokens=7931`, `outputTokens=61`, `cacheReadTokens=2848`, `cacheWriteTokens=0`, `totalTokens=10840`
- Stream event ordinal `25` shows `connect-protobuf-frame` with durable raw wire fields `frameB64`, `payloadB64`, and `payloadSha256`.
- The decoded wire tree shows Cursor final usage at `$frame[19].1.14`, with `wireInputTokens=10779`, `outputTokens=61`, `cacheReadTokens=2848`, `cacheWriteTokens=0`. Spy derives displayed input as `10779 - 2848 - 0 = 7931`, matching Cursor CLI.

### BUG-003 - Cursor tool calls/results are not promoted to response blocks

Status: fixed in working tree and verified live at 2026-05-26 22:53 EDT.

The Cursor CLI can emit tool calls and tool results during a `RunSSE` request. Before the fix, those were present only in stream payload/raw payload data, while Response Blocks showed only assistant text.

Follow-up verification:

- Spy call: `call-cursor-182261cf-88d0-4526-b4a5-60b3751f586c`
- CLI tool call: `Glob`
- UI Response Blocks now show:
  - assistant output
  - `Tool Call`: `Glob {"glob_pattern":"**/*","target_directory":"/tmp/rootcell-cursor-ui-tools"}`
  - `Tool Result`: `Result of search in '/tmp/rootcell-cursor-ui-tools' (total 1 file): - sample.txt`

Post-provision verification at 2026-05-26 23:15 EDT:

- Spy call: `call-cursor-a22bbe0b-38d0-4197-b8f4-9fe6d1f9960c`
- Prompt marker: `CURSOR_UI_VERIFY_TOOL_2315`
- CLI tool call: `Glob`
- UI Response Blocks show the assistant output, `Tool Call`, and `Tool Result`.
- UI Stream Events show role labels including `assistant` and `tool`.

### BUG-004 - Cursor stream event labels are too generic

Status: fixed in working tree and verified live at 2026-05-26 22:53 EDT.

Before the fix, Cursor stream events were labeled as generic `line#...` entries even when the payload contained a role. The UI now shows role-derived labels for the verified call: `system`, `user`, `assistant`, and `tool`.

### BUG-005 - Operation filter omits Cursor operations

Status: fixed in working tree and verified live at 2026-05-26 22:59 EDT.

The provider filter includes Cursor, but the operation filter was still Bedrock-only and did not list `Run`, `RunSSE`, or `StreamUnifiedChat`. This made it impossible to filter live Cursor captures by operation from the UI even though the API accepts operation filters.

Follow-up verification:

- The operation filter now lists `Cursor Run`, `Cursor Run SSE`, and `Cursor Unified Chat`.
- Selecting `Cursor Run SSE` shows the live Cursor `RunSSE` calls.

### BUG-006 - Cursor token-count requests leak Bedrock CountTokens errors

Status: fixed in working tree and verified live at 2026-05-26 23:10 EDT.

Clicking/requesting token counts for a Cursor call returned an unavailable record with a Bedrock error: `The provided model identifier is invalid`. Cursor provider token counts are not available from the captured HTTP stream, so the service should not call Bedrock CountTokens for Cursor calls.

Verified behavior after the fix: Cursor request/block token-count requests and call-detail token records return `unavailable` with a Cursor-specific explanation: provider token counting is currently available only for Bedrock captures; Cursor request/block token recounting is not implemented. Provider usage from Cursor's final wire envelope is captured separately when present.

Follow-up verification:

- Spy call: `call-cursor-47ef4eac-dd20-4cfe-8ee5-3559367364a7`
- Prompt marker: `CURSOR_UI_VERIFY_TOKEN_2310`
- CLI model: `Composer 2.5 Fast`
- CLI usage: `inputTokens=3708`, `outputTokens=58`, `cacheReadTokens=7072`, `cacheWriteTokens=0`
- UI Request tokens now show `-` with the Cursor-specific unavailable reason, not a Bedrock model error.

### BUG-007 - Cursor token-count unavailable events can race the detail load

Status: fixed in working tree and verified live at 2026-05-26 23:10 EDT.

Cursor token counting is unavailable immediately because spy should not call Bedrock for Cursor. When that unavailable result was emitted only as a background SSE event, the event could arrive before the React call-detail state was installed. The visible effect was an endless `pending` request token state even though `/api/token-count` returned the correct Cursor-specific unavailable record.

Fix: for non-Bedrock calls, the service now returns synthetic unavailable token records directly in the call detail response and skips the background provider-token-count path.

Follow-up verification:

- Fresh post-provision call: `call-cursor-47ef4eac-dd20-4cfe-8ee5-3559367364a7`
- UI composition panel shows the Cursor-specific unavailable message for request tokens immediately after loading the call.
- Provider and operation filters still show the call when selecting `Cursor` and `Cursor Run SSE`.

### BUG-008 - Resumed Cursor sessions do not expose full request context in captured HTTP

Status: open; likely Cursor server-side/session-cache behavior rather than a parser failure.

Fresh initial Cursor calls expose rich request context in the captured response stream, including the Composer system prompt, harness context, and current user input. A resumed Cursor session did not expose the same context over HTTP; spy captured only the request envelope and the resumed current user input.

Verification:

- Resumed Cursor session: `56d03290-acb4-4ff4-84a5-3c237bd05c85`
- Spy call: `call-cursor-638ed1eb-fe15-4bad-9589-f0d6044d6bb3`
- Prompt marker: `CURSOR_UI_VERIFY_RESUME_2313`
- CLI usage: `inputTokens=61`, `outputTokens=56`, `cacheReadTokens=10816`, `cacheWriteTokens=0`
- UI Request Blocks: 2 blocks, request envelope plus current user input.
- UI did not show the prior prompt marker `CURSOR_UI_VERIFY_TOKEN_2310` in the resumed call detail.

Impact: for the demo, an initial Cursor call can show the system prompt and harness context, but resumed Cursor turns may need to be explained as relying on Cursor-side session/cache state that spy cannot currently reconstruct from the captured HTTP payload alone.

### BUG-009 - Absent request sections displayed token counts as pending

Status: fixed in working tree and verified live at 2026-05-26 23:20 EDT.

While testing Cursor calls with unavailable token counts, the composition table still showed `pending` in the token column for absent sections such as prior conversation history and tool definitions. Those sections have no text to count, so `pending` implied work was still in progress when no count should exist.

Fix: absent composition sections now display `-` with a `section absent` title. Present sections still display counted, unavailable, or pending token state as appropriate.

Follow-up verification:

- Spy call: `call-cursor-a22bbe0b-38d0-4197-b8f4-9fe6d1f9960c`
- UI composition panel shows `-` for absent sections and the Cursor-specific unavailable reason for present request-token records.
