import { describe, expect, test } from "bun:test";
import { bedrockCountInputForText, bedrockCountInputFromRequestBody, bedrockTokenCountModelId } from "./bedrock-token-count.ts";
import {
  textForBlock,
  tokenCacheKey,
  tokenSourceHash,
} from "./tokens.ts";
import type { NormalizedBlock } from "./schemas.ts";

describe("spy token accounting helpers", () => {
  test("uses stable JSON text for JSON-only blocks", () => {
    const block: NormalizedBlock = {
      id: "block-json",
      call_id: "call-json",
      direction: "request",
      ordinal: 0,
      kind: "tool-definition",
      source: "test",
      json: { z: 1, a: { b: 2 } },
      char_size: 0,
      byte_size: 0,
      content_hash: "hash-json",
      cache_marker: false,
    };
    expect(textForBlock(block)).toBe('{"a":{"b":2},"z":1}');
  });

  test("builds stable provider cache keys from subject identity and source hash", () => {
    const sourceHash = tokenSourceHash("hello");
    expect(tokenCacheKey({
      subjectType: "block",
      callId: "call-one",
      blockId: "block-one",
      sourceHash,
      modelId: "model-one",
    })).toBe(`block:call-one::block-one::${sourceHash}:model-one`);
  });

  test("builds Bedrock CountTokens converse input from captured request bodies", () => {
    expect(bedrockCountInputFromRequestBody(JSON.stringify({
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      system: [{ text: "system" }],
      inferenceConfig: { maxTokens: 100 },
      toolConfig: { tools: [] },
    }))).toEqual({
      converse: {
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        system: [{ text: "system" }],
        toolConfig: { tools: [] },
      },
    });
    expect(bedrockCountInputFromRequestBody("{")).toBeNull();
  });

  test("uses base Anthropic model ids for Bedrock CountTokens", () => {
    expect(bedrockTokenCountModelId("us.anthropic.claude-haiku-4-5-20251001-v1:0"))
      .toBe("anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(bedrockTokenCountModelId("global.anthropic.claude-haiku-4-5-20251001-v1:0"))
      .toBe("anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(bedrockTokenCountModelId("anthropic.claude-3-5-haiku-20241022-v1:0"))
      .toBe("anthropic.claude-3-5-haiku-20241022-v1:0");
    expect(bedrockTokenCountModelId("us.amazon.nova-pro-v1:0"))
      .toBe("us.amazon.nova-pro-v1:0");
  });

  test("wraps block text as a minimal Converse token input", () => {
    expect(bedrockCountInputForText("selected text")).toEqual({
      converse: {
        messages: [{ role: "user", content: [{ text: "selected text" }] }],
      },
    });
    expect(bedrockCountInputForText("system text", {
      id: "block-system",
      call_id: "call-system",
      direction: "request",
      ordinal: 0,
      kind: "harness-system-context",
      source: "test",
      text: "system text",
      char_size: 11,
      byte_size: 11,
      content_hash: "hash-system",
      cache_marker: false,
    })).toEqual({
      converse: {
        messages: [{ role: "user", content: [{ text: "system text" }] }],
      },
    });
  });
});
