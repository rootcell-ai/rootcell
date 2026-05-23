import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  normalizeBedrockCall,
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
    expect(blocks(toolResult, "request").map((block) => block.kind)).toEqual(expect.arrayContaining([
      "tool-call",
      "tool-result",
      "cache-marker",
    ]));
    expect(firstBlock(toolResult, "request", "tool-result").text).toContain("success");
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
    expect(toolUse.streamEvents.map((event) => event.event_type)).toEqual(expect.arrayContaining([
      "contentBlockStart",
      "contentBlockDelta",
      "messageStop",
      "metadata",
    ]));
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
