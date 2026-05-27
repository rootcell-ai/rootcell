import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import {
  normalizeCursorRequest,
  normalizeCursorResponse,
} from "./cursor.ts";
import {
  NormalizedBlockSchema,
  ProviderCallSchema,
  RawPayloadRecordSchema,
  SpoolEventSchema,
  UsageRecordSchema,
  type SpoolRequestEvent,
  type SpoolResponseEvent,
} from "./schemas.ts";

function cursorRequest(flowId: string, body: Record<string, unknown>): SpoolRequestEvent {
  return {
    version: 1,
    ts: 1779497200,
    direction: "request",
    flow_id: flowId,
    provider: "cursor",
    operation: "StreamUnifiedChat",
    model_id: "Composer 2.5",
    host: "api2.cursor.sh",
    method: "POST",
    path: "/aiserver.v1.AiService/StreamUnifiedChat",
    headers: [["content-type", "application/json"]],
    body_text: JSON.stringify(body),
  };
}

function cursorResponse(flowId: string, body: Record<string, unknown>): SpoolResponseEvent {
  return {
    version: 1,
    ts: 1779497201,
    direction: "response",
    flow_id: flowId,
    provider: "cursor",
    operation: "StreamUnifiedChat",
    model_id: "Composer 2.5",
    host: "api2.cursor.sh",
    method: "POST",
    path: "/aiserver.v1.AiService/StreamUnifiedChat",
    headers: [["content-type", "application/json"]],
    status_code: 200,
    reason: "OK",
    request_headers: [["content-type", "application/json"]],
    body_text: JSON.stringify(body),
  };
}

function connectFrame(payload: Buffer, compressed = false): Buffer {
  const body = compressed ? gzipSync(payload) : payload;
  const header = Buffer.alloc(5);
  header[0] = compressed ? 1 : 0;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function protoVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function protoField(fieldNumber: number, wireType: number, payload: Buffer): Buffer {
  return Buffer.concat([protoVarint(fieldNumber * 8 + wireType), payload]);
}

function protoVarintField(fieldNumber: number, value: number): Buffer {
  return protoField(fieldNumber, 0, protoVarint(value));
}

function protoPackedVarintsField(fieldNumber: number, values: readonly number[]): Buffer {
  return protoMessageField(fieldNumber, Buffer.concat(values.map((value) => protoVarint(value))));
}

function protoMessageField(fieldNumber: number, message: Buffer): Buffer {
  return protoField(fieldNumber, 2, Buffer.concat([protoVarint(message.length), message]));
}

function protoStringField(fieldNumber: number, value: string): Buffer {
  return protoMessageField(fieldNumber, Buffer.from(value, "utf8"));
}

function cursorContextSectionMetadata(key: string, label: string, startOffset: number, size: number): Buffer {
  return Buffer.concat([
    protoStringField(1, key),
    protoStringField(2, label),
    protoVarintField(3, startOffset),
    protoVarintField(4, size),
  ]);
}

describe("Cursor adapter", () => {
  test("normalizes Cursor request semantic blocks", () => {
    const normalized = normalizeCursorRequest(cursorRequest("fixture-cursor-flow", {
      model: "Composer 2.5",
      system: "You are Cursor Agent.",
      messages: [
        { role: "user", content: "Earlier request RCSPY-CURSOR-ALPHA" },
        { role: "assistant", content: "Earlier response" },
        { role: "user", content: "Current request RCSPY-CURSOR-BETA" },
      ],
      tools: [{ name: "shell", description: "Run commands" }],
    }));

    expect(() => ProviderCallSchema.parse(normalized.call)).not.toThrow();
    expect(normalized.call.provider).toBe("cursor");
    expect(normalized.call.model_id).toBe("Composer 2.5");
    for (const block of normalized.blocks) {
      expect(() => NormalizedBlockSchema.parse(block)).not.toThrow();
    }
    expect(normalized.blocks.find((block) => block.kind === "harness-system-context")?.text).toBe("You are Cursor Agent.");
    expect(normalized.blocks.filter((block) => block.kind === "prior-conversation-history").map((block) => block.text).join("\n")).toContain("RCSPY-CURSOR-ALPHA");
    expect(normalized.blocks.find((block) => block.kind === "current-user-input")?.text).toContain("RCSPY-CURSOR-BETA");
    expect(normalized.blocks.find((block) => block.kind === "tool-definition")?.text).toContain("shell");
  });

  test("normalizes Cursor response text, usage, stream lines, and raw payloads", () => {
    const normalized = normalizeCursorResponse(cursorResponse("fixture-cursor-flow-response", {
      type: "message",
      model: "Composer 2.5",
      result: {
        text: "cursor-response-ok",
      },
      usage: {
        inputTokens: 123,
        outputTokens: 7,
        cachedInputTokens: 11,
      },
    }), { storeRaw: true });

    expect(normalized.call.status).toBe("complete");
    expect(normalized.blocks.find((block) => block.kind === "assistant-output")?.text).toContain("cursor-response-ok");
    expect(normalized.usage[0]).toMatchObject({
      input_tokens: 123,
      output_tokens: 7,
      cache_read_tokens: 11,
      total_tokens: 141,
    });
    for (const usage of normalized.usage) {
      expect(() => UsageRecordSchema.parse(usage)).not.toThrow();
    }
    expect(normalized.rawPayloads).toHaveLength(1);
    expect(() => RawPayloadRecordSchema.parse(normalized.rawPayloads[0])).not.toThrow();
    expect(normalized.rawPayloads[0]?.body_text).toContain("cursor-response-ok");
  });

  test("accepts Cursor spool schema events and extracts printable binary strings", () => {
    const event = SpoolEventSchema.parse({
      version: 1,
      ts: 1779497200,
      direction: "request",
      flow_id: "fixture-cursor-binary",
      provider: "cursor",
      operation: "StreamUnifiedChat",
      model_id: "cursor",
      host: "api2.cursor.sh",
      method: "POST",
      path: "/aiserver.v1.AiService/StreamUnifiedChat",
      headers: [["content-type", "application/connect+proto"]],
      body_b64: Buffer.from("\u0000RCSPY-CURSOR-BINARY\u0000composer-2.5-fast", "utf8").toString("base64"),
    });
    if (event.direction !== "request") {
      throw new Error("expected request event");
    }

    const normalized = normalizeCursorRequest(event);
    expect(normalized.call.provider).toBe("cursor");
    expect(normalized.call.model_id).toBe("composer-2.5-fast");
    expect(JSON.stringify(normalized.blocks)).toContain("RCSPY-CURSOR-BINARY");
  });

  test("normalizes the redacted Cursor Agent fixture captured from jmp", () => {
    const fixtureUrl = new URL("./fixtures/cursor-agent-composer-2.5.ndjson", import.meta.url);
    const events = readFileSync(fixtureUrl, "utf8")
      .trim()
      .split("\n")
      .map((line) => SpoolEventSchema.parse(JSON.parse(line) as unknown));
    const requests = events.filter((event): event is SpoolRequestEvent => event.direction === "request");
    const responses = events.filter((event): event is SpoolResponseEvent => event.direction === "response");

    expect(events.every((event) => event.provider === "cursor")).toBe(true);
    expect(requests).toHaveLength(2);
    expect(responses).toHaveLength(2);
    const normalizedRequests = requests.map((event) => normalizeCursorRequest(event, { storeRaw: true }));
    const normalizedResponses = responses.map((event) => normalizeCursorResponse(event, { storeRaw: true }));
    expect(normalizedResponses.map((item) => item.call.model_id)).toEqual(["composer-2.5-fast", "composer-2.5-fast"]);
    expect(JSON.stringify(normalizedResponses)).toContain("RCSPY-CURSOR-ALPHA-HTTP1");
    expect(JSON.stringify(normalizedResponses)).toContain("RCSPY-CURSOR-BETA-HTTP1");
    expect(normalizedResponses.map((item) => item.usage[0]?.input_tokens)).toEqual([7918, 61]);
    expect(normalizedRequests.every((item) => item.rawPayloads.length === 1)).toBe(true);
    expect(normalizedResponses.every((item) => item.rawPayloads.length === 1)).toBe(true);
  });

  test("decodes Cursor Connect-framed gzip responses without binary fallback noise", () => {
    const systemFrame = connectFrame(Buffer.from([
      "\u0000",
      JSON.stringify({
        role: "system",
        content: "Cursor system prompt should become request context, not assistant output",
      }),
    ].join(""), "utf8"), true);
    const harnessContextFrame = connectFrame(Buffer.from([
      "\u0000",
      JSON.stringify({
        role: "user",
        content: "<user_info>\nWorkspace Path: /tmp/cursor\n</user_info>\n\n<rules>\nUse safe commands.\n</rules>",
      }),
    ].join(""), "utf8"), true);
    const userQueryFrame = connectFrame(Buffer.from([
      "\u0000",
      JSON.stringify({
        role: "user",
        content: [
          {
            type: "text",
            text: "<user_query>\nReply with RCSPY-CURSOR-CONNECT-OK\n</user_query>",
          },
        ],
      }),
    ].join(""), "utf8"));
    const assistantFrame = connectFrame(Buffer.from([
      "\u0000",
      JSON.stringify({
        role: "assistant",
        content: [
          { type: "redacted-reasoning", data: "opaque-reasoning" },
          { type: "text", text: "RCSPY-CURSOR-CONNECT-OK" },
          { type: "tool-call", toolCallId: "tool-one", toolName: "Glob", args: { glob_pattern: "**/*" } },
        ],
        providerOptions: { cursor: { modelName: "composer-2.5-fast" } },
      }),
      "\u0000",
      JSON.stringify({
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "tool-one", toolName: "Glob", result: "0 files found" },
        ],
      }),
      "\u0000",
      JSON.stringify({
        type: "result",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 },
        result: "RCSPY-CURSOR-CONNECT-OK",
      }),
    ].join(""), "utf8"));
    const normalized = normalizeCursorResponse({
      ...cursorResponse("fixture-cursor-connect", {}),
      model_id: "cursor",
      headers: [["content-type", "text/event-stream"], ["connect-content-encoding", "gzip"]],
      body_text: undefined,
      body_b64: Buffer.concat([systemFrame, harnessContextFrame, userQueryFrame, assistantFrame]).toString("base64"),
    });

    expect(normalized.call.model_id).toBe("composer-2.5-fast");
    const assistantText = normalized.blocks.find((block) => block.kind === "assistant-output")?.text ?? "";
    expect(assistantText).toContain("RCSPY-CURSOR-CONNECT-OK");
    expect(assistantText).not.toContain("Cursor system prompt");
    expect(assistantText).not.toContain("opaque-reasoning");
    const requestText = normalized.blocks.filter((block) => block.direction === "request").map((block) => block.text).join("\n");
    expect(requestText).toContain("Cursor system prompt should become request context");
    expect(requestText).toContain("Workspace Path: /tmp/cursor");
    expect(requestText).toContain("Reply with RCSPY-CURSOR-CONNECT-OK");
    expect(requestText).not.toContain("<user_query>");
    expect(normalized.blocks.find((block) => block.kind === "tool-call")?.text).toContain("Glob");
    expect(normalized.blocks.find((block) => block.kind === "tool-result")?.text).toContain("0 files found");
    expect(normalized.streamEvents.map((event) => event.event_type)).toContain("assistant");
    expect(normalized.streamEvents.map((event) => event.event_type)).toContain("tool");
    expect(normalized.usage[0]).toMatchObject({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_tokens: 3,
      total_tokens: 15,
    });
  });

  test("does not promote Cursor compaction summaries as request context", () => {
    const summary = [
      "Summary:",
      "1. Primary Request and Intent:",
      "The user asked to convert the project to Python.",
    ].join("\n");
    const summaryStateFrame = connectFrame(Buffer.from(JSON.stringify({
      role: "user",
      content: `[Previous conversation summary]: ${summary}`,
      providerOptions: { cursor: { isSummary: true } },
    }), "utf8"), true);
    const assistantSummaryFrame = connectFrame(Buffer.from(JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: summary }],
    }), "utf8"), true);

    const normalized = normalizeCursorResponse({
      ...cursorResponse("fixture-cursor-compaction-summary", {}),
      model_id: "cursor",
      headers: [["content-type", "text/event-stream"]],
      body_text: undefined,
      body_b64: Buffer.concat([summaryStateFrame, assistantSummaryFrame]).toString("base64"),
    });

    const requestText = normalized.blocks
      .filter((block) => block.direction === "request")
      .map((block) => block.text)
      .join("\n");
    const assistantText = normalized.blocks.find((block) => block.kind === "assistant-output")?.text ?? "";
    expect(requestText).not.toContain("Previous conversation summary");
    expect(requestText).not.toContain("convert the project to Python");
    expect(assistantText).toContain("convert the project to Python");
    expect(normalized.streamEvents.some((event) =>
      JSON.stringify(event.payload).includes("\"isSummary\":true")
    )).toBe(true);
  });

  test("persists raw Cursor Connect/protobuf bytes and annotates the known usage envelope", () => {
    const usageMessage = Buffer.concat([
      protoVarintField(1, 10779),
      protoVarintField(2, 52),
      protoVarintField(3, 2848),
      protoVarintField(4, 0),
    ]);
    const resultMessage = Buffer.concat([
      protoMessageField(1, protoMessageField(14, usageMessage)),
    ]);
    const normalized = normalizeCursorResponse({
      ...cursorResponse("fixture-cursor-protobuf-usage", {}),
      model_id: "cursor",
      headers: [["content-type", "application/connect+proto"]],
      body_text: undefined,
      body_b64: connectFrame(resultMessage).toString("base64"),
    });

    expect(normalized.usage).toHaveLength(1);
    expect(normalized.usage[0]).toMatchObject({
      input_tokens: 7931,
      output_tokens: 52,
      cache_read_tokens: 2848,
      cache_write_tokens: 0,
      total_tokens: 10831,
    });
    expect(normalized.usage[0]?.raw).toMatchObject({
      raw_protobuf: {
        frameIndex: 0,
        path: "$frame[0].1.14",
        wireInputTokens: 10779,
      },
    });
    const wireEvent = normalized.streamEvents.find((event) => event.event_type === "connect-protobuf-frame");
    expect(wireEvent?.payload).toMatchObject({
      format: "connect",
      frameIndex: 0,
      offset: 0,
      frameByteLength: connectFrame(resultMessage).length,
      payloadByteLength: resultMessage.length,
      frameB64: connectFrame(resultMessage).toString("base64"),
      payloadB64: resultMessage.toString("base64"),
      protobuf: {
        format: "protobuf",
        fields: [
          {
            fieldNumber: 1,
            wireType: 2,
            nested: {
              fields: [
                {
                  fieldNumber: 14,
                  wireType: 2,
                  nested: {
                    fields: [
                      { fieldNumber: 1, wireType: 0, value: 10779 },
                      { fieldNumber: 2, wireType: 0, value: 52 },
                      { fieldNumber: 3, wireType: 0, value: 2848 },
                      { fieldNumber: 4, wireType: 0, value: 0 },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
      cursorUsage: [{
        path: "$frame[0].1.14",
        inputTokens: 7931,
        outputTokens: 52,
        cacheReadTokens: 2848,
        cacheWriteTokens: 0,
        wireInputTokens: 10779,
      }],
    });
  });

  test("decodes embedded protobuf JSON as UTF-8 instead of Latin-1 mojibake", () => {
    const assistantText = [
      "Harness \u2500\u2500protobuf\u2500\u2500\u25ba Server \u2014 ok",
      "Apostrophe: Cursor\u2019s agent. Bullet: \u00b7.",
      "Padding so the protobuf length prefix uses a multi-byte varint and the whole frame is not valid UTF-8.",
    ].join("\n");
    const assistantJson = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
    });
    expect(Buffer.byteLength(assistantJson, "utf8")).toBeGreaterThan(127);
    const protoPayload = protoStringField(1, assistantJson);
    expect(protoPayload.toString("utf8")).toContain("\uFFFD");

    const normalized = normalizeCursorResponse({
      ...cursorResponse("fixture-cursor-protobuf-utf8-json", {}),
      headers: [["content-type", "application/connect+proto"]],
      body_text: undefined,
      body_b64: connectFrame(protoPayload).toString("base64"),
    });

    const normalizedText = normalized.blocks.find((block) => block.kind === "assistant-output")?.text ?? "";
    expect(normalizedText).toContain("Harness \u2500\u2500protobuf\u2500\u2500\u25ba Server \u2014 ok");
    expect(normalizedText).toContain("Cursor\u2019s agent");
    expect(normalizedText).toContain("Bullet: \u00b7");
    expect(normalizedText).not.toContain("â");
    expect(normalizedText).not.toContain("Â");
    expect(normalized.streamEvents.some((event) => JSON.stringify(event.payload).includes("Harness \u2500\u2500protobuf\u2500\u2500\u25ba Server"))).toBe(true);
  });

  test("promotes Cursor protobuf request-context section metadata", () => {
    const sectionEnvelope = Buffer.concat([
      protoMessageField(3, cursorContextSectionMetadata("tools", "Tool definitions", 5_884, 24_509)),
      protoMessageField(3, cursorContextSectionMetadata("conversation", "Conversation", 1_029, 3_083)),
    ]);
    const normalized = normalizeCursorResponse({
      ...cursorResponse("fixture-cursor-protobuf-context-sections", {}),
      headers: [["content-type", "application/connect+proto"]],
      body_text: undefined,
      body_b64: connectFrame(sectionEnvelope).toString("base64"),
    });

    const requestBlocks = normalized.blocks.filter((block) => block.direction === "request");
    const toolMetadata = requestBlocks.find((block) => block.kind === "tool-definition");
    expect(toolMetadata).toMatchObject({
      source: "cursor-response-context-metadata",
      provider_path: "$frame[0].3",
      char_size: 24_509,
      byte_size: 24_509,
    });
    expect(toolMetadata?.text).toContain("Tool definitions");
    expect(toolMetadata?.json).toMatchObject({
      sectionKey: "tools",
      reportedByteSize: 24_509,
    });

    const conversationMetadata = requestBlocks.find((block) => block.kind === "prior-conversation-history");
    expect(conversationMetadata).toMatchObject({
      source: "cursor-response-context-metadata",
      char_size: 3_083,
      byte_size: 3_083,
    });
    expect(conversationMetadata?.text).toContain("Conversation");
  });

  test("extracts Cursor BidiAppend hex protobuf request context", () => {
    const userMessage = Buffer.concat([
      protoStringField(1, "Please inspect the repo and reply with RCSPY-BIDI-OK"),
      protoStringField(2, "a3e38f7d-f57f-4e25-8c71-fe4bba7353f0"),
      protoStringField(3, ""),
      protoVarintField(4, 1),
    ]);
    const skillEntry = Buffer.concat([
      protoStringField(1, "/home/luser/.cursor/skills-cursor/sample/SKILL.md"),
      protoStringField(2, "---\nname: sample\ndescription: Test skill.\n---\n# Sample Skill\nUse this skill for tests."),
      protoStringField(3, "Test skill."),
    ]);
    const requestContext = Buffer.concat([
      protoMessageField(1, userMessage),
      protoMessageField(2, protoMessageField(2, skillEntry)),
    ]);
    const innerRequest = protoMessageField(1, Buffer.concat([
      protoStringField(1, ""),
      protoMessageField(2, protoMessageField(1, requestContext)),
      protoMessageField(9, protoStringField(1, "composer-2.5")),
    ]));
    const bidiAppend = Buffer.concat([
      protoStringField(1, innerRequest.toString("hex")),
      protoMessageField(2, protoStringField(1, "e9cf8f00-34dc-4361-b214-be52cc52f310")),
      protoVarintField(3, 2),
    ]);

    const normalized = normalizeCursorRequest({
      ...cursorRequest("fixture-cursor-bidi-append", {}),
      operation: "BidiAppend",
      model_id: "cursor",
      path: "/aiserver.v1.BidiService/BidiAppend",
      headers: [["content-type", "application/proto"]],
      body_text: undefined,
      body_b64: bidiAppend.toString("base64"),
    }, { storeRaw: true });

    expect(normalized.call.model_id).toBe("composer-2.5");
    expect(normalized.rawPayloads).toHaveLength(1);
    const envelope = normalized.blocks.find((block) => block.source === "cursor-request-protobuf-envelope");
    expect(envelope?.text).toContain("requestId=e9cf8f00-34dc-4361-b214-be52cc52f310");
    expect(envelope?.json).toMatchObject({
      appendSeqno: 2,
      dataDecodedByteLength: innerRequest.length,
    });
    const requestText = normalized.blocks.filter((block) => block.direction === "request").map((block) => block.text).join("\n");
    expect(requestText).toContain("RCSPY-BIDI-OK");
    expect(requestText).toContain("/home/luser/.cursor/skills-cursor/sample/SKILL.md");
    expect(requestText).toContain("# Sample Skill");
    expect(requestText).toContain("model: composer-2.5");
  });

  test("surfaces Cursor ClientSideToolV2 enum capabilities when protobuf carries them", () => {
    const requestProto = Buffer.concat([
      protoVarintField(29, 5),
      protoVarintField(29, 6),
      protoVarintField(29, 15),
      protoPackedVarintsField(29, [41, 42]),
    ]);

    const normalized = normalizeCursorRequest({
      ...cursorRequest("fixture-cursor-tool-enums", {}),
      model_id: "cursor",
      headers: [["content-type", "application/proto"]],
      body_text: undefined,
      body_b64: requestProto.toString("base64"),
    });

    const toolBlock = normalized.blocks.find((block) => block.source === "cursor-request-protobuf-tool-enums");
    expect(toolBlock?.kind).toBe("tool-definition");
    expect(toolBlock?.text).toContain("READ_FILE (5)");
    expect(toolBlock?.text).toContain("LIST_DIR (6)");
    expect(toolBlock?.text).toContain("RUN_TERMINAL_COMMAND_V2 (15)");
    expect(toolBlock?.text).toContain("RIPGREP_RAW_SEARCH (41)");
    expect(toolBlock?.text).toContain("GLOB_FILE_SEARCH (42)");
    expect(toolBlock?.json).toMatchObject({
      enum: "ClientSideToolV2",
      tools: [
        { id: 5, name: "READ_FILE" },
        { id: 6, name: "LIST_DIR" },
        { id: 15, name: "RUN_TERMINAL_COMMAND_V2" },
        { id: 41, name: "RIPGREP_RAW_SEARCH" },
        { id: 42, name: "GLOB_FILE_SEARCH" },
      ],
    });
  });
});
