import { afterEach, describe, expect, test } from "bun:test";
import { SpyCallDetailSchema, SpyServiceHealthSchema, SpyTokenCountResponseSchema } from "../../api-contracts.ts";
import {
  SpyApiClient,
  callsUrl,
  fetchJson,
  initialSinceFromLocation,
  initialTimelineRangeFromLocation,
  parseSseEventData,
  resolveTimelineSince,
  streamEventsUrl,
  timelineRangeUrl,
} from "./api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("spy UI API helpers", () => {
  test("parses fixed since URLs separately from live mode", () => {
    const now = (): number => 5000;

    expect(initialTimelineRangeFromLocation({ search: "" }, now)).toEqual({ preset: "live", since: 5000 });
    expect(initialTimelineRangeFromLocation({ search: "?since=0" }, now)).toEqual({ preset: "custom", since: 0 });
    expect(initialTimelineRangeFromLocation({ search: "?preset=10m&since=123" }, now)).toEqual({ preset: "10m", since: 4400 });
    expect(initialTimelineRangeFromLocation({ search: "?preset=1h&since=123" }, now)).toEqual({ preset: "1h", since: 1400 });
    expect(initialTimelineRangeFromLocation({ search: "?preset=custom&since=123" }, now)).toEqual({ preset: "custom", since: 123 });
    expect(initialTimelineRangeFromLocation({ search: "?preset=live&since=123" }, now)).toEqual({ preset: "live", since: 5000 });
    expect(initialTimelineRangeFromLocation({ search: "?preset=nope&since=123" }, now)).toEqual({ preset: "custom", since: 123 });
    expect(initialTimelineRangeFromLocation({ search: "?since=bad" }, now)).toEqual({ preset: "live", since: 5000 });
    expect(initialTimelineRangeFromLocation({ search: "?preset=10m&since=bad" }, now)).toEqual({ preset: "10m", since: 4400 });
    expect(initialSinceFromLocation({ search: "?since=0" }, now)).toBe(0);
  });

  test("resolves dynamic timeline presets from the current clock", () => {
    const now = (): number => 1779579848;
    const todayStart = new Date(now() * 1000);
    todayStart.setHours(0, 0, 0, 0);

    expect(resolveTimelineSince("live", 123, now)).toBe(1779579848);
    expect(resolveTimelineSince("10m", 123, now)).toBe(1779579248);
    expect(resolveTimelineSince("1h", 123, now)).toBe(1779576248);
    expect(resolveTimelineSince("today", 123, now)).toBe(Math.floor(todayStart.getTime() / 1000));
    expect(resolveTimelineSince("custom", 123, now)).toBe(123);
  });

  test("builds canonical timeline range URLs", () => {
    expect(timelineRangeUrl("10m", 123, "http://spy.local/?since=0&view=timeline#calls")).toBe("/?view=timeline&preset=10m#calls");
    expect(timelineRangeUrl("1h", 123, "http://spy.local/?since=0&view=timeline#calls")).toBe("/?view=timeline&preset=1h#calls");
    expect(timelineRangeUrl("today", 123, "http://spy.local/?since=0&view=timeline#calls")).toBe("/?view=timeline&preset=today#calls");
    expect(timelineRangeUrl("custom", 123, "http://spy.local/?since=0&view=timeline#calls")).toBe("/?since=123&view=timeline&preset=custom#calls");
    expect(timelineRangeUrl("live", 123, "http://spy.local/?since=0&view=timeline#calls")).toBe("/?view=timeline&preset=live#calls");
  });

  test("builds call list URLs with since and cursors", () => {
    expect(callsUrl({ since: 123, cursor: "next", limit: 25 })).toBe("/api/calls?limit=25&cursor=next&since=123");
  });

  test("uses search endpoint when query text is present", () => {
    expect(callsUrl({ since: 123, search: "fixture capture" })).toBe("/api/search?limit=100&since=123&q=fixture+capture");
  });

  test("preserves timeline filters in call and search URLs", () => {
    const query = {
      since: 123,
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      operation: "converse-stream",
      status: "complete",
    };
    expect(callsUrl(query)).toBe(
      "/api/calls?limit=100&since=123&provider=bedrock&model_id=us.anthropic.claude-sonnet-4-6&operation=converse-stream&status=complete",
    );
    expect(callsUrl({ ...query, search: "fixture capture" })).toBe(
      "/api/search?limit=100&since=123&provider=bedrock&model_id=us.anthropic.claude-sonnet-4-6&operation=converse-stream&status=complete&q=fixture+capture",
    );
  });

  test("encodes stream event call ids", () => {
    expect(streamEventsUrl("call/one", "cursor:1")).toBe("/api/calls/call%2Fone/stream-events?limit=100&cursor=cursor%3A1");
  });

  test("validates direct JSON responses with endpoint context", async () => {
    mockJson(sampleHealth);
    expect(await fetchJson("/api/health", SpyServiceHealthSchema)).toEqual(sampleHealth);

    mockJson({ ok: true });
    await expectRejectsWith(() => fetchJson("/api/health", SpyServiceHealthSchema), "invalid response from /api/health");
  });

  test("validates every client endpoint response", async () => {
    const client = new SpyApiClient();
    const cases: readonly {
      readonly name: string;
      readonly endpoint: string;
      readonly valid: unknown;
      readonly run: () => Promise<unknown>;
    }[] = [
      {
        name: "health",
        endpoint: "/api/health",
        valid: sampleHealth,
        run: () => client.health(),
      },
      {
        name: "call summaries",
        endpoint: "/api/calls?limit=100",
        valid: { items: [sampleSummary], nextCursor: "next" },
        run: () => client.calls({}),
      },
      {
        name: "call detail",
        endpoint: "/api/calls/call%2Fone",
        valid: sampleDetail,
        run: () => client.callDetail("call/one"),
      },
      {
        name: "call diff",
        endpoint: "/api/calls/call%2Fone/diff",
        valid: sampleDiff,
        run: () => client.callDiff("call/one"),
      },
      {
        name: "stream events",
        endpoint: "/api/calls/call%2Fone/stream-events?limit=100",
        valid: { items: [sampleStreamEvent], nextCursor: "stream-next" },
        run: () => client.streamEvents("call/one"),
      },
      {
        name: "token count",
        endpoint: "/api/token-count",
        valid: sampleTokenCountResponse,
        run: () => client.tokenCount({
          mode: "provider",
          subjects: [{ type: "block", callId: "call-one", blockId: "block-one" }],
        }),
      },
      {
        name: "clear data",
        endpoint: "/api/clear",
        valid: sampleClearResult,
        run: () => client.clearData(),
      },
    ];

    for (const scenario of cases) {
      mockJson(scenario.valid);
      expect(await scenario.run()).toEqual(scenario.valid);

      mockJson({ invalid: true });
      await expectRejectsWith(scenario.run, `invalid response from ${scenario.endpoint}`);
    }
  });

  test("requires request composition in call details", () => {
    const missingComposition: Record<string, unknown> = { ...sampleDetail };
    delete missingComposition.requestComposition;
    expect(SpyCallDetailSchema.safeParse(missingComposition).success).toBe(false);
  });

  test("requires compaction assessment in call details", () => {
    const missingCompaction: Record<string, unknown> = { ...sampleDetail };
    delete missingCompaction.compaction;
    expect(SpyCallDetailSchema.safeParse(missingCompaction).success).toBe(false);
  });

  test("validates token count responses", () => {
    expect(SpyTokenCountResponseSchema.safeParse(sampleTokenCountResponse).success).toBe(true);
    expect(SpyTokenCountResponseSchema.safeParse({ mode: "provider", records: [{ tokens: 1 }] }).success).toBe(false);
  });

  test("requires explicit V1 health fields", () => {
    const missingEnabled = {
      ...sampleHealth,
      service: { ...sampleHealth.service },
    };
    delete (missingEnabled.service as Record<string, unknown>).enabled;
    expect(SpyServiceHealthSchema.safeParse(missingEnabled).success).toBe(false);

    const missingDroppedCaptureCount = {
      ...sampleHealth,
      store: { ...sampleHealth.store },
    };
    delete (missingDroppedCaptureCount.store as Record<string, unknown>).droppedCaptureCount;
    expect(SpyServiceHealthSchema.safeParse(missingDroppedCaptureCount).success).toBe(false);

    const missingLastIngestAt = {
      ...sampleHealth,
      store: { ...sampleHealth.store },
    };
    delete (missingLastIngestAt.store as Record<string, unknown>).lastIngestAt;
    expect(SpyServiceHealthSchema.safeParse(missingLastIngestAt).success).toBe(false);
  });

  test("validates SSE payloads by event name", () => {
    expect(parseSseEventData("hello", JSON.stringify({ id: 1 }))).toEqual({ id: 1 });
    expect(parseSseEventData("health", JSON.stringify(sampleHealth))).toEqual(sampleHealth);
    expect(parseSseEventData("calls-changed", JSON.stringify({ result: sampleIngestResult }))).toEqual({ result: sampleIngestResult });
    expect(parseSseEventData("calls-changed", JSON.stringify({ retention: sampleRetentionResult }))).toEqual({ retention: sampleRetentionResult });
    expect(parseSseEventData("token-counts-changed", JSON.stringify({ callId: "call-one", records: sampleTokenCountResponse.records })))
      .toEqual({ callId: "call-one", records: [...sampleTokenCountResponse.records] });
    expect(parseSseEventData("cleared", JSON.stringify(sampleClearResult))).toEqual(sampleClearResult);
  });

  test("rejects malformed SSE payloads without unchecked casts", () => {
    expect(() => parseSseEventData("health", "{")).toThrow("invalid SSE health JSON");
    expect(() => parseSseEventData("health", JSON.stringify({ ok: true }))).toThrow("invalid response from SSE health payload");
    expect(() => parseSseEventData("calls-changed", JSON.stringify({ unknown: true }))).toThrow("invalid response from SSE calls-changed payload");
    expect(() => parseSseEventData("token-counts-changed", JSON.stringify({ callId: "call-one", records: [] }))).toThrow("invalid response from SSE token-counts-changed payload");
  });
});

function mockJson(payload: unknown): void {
  const mockedFetch = (): Promise<Response> => Promise.resolve(new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  }));
  globalThis.fetch = Object.assign(mockedFetch, { preconnect: originalFetch.preconnect });
}

async function expectRejectsWith(run: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new Error(`expected Error rejection, got ${String(error)}`, { cause: error });
    }
    expect(error.message).toContain(message);
    return;
  }
  throw new Error(`expected rejection containing ${message}`);
}

const sampleCall = {
  id: "call-one",
  provider: "bedrock",
  operation: "converse",
  model_id: "us.anthropic.claude-sonnet-4-6",
  status: "complete",
  started_at: 1,
  completed_at: 2,
  status_code: 200,
  request_flow_id: "flow-one",
  response_flow_id: "flow-one",
  request_content_hash: "request-hash",
  response_content_hash: "response-hash",
} as const;

const sampleUsageSummary = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  totalTokens: 18,
} as const;

const sampleSummary = {
  call: sampleCall,
  durationMs: 1000,
  usage: sampleUsageSummary,
  requestBlockCount: 1,
  responseBlockCount: 1,
  requestByteSize: 25,
  responseByteSize: 14,
  cacheMarkerCount: 1,
  streamEventCount: 1,
  rawPayloadCount: 0,
} as const;

const sampleRequestComposition = {
  totalBlockCount: 1,
  totalMessageCount: 1,
  totalCharSize: 5,
  totalByteSize: 5,
  sections: [{
    kind: "current-user-input",
    present: true,
    blockCount: 1,
    messageCount: 1,
    charSize: 5,
    byteSize: 5,
  }],
  toolDefinitionCount: 0,
  toolSchemaCharSize: 0,
  toolSchemaByteSize: 0,
  cacheMarkerCount: 0,
  cacheMarkerCharSize: 0,
  cacheMarkerByteSize: 0,
  mediaSummaryCount: 0,
  mediaSummaryCharSize: 0,
  mediaSummaryByteSize: 0,
  usage: sampleUsageSummary,
} as const;

const sampleHealth = {
  ok: true,
  service: {
    enabled: true,
    bind: "127.0.0.1",
    port: 6174,
    retentionDays: 7,
    maxBytes: 6_442_450_944,
    spoolMaxBytes: 1_073_741_824,
    storeRaw: false,
    tokenCountMode: "provider",
    staticAssets: true,
  },
  store: {
    schemaVersion: 2,
    dbSizeBytes: 4096,
    dbUsedBytes: 2048,
    spoolSizeBytes: 0,
    providerCallCount: 1,
    pendingCallCount: 0,
    droppedCaptureCount: 1,
    lastIngestAt: 1,
    counters: { captures_dropped: 1 },
    metadata: { last_ingest_at: "1" },
  },
} as const;

const sampleBlock = {
  id: "block-one",
  call_id: "call-one",
  direction: "request",
  ordinal: 0,
  role: "user",
  kind: "current-user-input",
  source: "bedrock",
  provider_path: "messages.0.content.0.text",
  text: "hello",
  char_size: 5,
  byte_size: 5,
  content_hash: "block-hash",
  cache_marker: false,
} as const;

const sampleDetail = {
  summary: sampleSummary,
  requestComposition: sampleRequestComposition,
  compaction: {
    status: "none",
    source: "none",
    confidence: "none",
    label: "No compaction candidate",
    reasons: ["no_previous_comparable_call"],
    evidence: {
      currentCallId: "call-one",
      previousCallId: null,
      currentRequestByteSize: 25,
      previousRequestByteSize: null,
      currentInputTokens: 10,
      previousInputTokens: null,
      currentContextTokens: 13,
      previousContextTokens: null,
      currentPriorHistoryByteSize: 0,
      previousPriorHistoryByteSize: null,
      currentPriorHistoryBlockCount: 0,
      previousPriorHistoryBlockCount: null,
      summaryLikeBlockIds: [],
      newHistoryBlockIds: [],
      changedHistoryBlockIds: [],
      repeatedContextBlockCount: 0,
      changedContextBlockCount: 0,
    },
  },
  tokenCounts: [{
    subjectType: "block",
    callId: "call-one",
    blockId: "block-one",
    direction: "request",
    kind: "current-user-input",
    sourceHash: "block-hash",
    modelId: "us.anthropic.claude-sonnet-4-6",
    tokens: 2,
    provenance: "provider_counted",
    countedAt: 1,
  }],
  httpEvents: [{
    id: "http-call-one-request",
    call_id: "call-one",
    direction: "request",
    observed_at: 1,
    host: "bedrock-runtime.us-east-1.amazonaws.com",
    method: "POST",
    path: "/model/us.anthropic.claude-sonnet-4-6/converse",
    headers: [["content-type", "application/json"]],
  }],
  blocks: [sampleBlock],
  usageRecords: [{
    id: "usage-one",
    call_id: "call-one",
    source: "provider-reported",
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 2,
    cache_write_tokens: 1,
    total_tokens: 18,
  }],
  rawPayloads: [],
} as const;

const sampleTokenCountResponse = {
  mode: "provider",
  records: [{
    subjectType: "block",
    callId: "call-one",
    blockId: "block-one",
    direction: "request",
    kind: "current-user-input",
    sourceHash: "block-hash",
    modelId: "us.anthropic.claude-sonnet-4-6",
    tokens: 2,
    provenance: "provider_counted",
    countedAt: 2,
  }],
} as const;

const sampleDiff = {
  call: sampleSummary,
  previousCall: null,
  blocks: [{
    block: sampleBlock,
    classification: "new",
  }],
} as const;

const sampleStreamEvent = {
  id: "stream-one",
  call_id: "call-one",
  ordinal: 0,
  event_type: "message_start",
  headers: {},
  payload: { type: "message_start" },
  observed_at: 1,
} as const;

const sampleClearResult = {
  deletedSpoolFiles: 0,
  clearGeneration: 1,
  clearBaselineTs: 1,
} as const;

const sampleIngestResult = {
  attempted: 1,
  ingested: 1,
  deleted: 1,
  deferred: 0,
  malformed: 0,
  errors: 0,
} as const;

const sampleRetentionResult = {
  deletedByAge: 0,
  deletedBySize: 0,
  vacuumed: false,
} as const;
