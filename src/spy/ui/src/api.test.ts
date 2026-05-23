import { afterEach, describe, expect, test } from "bun:test";
import { SpyServiceHealthSchema } from "../../api-contracts.ts";
import { SpyApiClient, callsUrl, fetchJson, parseSseEventData, streamEventsUrl } from "./api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("spy UI API helpers", () => {
  test("builds call list URLs with since and cursors", () => {
    expect(callsUrl({ since: 123, cursor: "next", limit: 25 })).toBe("/api/calls?limit=25&cursor=next&since=123");
  });

  test("uses search endpoint when query text is present", () => {
    expect(callsUrl({ since: 123, search: "fixture capture" })).toBe("/api/search?limit=100&q=fixture+capture");
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

  test("validates SSE payloads by event name", () => {
    expect(parseSseEventData("hello", JSON.stringify({ id: 1 }))).toEqual({ id: 1 });
    expect(parseSseEventData("health", JSON.stringify(sampleHealth))).toEqual(sampleHealth);
    expect(parseSseEventData("calls-changed", JSON.stringify({ result: sampleIngestResult }))).toEqual({ result: sampleIngestResult });
    expect(parseSseEventData("calls-changed", JSON.stringify({ retention: sampleRetentionResult }))).toEqual({ retention: sampleRetentionResult });
    expect(parseSseEventData("cleared", JSON.stringify(sampleClearResult))).toEqual(sampleClearResult);
  });

  test("rejects malformed SSE payloads without unchecked casts", () => {
    expect(() => parseSseEventData("health", "{")).toThrow("invalid SSE health JSON");
    expect(() => parseSseEventData("health", JSON.stringify({ ok: true }))).toThrow("invalid response from SSE health payload");
    expect(() => parseSseEventData("calls-changed", JSON.stringify({ unknown: true }))).toThrow("invalid response from SSE calls-changed payload");
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

const sampleHealth = {
  ok: true,
  service: {
    bind: "127.0.0.1",
    port: 6174,
    retentionDays: 7,
    maxBytes: 6_442_450_944,
    spoolMaxBytes: 1_073_741_824,
    storeRaw: false,
    staticAssets: true,
  },
  store: {
    schemaVersion: 2,
    dbSizeBytes: 4096,
    dbUsedBytes: 2048,
    spoolSizeBytes: 0,
    providerCallCount: 1,
    pendingCallCount: 0,
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
