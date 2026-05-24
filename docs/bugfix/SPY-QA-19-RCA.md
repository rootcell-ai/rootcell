# SPY-QA-19 RCA: Bedrock Reasoning Content Is Classified As Unknown

## Scope

This RCA covers the highest-priority open spy bug in `PLAN.md`: `SPY-QA-19`.

Triage notes:

- `PLAN.md` marks all P0 spy bugs closed.
- `PLAN.md` marks `SPY-QA-01` through `SPY-QA-18` complete or closed.
- `SPY-QA-19` is the first unchecked item in the prioritized handoff, and it is
  a P1 issue.
- This document was written before any product-code fix for `SPY-QA-19`.

## Bug Definition

`PLAN.md:955-957` defines the current bug:

```text
[P1] SPY-QA-19: Fix Bedrock reasoning classification. Prior-history
`reasoningContent` and signature-only reasoning chunks show as `Unknown`
instead of thinking/reasoning metadata.
```

## Reproduction Used

I used the current Bedrock normalizer directly with two synthetic but schema-shaped
Bedrock Converse captures:

- A request whose prior assistant history contains
  `content[].reasoningContent.reasoningText.text` plus a signature.
- A response AWS event-stream whose `contentBlockDelta.delta.reasoningContent`
  contains only `reasoningText.signature`.

This isolates the adapter behavior without relying on browser rendering.

Command used:

```sh
bun --eval '<script importing normalizeBedrockRequest/normalizeBedrockResponse and printing reasoning-related normalized blocks>'
```

The script constructed a normal request spool event and a valid AWS event-stream
response spool event with CRC-valid message framing, then called the exported
normalizers from `src/spy/bedrock.ts`.

## Runtime Proof

The current tree produced this output:

```json
{
  "requestReasoningRelated": [
    {
      "kind": "unknown",
      "role": "assistant",
      "provider_path": "$.messages[1].content[0]",
      "json": {
        "reasoningContent": {
          "reasoningText": {
            "text": "prior hidden reasoning",
            "signature": "sig-prior"
          }
        }
      }
    }
  ],
  "requestThinkingBlockCount": 0,
  "responseReasoningRelated": [
    {
      "kind": "unknown",
      "role": "assistant",
      "provider_path": "$.eventStream[1].payload",
      "json": [
        {
          "reasoningContent": {
            "reasoningText": {
              "signature": "sig-only-response"
            }
          }
        }
      ]
    }
  ],
  "responseThinkingBlockCount": 0,
  "responseDeltaPayloadText": null,
  "responseDeltaPayload": {
    "contentBlockIndex": 0,
    "delta": {
      "reasoningContent": {
        "reasoningText": {
          "signature": "sig-only-response"
        }
      }
    }
  }
}
```

This proves both halves of the bug:

- Prior-history request `reasoningContent` is present in the captured payload,
  but the adapter emits a request block with `kind: "unknown"` and zero request
  `thinking` blocks.
- A signature-only response reasoning delta is present in the decoded stream
  payload, but the adapter emits a response block with `kind: "unknown"`, zero
  response `thinking` blocks, and no `payload_text`.

## Source Evidence

The request-side classifier does not handle `reasoningContent`.
`src/spy/bedrock.ts:371-421` recognizes only these message content shapes before
falling through:

- `text`
- `cachePoint`
- `toolUse`
- `toolResult`

Everything else reaches `src/spy/bedrock.ts:423-429`, which creates an
`unknown` block with the original JSON.

The response-side classifier only emits `thinking` when it has text.
`src/spy/bedrock.ts:535-542` creates a `thinking` block only when
`builder.thinkingParts.length > 0`.

`src/spy/bedrock.ts:619-625` pushes a response delta into `unknownValues` when
the delta has no plain text, no tool input, and `thinkingText(delta)` returns
`undefined`.

`src/spy/bedrock.ts:854-860` makes that failure concrete:

```ts
function thinkingText(delta: Record<string, unknown>): string | undefined {
  const direct = stringField(delta, "thinking") ?? stringField(delta, "reasoning");
  if (direct !== undefined) {
    return direct;
  }
  const reasoningContent = recordField(delta, "reasoningContent");
  return stringField(reasoningContent, "text") ?? stringField(reasoningContent, "reasoningText");
}
```

This handles only flat string forms:

- `delta.thinking`
- `delta.reasoning`
- `delta.reasoningContent.text`
- `delta.reasoningContent.reasoningText` as a direct string

It does not handle the nested Bedrock form used by the repro:
`reasoningContent.reasoningText.text` and
`reasoningContent.reasoningText.signature`. For signature-only deltas, there is
no text to append, so the current response builder has no non-unknown path for
reasoning metadata.

`src/spy/bedrock.ts:863-870` uses the same `thinkingText()` helper for stream
event `payload_text`, which is why the proof returned `responseDeltaPayloadText:
null`.

## Root Cause

`SPY-QA-19` is a Bedrock adapter classification bug.

The adapter treats reasoning as text-only. It has no request-side
`reasoningContent` branch, and its response-side extraction understands only
flat reasoning text fields. Nested reasoning payloads, especially signature-only
metadata chunks, are therefore routed through the generic unknown fallback even
though they are known Bedrock thinking/reasoning content.

The browser is only displaying the normalized block kind it receives. The store,
API, and UI do not appear to be the root cause for this bug.

## Proposed Fix

Fix `SPY-QA-19` in `src/spy/bedrock.ts`:

- Add request message-content handling for `reasoningContent`.
  - Emit `kind: "thinking"`.
  - Preserve the original reasoning JSON.
  - Use available reasoning text from nested or flat forms when present.
  - Keep signature-only reasoning as a `thinking` block with metadata JSON even
    when no text is available.
- Replace the response `thinkingParts` text-only model with a representation
  that can track reasoning text and reasoning metadata.
  - Text deltas should still reconstruct one `thinking` block with text.
  - Signature-only deltas should emit `kind: "thinking"` with JSON metadata
    instead of `unknown`.
  - Unknown should remain reserved for truly unrecognized response shapes.
- Update `streamPayloadText()` so nested reasoning text appears in stream event
  previews when text exists. Signature-only chunks can still omit payload text,
  but they should no longer force the normalized response block to `unknown`.
- Add adapter unit coverage for prior request reasoning history, nested response
  reasoning text, and signature-only response reasoning metadata.

## Expected Post-Fix Proof

The same reproduction should show:

- `requestThinkingBlockCount: 1`
- The prior assistant request block has `kind: "thinking"` and preserves the
  `reasoningContent` JSON.
- `responseThinkingBlockCount: 1`
- The signature-only response reasoning delta creates a `thinking` block with
  JSON metadata, not an `unknown` block.
- Nested response reasoning text, when present, appears in both the normalized
  thinking block and stream event `payload_text`.

## Fix Status

Implemented on 2026-05-24.

Changed `src/spy/bedrock.ts` so Bedrock request message
`reasoningContent` blocks now normalize as `kind: "thinking"` instead of
falling through to `unknown`. The adapter extracts reasoning text from nested
`reasoningContent.reasoningText.text` when present, preserves the original
reasoning JSON, and keeps signature-only reasoning metadata as a thinking block
without requiring visible text.

Changed response delta handling so nested Bedrock reasoning deltas are tracked
separately from unknown values. Text-bearing reasoning deltas reconstruct the
thinking text, and signature-only reasoning chunks are retained as thinking
metadata rather than creating an `unknown` response block. Stream event previews
also use the nested reasoning text extractor when text exists.

Added regression coverage in `src/spy/bedrock.test.ts` for:

- Prior-history request `reasoningContent` becoming a request `thinking` block.
- Nested response reasoning text and a signature-only chunk becoming one
  response `thinking` block with preserved metadata.
- A signature-only response reasoning chunk by itself becoming a metadata-only
  `thinking` block with no unknown blocks.

Verification commands:

- `bun test src/spy/bedrock.test.ts`
- `bun run typecheck`
- `bun run lint`
- `bun run test` with localhost binding permission for spy service tests
- `bun run build:spy`
