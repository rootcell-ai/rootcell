import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { bedrockCallIdForFlow } from "./bedrock.ts";
import { cursorCallIdForFlow } from "./cursor.ts";
import { currentSpySchemaVersion } from "./migrations.ts";
import {
  SpoolEventSchema,
  SpoolRequestEventSchema,
  SpoolResponseEventSchema,
  SpoolStreamChunkEventSchema,
  type SpoolEvent,
  type SpoolRequestEvent,
  type SpoolResponseEvent,
  type SpoolStreamChunkEvent,
} from "./schemas.ts";
import { openSpyStore, type SpyCallDetail, type SpyStore } from "./store.ts";

const FIXTURE_PATH = new URL("./fixtures/bedrock-pi-us-sonnet-4-6.ndjson", import.meta.url);

interface CountRow {
  readonly count: number;
}

interface StatusRow {
  readonly status: string;
}

interface ValueRow {
  readonly value: string;
}

interface TestStore {
  readonly root: string;
  readonly dbPath: string;
  readonly spoolDir: string;
  readonly store: SpyStore;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureEvents(): SpoolEvent[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => SpoolEventSchema.parse(JSON.parse(line) as unknown));
}

function fixturePair(flowId = "fixture-flow-simple"): readonly [SpoolRequestEvent, SpoolResponseEvent] {
  const events = fixtureEvents();
  const request = events.find((event): event is SpoolRequestEvent => event.direction === "request" && event.flow_id === flowId);
  const response = events.find((event): event is SpoolResponseEvent => event.direction === "response" && event.flow_id === flowId);
  if (request === undefined || response === undefined) {
    throw new Error(`missing fixture pair ${flowId}`);
  }
  return [request, response];
}

function createTestStore(options: {
  readonly storeRaw?: boolean | undefined;
  readonly retentionDays?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly now?: (() => number) | undefined;
} = {}): TestStore {
  const root = mkdtempSync(join(tmpdir(), "rootcell-spy-store-"));
  tempRoots.push(root);
  const dbPath = join(root, "spy.sqlite");
  const spoolDir = join(root, "spool");
  const store = openSpyStore({ dbPath, spoolDir, ...options });
  return { root, dbPath, spoolDir, store };
}

function writeSpoolEvents(spoolDir: string, events: readonly SpoolEvent[]): void {
  events.forEach((event, index) => {
    writeFileSync(
      join(spoolDir, `${String(index).padStart(3, "0")}-${event.direction}-${flowIdForName(event)}.json`),
      `${JSON.stringify(event)}\n`,
    );
  });
}

function flowIdForName(event: SpoolEvent): string {
  return "flow_id" in event && event.flow_id !== undefined ? event.flow_id : "no-flow";
}

function countRows(dbPath: string, table: string, where?: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const sql = where === undefined ? `SELECT COUNT(*) AS count FROM ${table}` : `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`;
    const row = db.query(sql).get() as CountRow | null;
    return row?.count ?? 0;
  } finally {
    db.close();
  }
}

function statusForCall(dbPath: string, callId: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT status FROM provider_call WHERE id = ?").get(callId) as StatusRow | null;
    if (row === null) {
      throw new Error(`missing call ${callId}`);
    }
    return row.status;
  } finally {
    db.close();
  }
}

function metadataValue(dbPath: string, key: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT value FROM service_metadata WHERE key = ?").get(key) as ValueRow | null;
    if (row === null) {
      throw new Error(`missing metadata ${key}`);
    }
    return row.value;
  } finally {
    db.close();
  }
}

function retagRequest(event: SpoolRequestEvent, flowId: string, ts: number): SpoolRequestEvent {
  return SpoolRequestEventSchema.parse({ ...event, flow_id: flowId, ts });
}

function retagResponse(event: SpoolResponseEvent, flowId: string, ts: number): SpoolResponseEvent {
  return SpoolResponseEventSchema.parse({ ...event, flow_id: flowId, ts });
}

function requestVariant(
  event: SpoolRequestEvent,
  overrides: Partial<Pick<SpoolRequestEvent, "flow_id" | "ts" | "model_id" | "operation">>,
): SpoolRequestEvent {
  return SpoolRequestEventSchema.parse({ ...event, ...overrides });
}

function syntheticBedrockRequest(flowId: string, ts: number, body: Record<string, unknown>): SpoolRequestEvent {
  return SpoolRequestEventSchema.parse({
    version: 1,
    ts,
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
  });
}

function syntheticCursorRequest(flowId: string, ts: number, body: Record<string, unknown>): SpoolRequestEvent {
  return SpoolRequestEventSchema.parse({
    version: 1,
    ts,
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
  });
}

function syntheticCursorResponse(flowId: string, ts: number, body: Record<string, unknown>): SpoolResponseEvent {
  return SpoolResponseEventSchema.parse({
    version: 1,
    ts,
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
  });
}

function syntheticCursorStreamChunk(flowId: string, ts: number, chunkIndex: number, body: Buffer): SpoolStreamChunkEvent {
  return SpoolStreamChunkEventSchema.parse({
    version: 1,
    ts,
    direction: "stream-chunk",
    flow_id: flowId,
    provider: "cursor",
    operation: "StreamUnifiedChat",
    model_id: "Composer 2.5",
    host: "api2.cursor.sh",
    method: "POST",
    path: "/aiserver.v1.AiService/StreamUnifiedChat",
    headers: [["content-type", "application/connect+proto"]],
    chunk_index: chunkIndex,
    body_b64: body.toString("base64"),
  });
}

function connectFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
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

function protoVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([protoVarint(fieldNumber * 8), protoVarint(value)]);
}

function protoMessageField(fieldNumber: number, message: Buffer): Buffer {
  return Buffer.concat([protoVarint(fieldNumber * 8 + 2), protoVarint(message.length), message]);
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

function responseVariant(
  event: SpoolResponseEvent,
  overrides: Partial<Pick<SpoolResponseEvent, "flow_id" | "ts" | "model_id" | "operation" | "status_code">>,
): SpoolResponseEvent {
  return SpoolResponseEventSchema.parse({ ...event, ...overrides });
}

function firstFixtureEvent(): SpoolEvent {
  const event = fixtureEvents()[0];
  if (event === undefined) {
    throw new Error("missing first fixture event");
  }
  return event;
}

function requiredDetail(store: SpyStore, callId: string): SpyCallDetail {
  const detail = store.getCallDetail(callId);
  if (detail === null) {
    throw new Error(`missing detail ${callId}`);
  }
  return detail;
}

function compositionSection(
  detail: SpyCallDetail,
  kind: SpyCallDetail["requestComposition"]["sections"][number]["kind"],
): SpyCallDetail["requestComposition"]["sections"][number] {
  const section = detail.requestComposition.sections.find((candidate) => candidate.kind === kind);
  if (section === undefined) {
    throw new Error(`missing composition section ${kind}`);
  }
  return section;
}

describe("spy SQLite store", () => {
  test("exposes explicit health fields for ingest time and dropped captures", () => {
    let now = 100;
    const { spoolDir, store } = createTestStore({ now: () => now });
    try {
      let health = store.getHealthSnapshot();
      expect(health.droppedCaptureCount).toBe(0);
      expect(health.lastIngestAt).toBeNull();

      writeSpoolEvents(spoolDir, fixturePair());
      expect(store.ingestSpoolBatch()).toMatchObject({ ingested: 2 });
      health = store.getHealthSnapshot();
      expect(health.droppedCaptureCount).toBe(0);
      expect(health.lastIngestAt).toBe(100);

      now = 200;
      writeSpoolEvents(spoolDir, [
        SpoolEventSchema.parse({
          version: 1,
          ts: 2000,
          direction: "dropped",
          provider: "bedrock",
          reason: "spool_full",
          dropped_count: 3,
        }),
      ]);
      expect(store.ingestSpoolBatch()).toMatchObject({ ingested: 1 });
      health = store.getHealthSnapshot();
      expect(health.droppedCaptureCount).toBe(3);
      expect(health.lastIngestAt).toBe(200);
    } finally {
      store.close();
    }
  });

  test("ingests Bedrock fixture spool files into normalized SQLite records", () => {
    const { dbPath, spoolDir, store } = createTestStore();
    try {
      writeSpoolEvents(spoolDir, fixtureEvents());

      expect(store.ingestSpoolBatch()).toEqual({
        attempted: 10,
        ingested: 10,
        deleted: 10,
        deferred: 0,
        malformed: 0,
        errors: 0,
      });

      expect(countRows(dbPath, "provider_call")).toBe(5);
      expect(countRows(dbPath, "http_event")).toBe(10);
      expect(countRows(dbPath, "normalized_block")).toBeGreaterThan(20);
      expect(countRows(dbPath, "usage_record")).toBe(5);
      expect(countRows(dbPath, "stream_event")).toBeGreaterThan(20);
      expect(countRows(dbPath, "raw_payload")).toBe(0);
      expect(countRows(dbPath, "http_event", "body_text IS NOT NULL OR body_b64 IS NOT NULL")).toBe(0);
      expect(countRows(dbPath, "schema_migration")).toBe(currentSpySchemaVersion());
      expect(readdirSync(spoolDir)).toEqual([]);

      const health = store.getHealthSnapshot();
      expect(health.counters.spool_request_events).toBe(5);
      expect(health.counters.spool_response_events).toBe(5);
      expect(health.providerCallCount).toBe(5);
      expect(health.pendingCallCount).toBe(0);
      expect(health.droppedCaptureCount).toBe(0);
      expect(health.lastIngestAt).not.toBeNull();
    } finally {
      store.close();
    }
  });

  test("ingests Cursor provider request and response records", () => {
    const { dbPath, store } = createTestStore({ storeRaw: true });
    try {
      const request = syntheticCursorRequest("fixture-cursor-store", 3000, {
        model: "Composer 2.5",
        messages: [
          { role: "user", content: "RCSPY-CURSOR-ALPHA" },
          { role: "user", content: "RCSPY-CURSOR-BETA" },
        ],
      });
      const response = syntheticCursorResponse("fixture-cursor-store", 3001, {
        result: { text: "cursor-store-ok" },
        usage: { inputTokens: 50, outputTokens: 5 },
      });
      const placeholderRequest = { ...request, model_id: "cursor" } satisfies SpoolRequestEvent;

      store.persistRequest(placeholderRequest);
      expect(store.persistResponse(response)).toBe(true);

      const callId = cursorCallIdForFlow(request.flow_id);
      expect(statusForCall(dbPath, callId)).toBe("complete");
      const detail = requiredDetail(store, callId);
      expect(detail.summary.call.provider).toBe("cursor");
      expect(detail.summary.call.model_id).toBe("Composer 2.5");
      expect(detail.blocks.map((block) => block.text ?? "").join("\n")).toContain("RCSPY-CURSOR-BETA");
      expect(detail.blocks.map((block) => block.text ?? "").join("\n")).toContain("cursor-store-ok");
      expect(detail.rawPayloads).toHaveLength(2);
      expect(store.listCallSummaries({ provider: "cursor" }).items).toHaveLength(1);
      expect(store.listCallSummaries({ provider: "bedrock" }).items).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("backfills Cursor request context found in response streams", () => {
    const { store } = createTestStore();
    try {
      const request = syntheticCursorRequest("fixture-cursor-response-context", 3050, {});
      const response = syntheticCursorResponse("fixture-cursor-response-context", 3051, {
        events: [
          { role: "system", content: "Cursor system prompt from response stream" },
          { role: "user", content: "<user_info>\nWorkspace Path: /tmp/cursor\n</user_info>" },
          { role: "user", content: "<user_query>\nCursor current request from response stream\n</user_query>" },
          { role: "assistant", content: [{ type: "text", text: "cursor-response-context-ok" }] },
        ],
      });

      store.persistRequest(request);
      expect(store.persistResponse(response)).toBe(true);

      const detail = requiredDetail(store, cursorCallIdForFlow(request.flow_id));
      const requestBlocks = detail.blocks.filter((block) => block.direction === "request");
      expect(requestBlocks.some((block) =>
        block.kind === "harness-system-context"
        && block.text?.includes("Cursor system prompt from response stream") === true
      )).toBe(true);
      expect(requestBlocks.some((block) =>
        block.kind === "current-user-input"
        && block.text === "Cursor current request from response stream"
      )).toBe(true);
      expect(detail.requestComposition.sections.find((section) => section.kind === "current-user-input")?.present).toBe(true);
    } finally {
      store.close();
    }
  });

  test("includes Cursor protobuf context section metadata in request composition", () => {
    const { store } = createTestStore();
    try {
      const flowId = "fixture-cursor-context-section-metadata";
      const request = syntheticCursorRequest(flowId, 3060, {
        model: "Composer 2.5",
        prompt: "Cursor context metadata prompt",
      });
      const sectionEnvelope = Buffer.concat([
        protoMessageField(3, cursorContextSectionMetadata("tools", "Tool definitions", 5_884, 24_509)),
        protoMessageField(3, cursorContextSectionMetadata("conversation", "Conversation", 1_029, 3_083)),
      ]);
      const response = SpoolResponseEventSchema.parse({
        ...syntheticCursorResponse(flowId, 3061, {}),
        headers: [["content-type", "application/connect+proto"]],
        body_text: undefined,
        body_b64: connectFrame(sectionEnvelope).toString("base64"),
      });

      store.persistRequest(request);
      expect(store.persistResponse(response)).toBe(true);

      const detail = requiredDetail(store, cursorCallIdForFlow(flowId));
      expect(compositionSection(detail, "tool-definition")).toMatchObject({
        present: true,
        blockCount: 1,
        byteSize: 24_509,
      });
      expect(compositionSection(detail, "prior-conversation-history")).toMatchObject({
        present: true,
        blockCount: 1,
        byteSize: 3_083,
      });
      expect(detail.summary.requestByteSize).toBeGreaterThan(24_509 + 3_083);
      expect(detail.blocks.find((block) => block.kind === "tool-definition")?.source).toBe("cursor-response-context-metadata");
    } finally {
      store.close();
    }
  });

  test("reassembles Cursor stream chunks into raw wire events and derived usage when raw payload storage is off", () => {
    const { dbPath, spoolDir, store } = createTestStore();
    try {
      const flowId = "fixture-cursor-stream-chunks";
      const request = syntheticCursorRequest(flowId, 3060, {
        model: "Composer 2.5",
        prompt: "RCSPY-CURSOR-STREAM-CHUNK",
      });
      const usageMessage = Buffer.concat([
        protoVarintField(1, 10779),
        protoVarintField(2, 52),
        protoVarintField(3, 2848),
        protoVarintField(4, 0),
      ]);
      const responsePayload = protoMessageField(1, protoMessageField(14, usageMessage));
      const responseBytes = connectFrame(responsePayload);
      const chunkOne = syntheticCursorStreamChunk(flowId, 3061, 0, responseBytes.subarray(0, 4));
      const chunkTwo = syntheticCursorStreamChunk(flowId, 3062, 1, responseBytes.subarray(4));
      const response = syntheticCursorResponse(flowId, 3063, {});

      writeSpoolEvents(spoolDir, [request, chunkOne, chunkTwo, response]);

      expect(store.ingestSpoolBatch()).toMatchObject({ ingested: 4, deferred: 0 });

      const detail = requiredDetail(store, cursorCallIdForFlow(flowId));
      expect(detail.summary.usage).toMatchObject({
        inputTokens: 7931,
        outputTokens: 52,
        cacheReadTokens: 2848,
        cacheWriteTokens: 0,
        totalTokens: 10831,
      });
      expect(detail.usageRecords[0]?.raw).toMatchObject({
        raw_protobuf: {
          path: "$frame[0].1.14",
          wireInputTokens: 10779,
        },
      });
      const wireEvents = store.getStreamEvents(detail.summary.call.id).items;
      const wireEvent = wireEvents.find((event) => event.event_type === "connect-protobuf-frame");
      expect(wireEvent?.payload).toMatchObject({
        format: "connect",
        frameB64: responseBytes.toString("base64"),
        payloadB64: responsePayload.toString("base64"),
      });
      expect(JSON.stringify(wireEvent?.payload)).toContain("\"fieldNumber\":14");
      expect(detail.rawPayloads).toHaveLength(0);
      expect(countRows(dbPath, "raw_payload")).toBe(0);
      expect(countRows(dbPath, "stream_chunk_capture")).toBe(2);
    } finally {
      store.close();
    }
  });

  test("filters call summaries and normalized-text search by provider call fields", () => {
    const { store } = createTestStore();
    try {
      const [baseRequest, baseResponse] = fixturePair();
      const variants = [
        {
          flowId: "filter-a",
          ts: 100,
          modelId: "us.anthropic.claude-sonnet-4-6",
          operation: "converse-stream",
          statusCode: 200,
        },
        {
          flowId: "filter-b",
          ts: 200,
          modelId: "us.anthropic.claude-opus-4-1",
          operation: "converse-stream",
          statusCode: 200,
        },
        {
          flowId: "filter-c",
          ts: 300,
          modelId: "us.anthropic.claude-sonnet-4-6",
          operation: "converse",
          statusCode: 200,
        },
        {
          flowId: "filter-d",
          ts: 400,
          modelId: "us.anthropic.claude-sonnet-4-6",
          operation: "converse-stream",
          statusCode: 500,
        },
      ];

      for (const variant of variants) {
        store.persistRequest(requestVariant(baseRequest, {
          flow_id: variant.flowId,
          ts: variant.ts,
          model_id: variant.modelId,
          operation: variant.operation,
        }));
        expect(store.persistResponse(responseVariant(baseResponse, {
          flow_id: variant.flowId,
          ts: variant.ts + 1,
          model_id: variant.modelId,
          operation: variant.operation,
          status_code: variant.statusCode,
        }))).toBe(true);
      }

      expect(store.listCallSummaries({ provider: "bedrock" }).items).toHaveLength(4);
      expect(store.listCallSummaries({ modelId: "us.anthropic.claude-opus-4-1" }).items.map((item) => item.call.id))
        .toEqual(["call-filter-b"]);
      expect(store.listCallSummaries({ operation: "converse" }).items.map((item) => item.call.id))
        .toEqual(["call-filter-c"]);
      expect(store.listCallSummaries({ status: "error" }).items.map((item) => item.call.id))
        .toEqual(["call-filter-d"]);
      expect(store.listCallSummaries({
        since: 250,
        provider: "bedrock",
        modelId: "us.anthropic.claude-sonnet-4-6",
        operation: "converse-stream",
        status: "complete",
      }).items).toHaveLength(0);
      expect(store.listCallSummaries({
        since: 250,
        modelId: "us.anthropic.claude-sonnet-4-6",
        operation: "converse-stream",
        status: "error",
      }).items.map((item) => item.call.id)).toEqual(["call-filter-d"]);

      const searchPage = store.searchCallSummaries({
        query: "Fixture capture",
        since: 250,
        modelId: "us.anthropic.claude-sonnet-4-6",
        operation: "converse",
        status: "complete",
      });
      expect(searchPage.items.map((item) => item.call.id)).toEqual(["call-filter-c"]);
      expect(store.searchCallSummaries({
        query: "Fixture capture",
        since: 350,
        status: "complete",
      }).items).toHaveLength(0);
      expect(store.searchCallSummaries({
        query: "call-filter-b",
      }).items.map((item) => item.call.id)).toEqual(["call-filter-b"]);
      expect(store.searchCallSummaries({
        query: "opus",
      }).items.map((item) => item.call.id)).toEqual(["call-filter-b"]);
      expect(store.searchCallSummaries({
        query: "filter-c",
      }).items.map((item) => item.call.id)).toEqual(["call-filter-c"]);
      expect(store.searchCallSummaries({
        query: "sonnet",
        operation: "converse",
      }).items.map((item) => item.call.id)).toEqual(["call-filter-c"]);
    } finally {
      store.close();
    }
  });

  test("computes request composition structural measures from normalized request blocks", () => {
    const { spoolDir, store } = createTestStore();
    try {
      writeSpoolEvents(spoolDir, fixtureEvents());
      expect(store.ingestSpoolBatch().ingested).toBe(10);

      const simple = requiredDetail(store, "call-fixture-flow-simple");
      expect(simple.requestComposition.totalBlockCount).toBe(simple.summary.requestBlockCount);
      expect(simple.compaction.status).toBe("none");
      expect(simple.requestComposition.totalByteSize).toBe(simple.summary.requestByteSize);
      expect(simple.requestComposition.totalMessageCount).toBe(1);
      expect(simple.requestComposition.usage).toEqual(simple.summary.usage);
      expect(compositionSection(simple, "current-user-input")).toMatchObject({
        present: true,
        blockCount: 1,
        messageCount: 1,
      });
      expect(compositionSection(simple, "harness-system-context").present).toBe(true);
      expect(simple.requestComposition.toolDefinitionCount).toBe(4);
      expect(simple.requestComposition.toolSchemaByteSize).toBe(compositionSection(simple, "tool-definition").byteSize);
      expect(simple.requestComposition.cacheMarkerCount).toBe(2);
      expect(simple.requestComposition.mediaSummaryCount).toBe(0);
      expect(simple.requestComposition.usage.totalTokens).toBe(1944);

      const history = requiredDetail(store, "call-fixture-flow-session-turn-two");
      expect(history.requestComposition.totalMessageCount).toBe(3);
      expect(compositionSection(history, "prior-conversation-history")).toMatchObject({
        present: true,
        blockCount: 2,
        messageCount: 2,
      });

      const toolResult = requiredDetail(store, "call-fixture-flow-tool-result");
      expect(toolResult.requestComposition.totalMessageCount).toBe(3);
      expect(compositionSection(toolResult, "tool-call")).toMatchObject({ present: true, blockCount: 1 });
      expect(compositionSection(toolResult, "tool-result")).toMatchObject({ present: true, blockCount: 1 });
    } finally {
      store.close();
    }
  });

  test("computes Pi compaction assessments from request context transitions", () => {
    const { store } = createTestStore();
    try {
      store.persistRequest(syntheticBedrockRequest("fixture-flow-pre-compaction", 1, {
        messages: [
          { role: "user", content: [{ text: "First historical user turn. ".repeat(180) }] },
          { role: "assistant", content: [{ text: "First historical assistant turn. ".repeat(180) }] },
          { role: "user", content: [{ text: "Second historical user turn. ".repeat(180) }] },
          { role: "assistant", content: [{ text: "Second historical assistant turn. ".repeat(180) }] },
          { role: "user", content: [{ text: "continue before compaction" }] },
        ],
        system: [{ text: "You are an expert coding assistant operating inside pi, a coding agent harness." }],
        inferenceConfig: { maxTokens: 32_000 },
      }));
      store.persistRequest(syntheticBedrockRequest("fixture-flow-post-compaction", 2, {
        messages: [
          { role: "user", content: [{ text: "Summary of the conversation so far: the user asked for a multi-file refactor and the agent edited the store layer." }] },
          { role: "user", content: [{ text: "continue after compaction" }] },
        ],
        system: [{ text: "You are an expert coding assistant operating inside pi, a coding agent harness." }],
        inferenceConfig: { maxTokens: 32_000 },
      }));

      const detail = requiredDetail(store, bedrockCallIdForFlow("fixture-flow-post-compaction"));
      expect(detail.compaction).toMatchObject({
        status: "candidate",
        source: "pi_pattern",
        label: "Pi compaction candidate",
      });
      expect(detail.compaction.reasons).toContain("summary_like_history_block");
      expect(detail.compaction.reasons).toContain("prior_history_byte_drop");
      expect(detail.compaction.evidence.previousCallId).toBe(bedrockCallIdForFlow("fixture-flow-pre-compaction"));
    } finally {
      store.close();
    }
  });

  test("prepares, caches, and cascades token count records", () => {
    let now = 1_000;
    const { dbPath, spoolDir, store } = createTestStore({ now: () => now });
    try {
      writeSpoolEvents(spoolDir, fixturePair());
      expect(store.ingestSpoolBatch()).toMatchObject({ ingested: 2 });

      const callId = bedrockCallIdForFlow("fixture-flow-simple");
      let detail = requiredDetail(store, callId);
      const requestTokenCount = detail.tokenCounts.find((record) =>
        record.subjectType === "call" && record.direction === "request"
      );
      expect(requestTokenCount).toBeUndefined();

      const block = detail.blocks.find((candidate) => candidate.direction === "request" && candidate.text !== undefined);
      if (block === undefined) {
        throw new Error("missing request text block");
      }
      const prepared = store.prepareTokenCountSubject({ type: "block", callId, blockId: block.id });
      expect(prepared).not.toBeNull();
      expect(prepared?.base).toMatchObject({
        subjectType: "block",
        blockId: block.id,
      });

      now = 1_100;
      store.saveProviderTokenCount({
        subjectType: "block",
        callId,
        blockId: block.id,
        direction: block.direction,
        kind: block.kind,
        sourceHash: block.content_hash,
        modelId: detail.summary.call.model_id,
        tokens: 42,
        provenance: "provider_counted",
        countedAt: now,
      });
      detail = requiredDetail(store, callId);
      expect(detail.tokenCounts.find((record) => record.subjectType === "block" && record.blockId === block.id))
        .toMatchObject({ provenance: "provider_counted", tokens: 42 });
      expect(countRows(dbPath, "token_count")).toBe(1);

      const selection = store.prepareTokenCountSubject({ type: "selection", callId, text: "selected text", label: "selection" });
      expect(selection?.cacheKey).toBeDefined();
      now = 1_200;
      store.saveProviderTokenCount({
        subjectType: "selection",
        callId,
        label: "selection",
        sourceHash: selection?.base.sourceHash ?? "",
        modelId: detail.summary.call.model_id,
        tokens: 7,
        provenance: "provider_counted",
        countedAt: now,
      });
      expect(store.getCachedProviderTokenCount(selection?.cacheKey ?? "missing"))
        .toMatchObject({ subjectType: "selection", label: "selection", provenance: "provider_counted", tokens: 7 });
      expect(countRows(dbPath, "token_count")).toBe(2);

      store.clearData();
      expect(countRows(dbPath, "token_count")).toBe(0);
    } finally {
      store.close();
    }
  });

  test("persists raw payloads only when raw storage is enabled", () => {
    const disabledComposition = (() => {
      const rawDisabled = createTestStore();
      try {
        const [request, response] = fixturePair();
        rawDisabled.store.persistRequest(request);
        expect(rawDisabled.store.persistResponse(response)).toBe(true);
        return requiredDetail(rawDisabled.store, bedrockCallIdForFlow(request.flow_id)).requestComposition;
      } finally {
        rawDisabled.store.close();
      }
    })();

    const { dbPath, store } = createTestStore({ storeRaw: true });
    try {
      const [request, response] = fixturePair();
      store.persistRequest(request);
      expect(store.persistResponse(response)).toBe(true);

      expect(countRows(dbPath, "provider_call")).toBe(1);
      expect(countRows(dbPath, "raw_payload")).toBe(2);
      expect(countRows(dbPath, "raw_payload", "direction = 'request' AND body_text LIKE '%Fixture capture simple prompt%'")).toBe(1);
      expect(countRows(dbPath, "raw_payload", "direction = 'response' AND body_encoding = 'aws-eventstream'")).toBe(1);
      expect(requiredDetail(store, bedrockCallIdForFlow(request.flow_id)).requestComposition).toEqual(disabledComposition);
    } finally {
      store.close();
    }
  });

  test("moves calls from pending to complete and remains idempotent", () => {
    const { dbPath, store } = createTestStore();
    try {
      const [request, response] = fixturePair();
      const callId = bedrockCallIdForFlow(request.flow_id);

      store.persistRequest(request);
      expect(statusForCall(dbPath, callId)).toBe("pending");
      expect(countRows(dbPath, "normalized_block", "call_id = 'call-fixture-flow-simple' AND direction = 'request'")).toBeGreaterThan(0);
      expect(countRows(dbPath, "normalized_block", "call_id = 'call-fixture-flow-simple' AND direction = 'response'")).toBe(0);

      expect(store.persistResponse(response)).toBe(true);
      expect(statusForCall(dbPath, callId)).toBe("complete");
      const blockCount = countRows(dbPath, "normalized_block");
      const streamCount = countRows(dbPath, "stream_event");

      store.persistRequest(request);
      expect(store.persistResponse(response)).toBe(true);
      expect(statusForCall(dbPath, callId)).toBe("complete");
      expect(countRows(dbPath, "provider_call")).toBe(1);
      expect(countRows(dbPath, "http_event")).toBe(2);
      expect(countRows(dbPath, "normalized_block")).toBe(blockCount);
      expect(countRows(dbPath, "stream_event")).toBe(streamCount);
    } finally {
      store.close();
    }
  });

  test("defers unmatched responses and records malformed, dropped, and error events", () => {
    const { dbPath, spoolDir, store } = createTestStore();
    try {
      const [request, response] = fixturePair();
      writeSpoolEvents(spoolDir, [response]);

      expect(store.ingestSpoolBatch()).toEqual({
        attempted: 1,
        ingested: 0,
        deleted: 0,
        deferred: 1,
        malformed: 0,
        errors: 0,
      });
      expect(readdirSync(spoolDir)).toHaveLength(1);

      store.persistRequest(request);
      expect(store.ingestSpoolBatch()).toEqual({
        attempted: 1,
        ingested: 1,
        deleted: 1,
        deferred: 0,
        malformed: 0,
        errors: 0,
      });
      expect(statusForCall(dbPath, bedrockCallIdForFlow(request.flow_id))).toBe("complete");

      writeFileSync(join(spoolDir, "bad-schema.json"), "{\"direction\":\"request\"}\n");
      writeFileSync(join(spoolDir, "dropped.json"), `${JSON.stringify({
        version: 1,
        ts: 2000,
        direction: "dropped",
        provider: "bedrock",
        reason: "spool_full",
        dropped_count: 3,
      })}\n`);
      writeFileSync(join(spoolDir, "error.json"), `${JSON.stringify({
        version: 1,
        ts: 2001,
        direction: "error",
        flow_id: request.flow_id,
        provider: "bedrock",
        error: "upstream failed",
      })}\n`);

      expect(store.ingestSpoolBatch()).toEqual({
        attempted: 3,
        ingested: 2,
        deleted: 3,
        deferred: 0,
        malformed: 1,
        errors: 0,
      });
      const health = store.getHealthSnapshot();
      expect(health.counters.spool_malformed_events).toBe(1);
      expect(health.counters.spool_dropped_events).toBe(1);
      expect(health.counters.captures_dropped).toBe(3);
      expect(health.counters.spool_error_events).toBe(1);
      expect(statusForCall(dbPath, bedrockCallIdForFlow(request.flow_id))).toBe("error");
      expect(readdirSync(spoolDir)).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("retention deletes old and oversized call data with cascaded FTS cleanup", () => {
    const [baseRequest, baseResponse] = fixturePair();
    const ageStore = createTestStore({ retentionDays: 1, now: () => 200_000 });
    try {
      ageStore.store.persistRequest(retagRequest(baseRequest, "old-flow", 100));
      ageStore.store.persistResponse(retagResponse(baseResponse, "old-flow", 101));
      ageStore.store.persistRequest(retagRequest(baseRequest, "new-flow", 199_990));
      ageStore.store.persistResponse(retagResponse(baseResponse, "new-flow", 199_991));

      expect(ageStore.store.runRetention()).toEqual({
        deletedByAge: 1,
        deletedBySize: 0,
        vacuumed: false,
      });
      expect(countRows(ageStore.dbPath, "provider_call")).toBe(1);
      expect(countRows(ageStore.dbPath, "provider_call", "id = 'call-new-flow'")).toBe(1);
      expect(countRows(ageStore.dbPath, "normalized_block", "call_id = 'call-old-flow'")).toBe(0);
      expect(countRows(ageStore.dbPath, "normalized_block_fts")).toBe(
        countRows(ageStore.dbPath, "normalized_block", "text IS NOT NULL"),
      );
    } finally {
      ageStore.store.close();
    }

    const sizeStore = createTestStore({ retentionDays: 365, maxBytes: 1, now: () => 200_000 });
    try {
      sizeStore.store.persistRequest(retagRequest(baseRequest, "size-one", 10_000));
      sizeStore.store.persistResponse(retagResponse(baseResponse, "size-one", 10_001));
      sizeStore.store.persistRequest(retagRequest(baseRequest, "size-two", 20_000));
      sizeStore.store.persistResponse(retagResponse(baseResponse, "size-two", 20_001));

      const result = sizeStore.store.runRetention();
      expect(result.deletedByAge).toBe(0);
      expect(result.deletedBySize).toBe(2);
      expect(countRows(sizeStore.dbPath, "provider_call")).toBe(0);
      expect(countRows(sizeStore.dbPath, "normalized_block_fts")).toBe(0);
    } finally {
      sizeStore.store.close();
    }
  });

  test("clearData removes captured rows and pending spool while preserving migrations", () => {
    const { dbPath, spoolDir, store } = createTestStore({ now: () => 1234 });
    try {
      writeSpoolEvents(spoolDir, fixtureEvents());
      expect(store.ingestSpoolBatch().ingested).toBe(10);
      writeFileSync(join(spoolDir, "pending.json"), `${JSON.stringify(firstFixtureEvent())}\n`);

      expect(store.clearData()).toEqual({
        deletedSpoolFiles: 1,
        clearGeneration: 1,
        clearBaselineTs: 1234,
      });

      expect(countRows(dbPath, "provider_call")).toBe(0);
      expect(countRows(dbPath, "normalized_block")).toBe(0);
      expect(countRows(dbPath, "normalized_block_fts")).toBe(0);
      expect(countRows(dbPath, "stream_event")).toBe(0);
      expect(countRows(dbPath, "health_counter")).toBe(0);
      expect(countRows(dbPath, "schema_migration")).toBe(currentSpySchemaVersion());
      expect(metadataValue(dbPath, "clear_generation")).toBe("1");
      expect(metadataValue(dbPath, "clear_baseline_ts")).toBe("1234");
      expect(readdirSync(spoolDir)).toEqual([]);
    } finally {
      store.close();
    }
  });
});
