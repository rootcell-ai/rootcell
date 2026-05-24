import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { SpyCallSummary, SpyUsageSummary } from "./api-contracts.ts";
import { detectCompaction } from "./compaction.ts";
import { normalizeBedrockSpoolEvents, type NormalizedProviderCall } from "./bedrock.ts";
import {
  SpoolEventSchema,
  type NormalizedBlock,
  type ProviderCall,
  type SpoolEvent,
} from "./schemas.ts";

const FIXTURE_PATH = new URL("./fixtures/bedrock-pi-us-sonnet-4-6.ndjson", import.meta.url);

describe("compaction detection", () => {
  test("does not flag existing Pi/Bedrock fixture calls as compaction candidates", () => {
    const calls = normalizeBedrockSpoolEvents(fixtureEvents());
    let previous: NormalizedProviderCall | null = null;

    for (const call of calls) {
      const assessment = detectCompaction({
        summary: summaryFromNormalizedCall(call),
        requestBlocks: requestBlocks(call.blocks),
        previousSummary: previous === null ? null : summaryFromNormalizedCall(previous),
        previousRequestBlocks: previous === null ? [] : requestBlocks(previous.blocks),
      });
      expect(assessment.status).toBe("none");
      previous = call;
    }
  });

  test("labels Pi-pattern compaction candidates with high confidence", () => {
    const previousBlocks = [
      requestBlock("previous-system", "harness-system-context", "You are operating inside pi.", { source: "pi-bedrock-system", hash: "stable-system" }),
      requestBlock("previous-history-1", "prior-conversation-history", "First historical turn. ".repeat(120), { role: "user" }),
      requestBlock("previous-history-2", "prior-conversation-history", "Second historical turn. ".repeat(120), { role: "assistant" }),
      requestBlock("previous-history-3", "prior-conversation-history", "Third historical turn. ".repeat(120), { role: "user" }),
      requestBlock("previous-history-4", "prior-conversation-history", "Fourth historical turn. ".repeat(120), { role: "assistant" }),
      requestBlock("previous-current", "current-user-input", "continue with the task", { role: "user" }),
    ];
    const currentBlocks = [
      requestBlock("current-system", "harness-system-context", "You are operating inside pi.", { source: "pi-bedrock-system", hash: "stable-system" }),
      requestBlock("current-summary", "prior-conversation-history", "Summary of the conversation so far: the user asked for a filesystem refactor and the agent edited two modules.", { role: "user" }),
      requestBlock("current-current", "current-user-input", "continue with the task", { role: "user" }),
    ];

    const assessment = detectCompaction({
      summary: summary("current-pi", currentBlocks, { requestByteSize: 4_000, inputTokens: 1_100 }),
      requestBlocks: currentBlocks,
      previousSummary: summary("previous-pi", previousBlocks, { requestByteSize: 16_000, inputTokens: 5_600 }),
      previousRequestBlocks: previousBlocks,
    });

    expect(assessment).toMatchObject({
      status: "candidate",
      source: "pi_pattern",
      confidence: "high",
      label: "Pi compaction candidate",
    });
    expect(assessment.reasons).toContain("pi_request_context_profile");
    expect(assessment.reasons).toContain("summary_like_history_block");
    expect(assessment.reasons).toContain("prior_history_byte_drop");
    expect(assessment.evidence.summaryLikeBlockIds).toEqual(["current-summary"]);
  });

  test("labels Pi summarization requests as compaction events without a prior transition", () => {
    const currentBlocks = [
      requestBlock(
        "current-conversation",
        "current-user-input",
        `<conversation>\n[User]: ${"Build the extension plan. ".repeat(900)}\n[Assistant]: ${"Edited files and tested. ".repeat(900)}\n</conversation>`,
        { role: "user" },
      ),
      requestBlock(
        "current-summary-system",
        "harness-system-context",
        "You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified. Do NOT continue the conversation.",
        { source: "pi-bedrock-system" },
      ),
    ];

    const assessment = detectCompaction({
      summary: summary("current-summarization", currentBlocks),
      requestBlocks: currentBlocks,
      previousSummary: null,
      previousRequestBlocks: [],
    });

    expect(assessment).toMatchObject({
      status: "candidate",
      source: "summarization_request",
      confidence: "high",
      label: "Compaction summarization request",
    });
    expect(assessment.reasons).toEqual([
      "summarization_system_prompt",
      "conversation_wrapper_input",
      "large_current_user_input",
    ]);
  });

  test("labels generic structural compaction candidates separately from Pi patterns", () => {
    const previousBlocks = [
      requestBlock("previous-system", "harness-system-context", "stable generic system context", { source: "generic", hash: "stable-system" }),
      requestBlock("previous-history-1", "prior-conversation-history", "Long generic history. ".repeat(140), { source: "generic", role: "user" }),
      requestBlock("previous-history-2", "prior-conversation-history", "Long generic reply. ".repeat(140), { source: "generic", role: "assistant" }),
      requestBlock("previous-history-3", "prior-conversation-history", "More generic history. ".repeat(140), { source: "generic", role: "user" }),
      requestBlock("previous-history-4", "prior-conversation-history", "More generic reply. ".repeat(140), { source: "generic", role: "assistant" }),
      requestBlock("previous-current", "current-user-input", "next request", { source: "generic", role: "user" }),
    ];
    const currentBlocks = [
      requestBlock("current-system", "harness-system-context", "stable generic system context", { source: "generic", hash: "stable-system" }),
      requestBlock("current-summary", "prior-conversation-history", "Context summary: earlier turns established the implementation constraints.", { source: "generic", role: "user" }),
      requestBlock("current-current", "current-user-input", "next request", { source: "generic", role: "user" }),
    ];

    const assessment = detectCompaction({
      summary: summary("current-generic", currentBlocks, { requestByteSize: 5_000, inputTokens: 1_600 }),
      requestBlocks: currentBlocks,
      previousSummary: summary("previous-generic", previousBlocks, { requestByteSize: 18_000, inputTokens: 6_000 }),
      previousRequestBlocks: previousBlocks,
    });

    expect(assessment.status).toBe("candidate");
    expect(assessment.source).toBe("heuristic");
    expect(assessment.label).toBe("Heuristic compaction candidate");
    expect(assessment.reasons).not.toContain("pi_request_context_profile");
  });

  test("does not treat summary-like current user input as compaction evidence", () => {
    const previousBlocks = [
      requestBlock("previous-system", "harness-system-context", "stable generic system context", { source: "generic", hash: "stable-system" }),
      requestBlock("previous-current", "current-user-input", "start", { source: "generic", role: "user" }),
    ];
    const currentBlocks = [
      requestBlock("current-system", "harness-system-context", "stable generic system context", { source: "generic", hash: "stable-system" }),
      requestBlock("current-current", "current-user-input", "Please summarize the current file.", { source: "generic", role: "user" }),
    ];

    const assessment = detectCompaction({
      summary: summary("current-no-history", currentBlocks, { requestByteSize: 1_000, inputTokens: 300 }),
      requestBlocks: currentBlocks,
      previousSummary: summary("previous-no-history", previousBlocks, { requestByteSize: 1_000, inputTokens: 300 }),
      previousRequestBlocks: previousBlocks,
    });

    expect(assessment.status).toBe("none");
    expect(assessment.evidence.summaryLikeBlockIds).toEqual([]);
  });

  test("does not flag summary-like history without real context drop evidence", () => {
    const previousBlocks = [
      requestBlock("previous-system", "harness-system-context", "You are operating inside pi.", { source: "pi-bedrock-system", hash: "stable-system" }),
      requestBlock("previous-history", "prior-conversation-history", "Long prior context. ".repeat(180), { role: "user" }),
      requestBlock("previous-current", "current-user-input", "continue", { role: "user" }),
    ];
    const currentBlocks = [
      requestBlock("current-system", "harness-system-context", "You are operating inside pi.", { source: "pi-bedrock-system", hash: "stable-system" }),
      requestBlock("current-history", "prior-conversation-history", "Summary of the conversation so far, but no meaningful byte drop. ".repeat(80), { role: "user" }),
      requestBlock("current-current", "current-user-input", "continue", { role: "user" }),
    ];

    const assessment = detectCompaction({
      summary: summary("current-no-drop", currentBlocks, { requestByteSize: 14_000, inputTokens: 4_800 }),
      requestBlocks: currentBlocks,
      previousSummary: summary("previous-no-drop", previousBlocks, { requestByteSize: 15_000, inputTokens: 5_000 }),
      previousRequestBlocks: previousBlocks,
    });

    expect(assessment.status).toBe("none");
    expect(assessment.reasons).toEqual([]);
  });
});

function fixtureEvents(): SpoolEvent[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => SpoolEventSchema.parse(JSON.parse(line) as unknown));
}

function requestBlocks(blocks: readonly NormalizedBlock[]): NormalizedBlock[] {
  return blocks.filter((block) => block.direction === "request");
}

function summaryFromNormalizedCall(call: NormalizedProviderCall): SpyCallSummary {
  const request = requestBlocks(call.blocks);
  const response = call.blocks.filter((block) => block.direction === "response");
  return {
    call: call.call,
    durationMs: call.call.completed_at === undefined ? null : Math.round((call.call.completed_at - call.call.started_at) * 1000),
    usage: usageSummary(call.usage[0]),
    requestBlockCount: request.length,
    responseBlockCount: response.length,
    requestByteSize: byteSize(request),
    responseByteSize: byteSize(response),
    cacheMarkerCount: call.blocks.filter((block) => block.cache_marker).length,
    streamEventCount: call.streamEvents.length,
    rawPayloadCount: call.rawPayloads.length,
  };
}

function summary(
  id: string,
  blocks: readonly NormalizedBlock[],
  options: { readonly requestByteSize?: number | undefined; readonly inputTokens?: number | undefined } = {},
): SpyCallSummary {
  const request = requestBlocks(blocks);
  const response = blocks.filter((block) => block.direction === "response");
  return {
    call: {
      id,
      provider: "bedrock",
      operation: "converse-stream",
      model_id: "us.anthropic.claude-sonnet-4-6",
      status: "complete",
      started_at: id.startsWith("previous") ? 1 : 2,
      completed_at: id.startsWith("previous") ? 1.5 : 2.5,
      status_code: 200,
      request_flow_id: `${id}-request`,
      response_flow_id: `${id}-response`,
      request_content_hash: `${id}-request-hash`,
      response_content_hash: `${id}-response-hash`,
    } satisfies ProviderCall,
    durationMs: 500,
    usage: {
      inputTokens: options.inputTokens ?? null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: options.inputTokens ?? null,
    },
    requestBlockCount: request.length,
    responseBlockCount: response.length,
    requestByteSize: options.requestByteSize ?? byteSize(request),
    responseByteSize: byteSize(response),
    cacheMarkerCount: request.filter((block) => block.cache_marker).length,
    streamEventCount: 0,
    rawPayloadCount: 0,
  };
}

function usageSummary(record: NormalizedProviderCall["usage"][number] | undefined): SpyUsageSummary {
  return {
    inputTokens: record?.input_tokens ?? null,
    outputTokens: record?.output_tokens ?? null,
    cacheReadTokens: record?.cache_read_tokens ?? null,
    cacheWriteTokens: record?.cache_write_tokens ?? null,
    totalTokens: record?.total_tokens ?? null,
  };
}

function requestBlock(
  id: string,
  kind: NormalizedBlock["kind"],
  text: string,
  options: {
    readonly source?: string | undefined;
    readonly role?: string | undefined;
    readonly hash?: string | undefined;
  } = {},
): NormalizedBlock {
  return {
    id,
    call_id: id.startsWith("previous") ? "previous-call" : "current-call",
    direction: "request",
    ordinal: Number(id.replace(/\D/g, "")) || 0,
    role: options.role,
    kind,
    source: options.source ?? "pi-bedrock-message",
    provider_path: `$.${id}`,
    text,
    char_size: text.length,
    byte_size: new TextEncoder().encode(text).length,
    content_hash: options.hash ?? `${id}-hash`,
    cache_marker: false,
  };
}

function byteSize(blocks: readonly NormalizedBlock[]): number {
  return blocks.reduce((total, block) => total + block.byte_size, 0);
}
