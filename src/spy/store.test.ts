import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { bedrockCallIdForFlow } from "./bedrock.ts";
import { currentSpySchemaVersion } from "./migrations.ts";
import {
  SpoolEventSchema,
  SpoolRequestEventSchema,
  SpoolResponseEventSchema,
  type SpoolEvent,
  type SpoolRequestEvent,
  type SpoolResponseEvent,
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
