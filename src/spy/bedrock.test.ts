import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  normalizeBedrockCall,
  normalizeBedrockRequest,
  normalizeBedrockResponse,
  normalizeBedrockSpoolEvents,
  type NormalizedProviderCall,
} from "./bedrock.ts";
import {
  NormalizedBlockSchema,
  ProviderCallSchema,
  RawPayloadRecordSchema,
  SpoolEventSchema,
  StreamEventSchema,
  UsageRecordSchema,
  type NormalizedBlock,
  type SpoolEvent,
  type SpoolRequestEvent,
  type SpoolResponseEvent,
} from "./schemas.ts";

const FIXTURE_PATH = new URL("./fixtures/bedrock-pi-us-sonnet-4-6.ndjson", import.meta.url);

function fixtureEvents(): SpoolEvent[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => SpoolEventSchema.parse(JSON.parse(line) as unknown));
}

function fixturePair(flowId: string): readonly [SpoolRequestEvent, SpoolResponseEvent] {
  const events = fixtureEvents();
  const request = events.find((event): event is SpoolRequestEvent => (
    event.direction === "request" && event.flow_id === flowId
  ));
  const response = events.find((event): event is SpoolResponseEvent => (
    event.direction === "response" && event.flow_id === flowId
  ));
  if (request === undefined || response === undefined) {
    throw new Error(`missing fixture pair ${flowId}`);
  }
  return [request, response];
}

function syntheticRequest(flowId: string, body: Record<string, unknown>): SpoolRequestEvent {
  return {
    version: 1,
    ts: 1779496900,
    direction: "request",
    flow_id: flowId,
    provider: "bedrock",
    operation: "converse-stream",
    model_id: "us.anthropic.claude-sonnet-4-6",
    host: "bedrock-runtime.us-east-1.amazonaws.com",
    method: "POST",
    path: "/model/us.anthropic.claude-sonnet-4-6/converse-stream",
    headers: [["content-type", "application/json"]],
    body_text: JSON.stringify(body),
  };
}

function syntheticResponse(
  flowId: string,
  events: readonly (readonly [string, Record<string, unknown>])[],
): SpoolResponseEvent {
  return {
    version: 1,
    ts: 1779496901,
    direction: "response",
    flow_id: flowId,
    provider: "bedrock",
    operation: "converse-stream",
    model_id: "us.anthropic.claude-sonnet-4-6",
    host: "bedrock-runtime.us-east-1.amazonaws.com",
    method: "POST",
    path: "/model/us.anthropic.claude-sonnet-4-6/converse-stream",
    headers: [["content-type", "application/vnd.amazon.eventstream"]],
    status_code: 200,
    reason: "OK",
    request_headers: [["content-type", "application/json"]],
    body_encoding: "aws-eventstream",
    body_b64: encodeAwsEventStream(events).toString("base64"),
  };
}

function callById(calls: readonly NormalizedProviderCall[], id: string): NormalizedProviderCall {
  const call = calls.find((candidate) => candidate.call.id === id);
  if (call === undefined) {
    throw new Error(`missing normalized call ${id}`);
  }
  return call;
}

function blocks(call: NormalizedProviderCall, direction: "request" | "response"): NormalizedBlock[] {
  return call.blocks.filter((block) => block.direction === direction);
}

function firstBlock(
  call: NormalizedProviderCall,
  direction: "request" | "response",
  kind: NormalizedBlock["kind"],
): NormalizedBlock {
  const block = call.blocks.find((candidate) => (
    candidate.direction === direction && candidate.kind === kind
  ));
  if (block === undefined) {
    throw new Error(`missing ${direction} ${kind} block in ${call.call.id}`);
  }
  return block;
}

describe("Bedrock adapter", () => {
  test("normalizes all complete fixture request/response pairs", () => {
    const calls = normalizeBedrockSpoolEvents(fixtureEvents());
    expect(calls).toHaveLength(5);
    expect(calls.map((call) => call.call.id)).toEqual([
      "call-fixture-flow-simple",
      "call-fixture-flow-session-turn-one",
      "call-fixture-flow-session-turn-two",
      "call-fixture-flow-tool-use",
      "call-fixture-flow-tool-result",
    ]);

    for (const normalized of calls) {
      expect(() => ProviderCallSchema.parse(normalized.call)).not.toThrow();
      for (const block of normalized.blocks) {
        expect(() => NormalizedBlockSchema.parse(block)).not.toThrow();
      }
      for (const usage of normalized.usage) {
        expect(() => UsageRecordSchema.parse(usage)).not.toThrow();
      }
      for (const event of normalized.streamEvents) {
        expect(() => StreamEventSchema.parse(event)).not.toThrow();
      }
      expect(normalized.rawPayloads).toEqual([]);
      expect(normalized.call.status).toBe("complete");
      expect(normalized.call.model_id).toBe("us.anthropic.claude-sonnet-4-6");
      expect(normalized.call.operation).toBe("converse-stream");
      expect(normalized.call.request_content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(normalized.call.response_content_hash).toMatch(/^[a-f0-9]{64}$/);
    }

    const simple = callById(calls, "call-fixture-flow-simple");
    expect(simple.call).toMatchObject({
      status_code: 200,
      request_flow_id: "fixture-flow-simple",
      response_flow_id: "fixture-flow-simple",
    });
  });

  test("classifies request system, current input, history, tools, and cache markers", () => {
    const calls = normalizeBedrockSpoolEvents(fixtureEvents());
    const simple = callById(calls, "call-fixture-flow-simple");
    const simpleRequest = blocks(simple, "request");
    expect(simpleRequest.filter((block) => block.kind === "current-user-input")).toHaveLength(1);
    expect(simpleRequest.filter((block) => block.kind === "harness-system-context")).toHaveLength(1);
    expect(simpleRequest.filter((block) => block.kind === "tool-definition")).toHaveLength(4);
    expect(simpleRequest.filter((block) => block.kind === "cache-marker")).toHaveLength(2);
    expect(firstBlock(simple, "request", "current-user-input").text).toContain("Fixture capture simple prompt");

    const turnTwo = callById(calls, "call-fixture-flow-session-turn-two");
    const turnTwoRequest = blocks(turnTwo, "request");
    expect(turnTwoRequest.filter((block) => block.kind === "prior-conversation-history")).toHaveLength(2);
    expect(firstBlock(turnTwo, "request", "current-user-input").text).toContain("session turn two");
    expect(JSON.stringify(turnTwoRequest.map((block) => block.text))).toContain("turn-one-ok");
    expect(JSON.stringify(turnTwoRequest.map((block) => block.text))).toContain("RCSPY-ALPHA");

    const toolResult = callById(calls, "call-fixture-flow-tool-result");
    const toolResultKinds = blocks(toolResult, "request").map((block) => block.kind);
    expect(toolResultKinds.includes("tool-call")).toBe(true);
    expect(toolResultKinds.includes("tool-result")).toBe(true);
    expect(toolResultKinds.includes("cache-marker")).toBe(true);
    expect(firstBlock(toolResult, "request", "tool-result").text).toContain("success");
  });

  test("classifies prior request reasoning content as thinking", () => {
    const normalized = normalizeBedrockRequest(syntheticRequest("fixture-flow-request-reasoning", {
      messages: [
        { role: "user", content: [{ text: "first visible prompt" }] },
        {
          role: "assistant",
          content: [{
            reasoningContent: {
              reasoningText: {
                text: "prior hidden reasoning",
                signature: "sig-prior",
              },
            },
          }],
        },
        { role: "user", content: [{ text: "current visible prompt" }] },
      ],
    }));

    const thinkingBlocks = normalized.blocks.filter((block) => block.kind === "thinking");
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0]).toMatchObject({
      direction: "request",
      role: "assistant",
      kind: "thinking",
      provider_path: "$.messages[1].content[0].reasoningContent",
      text: "prior hidden reasoning",
      json: {
        reasoningText: {
          text: "prior hidden reasoning",
          signature: "sig-prior",
        },
      },
    });
    expect(normalized.blocks.filter((block) => (
      block.kind === "unknown" && JSON.stringify(block.json).includes("reasoningContent")
    ))).toHaveLength(0);
  });

  test("classifies nested and signature-only response reasoning as thinking", () => {
    const normalized = normalizeBedrockResponse(syntheticResponse("fixture-flow-response-reasoning", [
      ["messageStart", { role: "assistant" }],
      ["contentBlockDelta", {
        contentBlockIndex: 0,
        delta: {
          reasoningContent: {
            reasoningText: {
              text: "response hidden reasoning",
            },
          },
        },
      }],
      ["contentBlockDelta", {
        contentBlockIndex: 0,
        delta: {
          reasoningContent: {
            reasoningText: {
              signature: "sig-only-response",
            },
          },
        },
      }],
      ["contentBlockStop", { contentBlockIndex: 0 }],
      ["messageStop", { stopReason: "end_turn" }],
      ["metadata", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
    ]));

    const thinkingBlocks = normalized.blocks.filter((block) => block.kind === "thinking");
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0]).toMatchObject({
      direction: "response",
      role: "assistant",
      kind: "thinking",
      text: "response hidden reasoning",
      json: [
        {
          reasoningContent: {
            reasoningText: {
              text: "response hidden reasoning",
            },
          },
        },
        {
          reasoningContent: {
            reasoningText: {
              signature: "sig-only-response",
            },
          },
        },
      ],
    });
    expect(normalized.blocks.filter((block) => (
      block.kind === "unknown" && JSON.stringify(block.json).includes("reasoningContent")
    ))).toHaveLength(0);
    const reasoningEvents = normalized.streamEvents.filter((event) => event.event_type === "contentBlockDelta");
    expect(reasoningEvents[0]?.payload_text).toBe("response hidden reasoning");
    expect(reasoningEvents[1]?.payload_text).toBeUndefined();
  });

  test("keeps signature-only response reasoning as thinking metadata", () => {
    const normalized = normalizeBedrockResponse(syntheticResponse("fixture-flow-signature-only-reasoning", [
      ["messageStart", { role: "assistant" }],
      ["contentBlockDelta", {
        contentBlockIndex: 0,
        delta: {
          reasoningContent: {
            reasoningText: {
              signature: "sig-only-response",
            },
          },
        },
      }],
      ["contentBlockStop", { contentBlockIndex: 0 }],
      ["messageStop", { stopReason: "end_turn" }],
      ["metadata", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
    ]));

    const thinkingBlocks = normalized.blocks.filter((block) => block.kind === "thinking");
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0]?.text).toBeUndefined();
    expect(thinkingBlocks[0]?.json).toEqual([{
      reasoningContent: {
        reasoningText: {
          signature: "sig-only-response",
        },
      },
    }]);
    expect(normalized.blocks.filter((block) => block.kind === "unknown")).toHaveLength(0);
  });

  test("reconstructs response text, tool use, provider usage, and stream events", () => {
    const calls = normalizeBedrockSpoolEvents(fixtureEvents());
    const simple = callById(calls, "call-fixture-flow-simple");
    expect(firstBlock(simple, "response", "assistant-output").text).toBe("fixture-simple-ok");
    expect(firstBlock(simple, "response", "provider-envelope").text).toBe("stopReason:end_turn");

    const simpleUsage = simple.usage[0];
    if (simpleUsage === undefined) {
      throw new Error("missing simple usage record");
    }
    expect(simpleUsage).toMatchObject({
      source: "provider-reported",
      input_tokens: 1936,
      output_tokens: 8,
      total_tokens: 1944,
    });
    expect(simple.streamEvents.map((event) => event.event_type)).toEqual([
      "messageStart",
      "contentBlockDelta",
      "contentBlockDelta",
      "contentBlockStop",
      "messageStop",
      "metadata",
    ]);

    const toolUse = callById(calls, "call-fixture-flow-tool-use");
    const toolCall = firstBlock(toolUse, "response", "tool-call");
    expect(toolCall.text).toContain("bash");
    expect(JSON.stringify(toolCall.json)).toContain("printf");
    expect(JSON.stringify(toolCall.json)).toContain("tool-fixture-ok");
    const toolUseEventTypes = toolUse.streamEvents.map((event) => event.event_type);
    expect(toolUseEventTypes.includes("contentBlockStart")).toBe(true);
    expect(toolUseEventTypes.includes("contentBlockDelta")).toBe(true);
    expect(toolUseEventTypes.includes("messageStop")).toBe(true);
    expect(toolUseEventTypes.includes("metadata")).toBe(true);
  });

  test("preserves raw payloads only when requested and keeps hashes stable", () => {
    const events = fixtureEvents();
    const firstPass = normalizeBedrockSpoolEvents(events);
    const secondPass = normalizeBedrockSpoolEvents(events);
    expect(secondPass.map((call) => call.call.request_content_hash)).toEqual(
      firstPass.map((call) => call.call.request_content_hash),
    );
    expect(secondPass.flatMap((call) => call.blocks.map((block) => block.content_hash))).toEqual(
      firstPass.flatMap((call) => call.blocks.map((block) => block.content_hash)),
    );

    const [request, response] = fixturePair("fixture-flow-simple");
    const raw = normalizeBedrockCall(request, response, { storeRaw: true });
    expect(raw.rawPayloads).toHaveLength(2);
    for (const payload of raw.rawPayloads) {
      expect(() => RawPayloadRecordSchema.parse(payload)).not.toThrow();
    }
    expect(raw.rawPayloads.map((payload) => payload.direction)).toEqual(["request", "response"]);
    expect(raw.rawPayloads[0]?.body_text).toContain("Fixture capture simple prompt");
    expect(raw.rawPayloads[1]?.body_encoding).toBe("aws-eventstream");
  });
});

function encodeAwsEventStream(events: readonly (readonly [string, Record<string, unknown>])[]): Buffer {
  return Buffer.concat(events.map(([eventType, payload]) => encodeAwsEventStreamMessage(eventType, payload)));
}

function encodeAwsEventStreamMessage(eventType: string, payload: Record<string, unknown>): Buffer {
  const headers = encodeEventStreamHeaders({ ":event-type": eventType });
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const totalLength = 12 + headers.length + payloadBytes.length + 4;
  const message = Buffer.alloc(totalLength);
  message.writeUInt32BE(totalLength, 0);
  message.writeUInt32BE(headers.length, 4);
  message.writeUInt32BE(testCrc32(message.subarray(0, 8)), 8);
  headers.copy(message, 12);
  payloadBytes.copy(message, 12 + headers.length);
  message.writeUInt32BE(testCrc32(message.subarray(0, totalLength - 4)), totalLength - 4);
  return message;
}

function encodeEventStreamHeaders(headers: Record<string, string>): Buffer {
  const chunks = Object.entries(headers).map(([name, value]) => {
    const nameBytes = Buffer.from(name, "utf8");
    const valueBytes = Buffer.from(value, "utf8");
    const chunk = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    let offset = 0;
    chunk.writeUInt8(nameBytes.length, offset);
    offset += 1;
    nameBytes.copy(chunk, offset);
    offset += nameBytes.length;
    chunk.writeUInt8(7, offset);
    offset += 1;
    chunk.writeUInt16BE(valueBytes.length, offset);
    offset += 2;
    valueBytes.copy(chunk, offset);
    return chunk;
  });
  return Buffer.concat(chunks);
}

const TEST_CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < TEST_CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
  }
  TEST_CRC32_TABLE[index] = value >>> 0;
}

function testCrc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of data) {
    crc = (TEST_CRC32_TABLE[(crc ^ byte) & 0xFF] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
