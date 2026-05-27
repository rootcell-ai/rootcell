# Cursor Spy Bugs

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
