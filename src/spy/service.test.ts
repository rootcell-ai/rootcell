import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ZodType } from "zod";
import {
  ClearDataResultSchema,
  SpyCallDetailSchema,
  SpyCallDiffSchema,
  SpyCallSummaryPageSchema,
  SpyServiceHealthSchema,
  SpyTokenCountResponseSchema,
  StreamEventPageSchema,
  SseEventNameSchema,
  SseEventPayloadSchemas,
  type SpyCallDetail,
} from "./api-contracts.ts";
import { SpoolEventSchema, SpoolRequestEventSchema, SpoolResponseEventSchema, type SpoolEvent, type SpoolRequestEvent, type SpoolResponseEvent } from "./schemas.ts";
import { spyServiceConfigFromEnv, startSpyService, type SpyServiceHandle } from "./service.ts";
import type { BedrockTokenCounter, BedrockTokenCountInput } from "./bedrock-token-count.ts";

const FIXTURE_PATH = new URL("./fixtures/bedrock-pi-us-sonnet-4-6.ndjson", import.meta.url);

interface TestService {
  readonly root: string;
  readonly dbPath: string;
  readonly spoolDir: string;
  readonly staticDir: string;
  readonly handle: SpyServiceHandle;
}

interface SseReader {
  read(): Promise<
    | { readonly done: true; readonly value?: undefined }
    | { readonly done: false; readonly value: Uint8Array }
  >;
}

class FakeTokenCounter implements BedrockTokenCounter {
  readonly inputs: BedrockTokenCountInput[] = [];

  constructor(
    private readonly result: number,
    private readonly failure?: Error | undefined,
    private readonly delayMs = 0,
  ) {}

  async count(input: BedrockTokenCountInput): Promise<number> {
    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    } else {
      await Promise.resolve();
    }
    this.inputs.push(input);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.result;
  }
}

const tempRoots: string[] = [];
const serviceHandles: SpyServiceHandle[] = [];

afterEach(async () => {
  for (const handle of serviceHandles.splice(0)) {
    await handle.stop();
  }
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

function createTestService(options: {
  readonly storeRaw?: boolean | undefined;
  readonly startIngestion?: boolean | undefined;
  readonly tokenCounter?: BedrockTokenCounter | undefined;
  readonly tokenCountMode?: "provider" | undefined;
} = {}): TestService {
  const root = mkdtempSync(join(tmpdir(), "rootcell-spy-service-"));
  tempRoots.push(root);
  const dbPath = join(root, "spy.sqlite");
  const spoolDir = join(root, "spool");
  const staticDir = join(root, "static");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Rootcell Spy</title><div id=\"root\"></div>");
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "assets", "app.js"), "globalThis.rootcellSpyAsset = true;\n");

  const handle = startSpyService({
    config: {
      bind: "127.0.0.1",
      port: 0,
      dbPath,
      spoolDir,
      staticDir,
      storeRaw: options.storeRaw === true,
      ...(options.tokenCountMode === undefined ? {} : { tokenCountMode: options.tokenCountMode }),
      ingestIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    },
    startIngestion: options.startIngestion ?? false,
    tokenCounter: options.tokenCounter,
  });
  serviceHandles.push(handle);
  return { root, dbPath, spoolDir, staticDir, handle };
}

function writeSpoolEvents(spoolDir: string, events: readonly SpoolEvent[]): void {
  events.forEach((event, index) => {
    const flowId = "flow_id" in event && event.flow_id !== undefined ? event.flow_id : "no-flow";
    writeFileSync(
      join(spoolDir, `${String(index).padStart(3, "0")}-${event.direction}-${flowId}.json`),
      `${JSON.stringify(event)}\n`,
    );
  });
}

function cursorRequest(flowId: string, operation = "StreamUnifiedChat"): SpoolRequestEvent {
  return SpoolRequestEventSchema.parse({
    version: 1,
    ts: 1779497300,
    direction: "request",
    flow_id: flowId,
    provider: "cursor",
    operation,
    model_id: "Composer 2.5",
    host: "api2.cursor.sh",
    method: "POST",
    path: `/aiserver.v1.AiService/${operation}`,
    headers: [["content-type", "application/json"]],
    body_text: JSON.stringify({ model: "Composer 2.5", prompt: "RCSPY-CURSOR-SERVICE" }),
  });
}

function cursorResponse(flowId: string, operation = "StreamUnifiedChat"): SpoolResponseEvent {
  return SpoolResponseEventSchema.parse({
    version: 1,
    ts: 1779497301,
    direction: "response",
    flow_id: flowId,
    provider: "cursor",
    operation,
    model_id: "Composer 2.5",
    host: "api2.cursor.sh",
    method: "POST",
    path: `/aiserver.v1.AiService/${operation}`,
    headers: [["content-type", "application/json"]],
    status_code: 200,
    reason: "OK",
    request_headers: [["content-type", "application/json"]],
    body_text: JSON.stringify({ result: { text: "cursor-service-ok" } }),
  });
}

async function jsonAs<T>(response: Response, schema: ZodType<T>): Promise<T> {
  const parsed: unknown = await response.json();
  return schema.parse(parsed);
}

describe("spy web service", () => {
  test("derives enabled state from environment with direct startup enabled by default", () => {
    expect(spyServiceConfigFromEnv({}).enabled).toBe(true);
    expect(spyServiceConfigFromEnv({ ROOTCELL_SPY_ENABLED: "false" }).enabled).toBe(false);
    expect(spyServiceConfigFromEnv({ ROOTCELL_SPY_ENABLED: "true" }).enabled).toBe(true);
    expect(spyServiceConfigFromEnv({}).tokenCountMode).toBe("provider");
    expect(spyServiceConfigFromEnv({ ROOTCELL_SPY_TOKEN_COUNT_MODE: "estimate" }).tokenCountMode).toBe("provider");
    expect(spyServiceConfigFromEnv({ ROOTCELL_SPY_TOKEN_COUNT_MODE: "provider" }).tokenCountMode).toBe("provider");
    expect(spyServiceConfigFromEnv({ AWS_REGION: "us-west-2" }).bedrockRegion).toBe("us-west-2");
  });

  test("serves health, paginated calls, details, diff, stream events, and search", async () => {
    const { handle, spoolDir } = createTestService();
    writeSpoolEvents(spoolDir, fixtureEvents());

    expect(handle.ingestOnce()).toMatchObject({
      attempted: 10,
      ingested: 10,
      deleted: 10,
      deferred: 0,
    });

    const healthResponse = await fetch(`${handle.url}/api/health`);
    expect(healthResponse.status).toBe(200);
    const health = await jsonAs(healthResponse, SpyServiceHealthSchema);
    expect(health.service.enabled).toBe(true);
    expect(health.service.storeRaw).toBe(false);
    expect(health.service.tokenCountMode).toBe("provider");
    expect(health.store.providerCallCount).toBe(5);
    expect(health.store.droppedCaptureCount).toBe(0);
    expect(health.store.lastIngestAt).not.toBeNull();

    const firstPageResponse = await fetch(`${handle.url}/api/calls?limit=2`);
    const firstPage = await jsonAs(firstPageResponse, SpyCallSummaryPageSchema);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toBeDefined();

    const secondPageResponse = await fetch(`${handle.url}/api/calls?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`);
    const secondPage = await jsonAs(secondPageResponse, SpyCallSummaryPageSchema);
    expect(secondPage.items).toHaveLength(2);
    expect(secondPage.items[0]?.call.id).not.toBe(firstPage.items[0]?.call.id);

    const callId = firstPage.items[0]?.call.id;
    if (callId === undefined) {
      throw new Error("missing call id");
    }

    const detailResponse = await fetch(`${handle.url}/api/calls/${encodeURIComponent(callId)}`);
    expect(detailResponse.status).toBe(200);
    const detail = await jsonAs(detailResponse, SpyCallDetailSchema);
    expect(detail.summary.call.id).toBe(callId);
    expect(detail.requestComposition.totalBlockCount).toBe(detail.summary.requestBlockCount);
    expect(detail.requestComposition.totalByteSize).toBe(detail.summary.requestByteSize);
    expect(detail.requestComposition.totalMessageCount).toBeGreaterThan(0);
    expect(detail.requestComposition.sections.some((section) => section.present)).toBe(true);
    expect(detail.requestComposition.usage).toEqual(detail.summary.usage);
    expect(detail.compaction.status).toBe("none");
    expect(detail.httpEvents).toHaveLength(2);
    expect(detail.blocks.length).toBeGreaterThan(0);
    expect(detail.usageRecords.length).toBeGreaterThan(0);
    expect(detail.rawPayloads).toHaveLength(0);

    const streamResponse = await fetch(`${handle.url}/api/calls/${encodeURIComponent(callId)}/stream-events?limit=2`);
    const streamPage = await jsonAs(streamResponse, StreamEventPageSchema);
    expect(streamPage.items).toHaveLength(2);
    expect(streamPage.nextCursor).toBeDefined();

    const diffResponse = await fetch(`${handle.url}/api/calls/${encodeURIComponent(callId)}/diff`);
    const diff = await jsonAs(diffResponse, SpyCallDiffSchema);
    expect(diff.call.call.id).toBe(callId);
    expect(diff.blocks.length).toBeGreaterThan(0);
    expect(diff.blocks.every((block) => ["new", "repeated", "changed", "unknown"].includes(block.classification))).toBe(true);

    const searchResponse = await fetch(`${handle.url}/api/search?q=${encodeURIComponent("Fixture capture")}`);
    const searchPage = await jsonAs(searchResponse, SpyCallSummaryPageSchema);
    expect(searchPage.items.length).toBeGreaterThan(0);
    const callIdSearch = await jsonAs(
      await fetch(`${handle.url}/api/search?q=${encodeURIComponent(callId)}`),
      SpyCallSummaryPageSchema,
    );
    expect(callIdSearch.items.map((item) => item.call.id)).toEqual([callId]);
    const modelSearch = await jsonAs(
      await fetch(`${handle.url}/api/search?q=${encodeURIComponent("sonnet")}`),
      SpyCallSummaryPageSchema,
    );
    expect(modelSearch.items).toHaveLength(5);

    const filteredCallsResponse = await fetch(`${handle.url}/api/calls?provider=bedrock&model_id=${encodeURIComponent("us.anthropic.claude-sonnet-4-6")}&operation=converse-stream&status=complete`);
    const filteredCalls = await jsonAs(filteredCallsResponse, SpyCallSummaryPageSchema);
    expect(filteredCalls.items).toHaveLength(5);

    const unknownOperationResponse = await fetch(`${handle.url}/api/calls?operation=invoke`);
    const unknownOperation = await jsonAs(unknownOperationResponse, SpyCallSummaryPageSchema);
    expect(unknownOperation.items).toHaveLength(0);

    handle.store.persistRequest(cursorRequest("fixture-cursor-service"));
    expect(handle.store.persistResponse(cursorResponse("fixture-cursor-service"))).toBe(true);
    handle.store.persistRequest(cursorRequest("fixture-cursor-support", "BidiAppend"));
    expect(handle.store.persistResponse(cursorResponse("fixture-cursor-support", "BidiAppend"))).toBe(true);
    const cursorCallsResponse = await fetch(`${handle.url}/api/calls?provider=cursor&model_id=${encodeURIComponent("Composer 2.5")}&status=complete`);
    const cursorCalls = await jsonAs(cursorCallsResponse, SpyCallSummaryPageSchema);
    expect(cursorCalls.items).toHaveLength(2);
    expect(cursorCalls.items[0]?.call.provider).toBe("cursor");
    const conversationCursorCalls = await jsonAs(
      await fetch(`${handle.url}/api/calls?provider=cursor&traffic=conversation`),
      SpyCallSummaryPageSchema,
    );
    expect(conversationCursorCalls.items.map((item) => item.call.operation)).toEqual(["StreamUnifiedChat"]);
    const allCursorCalls = await jsonAs(
      await fetch(`${handle.url}/api/calls?provider=cursor&traffic=all`),
      SpyCallSummaryPageSchema,
    );
    expect(allCursorCalls.items.map((item) => item.call.operation)).toContain("BidiAppend");
    const explicitSupportOperation = await jsonAs(
      await fetch(`${handle.url}/api/calls?provider=cursor&traffic=conversation&operation=BidiAppend`),
      SpyCallSummaryPageSchema,
    );
    expect(explicitSupportOperation.items.map((item) => item.call.operation)).toEqual(["BidiAppend"]);

    const filteredSearchResponse = await fetch(`${handle.url}/api/search?q=${encodeURIComponent("Fixture capture")}&since=1779496808&provider=bedrock&model_id=${encodeURIComponent("us.anthropic.claude-sonnet-4-6")}&operation=converse-stream&status=complete&limit=1`);
    const filteredSearch = await jsonAs(filteredSearchResponse, SpyCallSummaryPageSchema);
    expect(filteredSearch.items.map((item) => item.call.id)).toEqual(["call-fixture-flow-tool-result"]);

    const firstSearchPage = await jsonAs(
      await fetch(`${handle.url}/api/search?q=${encodeURIComponent("Fixture capture")}&limit=1&provider=bedrock&status=complete`),
      SpyCallSummaryPageSchema,
    );
    expect(firstSearchPage.items).toHaveLength(1);
    expect(firstSearchPage.nextCursor).toBeDefined();
    const secondSearchPage = await jsonAs(
      await fetch(`${handle.url}/api/search?q=${encodeURIComponent("Fixture capture")}&limit=1&provider=bedrock&status=complete&cursor=${encodeURIComponent(firstSearchPage.nextCursor ?? "")}`),
      SpyCallSummaryPageSchema,
    );
    expect(secondSearchPage.items).toHaveLength(1);
    expect(secondSearchPage.items[0]?.call.id).not.toBe(firstSearchPage.items[0]?.call.id);

    const invalidProviderResponse = await fetch(`${handle.url}/api/calls?provider=openai`);
    expect(invalidProviderResponse.status).toBe(400);

    const invalidSearchProviderResponse = await fetch(`${handle.url}/api/search?q=Fixture&provider=openai`);
    expect(invalidSearchProviderResponse.status).toBe(400);

    const invalidStatusResponse = await fetch(`${handle.url}/api/search?q=Fixture&status=done`);
    expect(invalidStatusResponse.status).toBe(400);

    const invalidCursorResponse = await fetch(`${handle.url}/api/calls?cursor=not-a-cursor`);
    expect(invalidCursorResponse.status).toBe(400);

    const missingResponse = await fetch(`${handle.url}/api/calls/missing-call`);
    expect(missingResponse.status).toBe(404);
  });

  test("returns call details immediately and streams provider token counts over SSE", async () => {
    const counter = new FakeTokenCounter(77, undefined, 250);
    const { handle, spoolDir } = createTestService({ tokenCounter: counter, tokenCountMode: "provider" });
    writeSpoolEvents(spoolDir, fixtureEvents());
    expect(handle.ingestOnce()).toMatchObject({ ingested: 10 });

    const response = await fetch(`${handle.url}/api/events`);
    expect(response.status).toBe(200);
    if (response.body === null) {
      throw new Error("missing SSE body");
    }
    const reader = response.body.getReader();
    try {
      await readSseUntil(reader, "event: hello");

      const page = await jsonAs(await fetch(`${handle.url}/api/calls?limit=1`), SpyCallSummaryPageSchema);
      const callId = page.items[0]?.call.id;
      if (callId === undefined) {
        throw new Error("missing call id");
      }
      const detail = await jsonAs(await fetch(`${handle.url}/api/calls/${encodeURIComponent(callId)}`), SpyCallDetailSchema);
      const block = detail.blocks.find((candidate) => candidate.direction === "request" && candidate.text !== undefined);
      if (block === undefined) {
        throw new Error("missing text block");
      }
      const responseBlock = detail.blocks.find((candidate) => candidate.direction === "response" && candidate.text !== undefined);
      if (responseBlock === undefined) {
        throw new Error("missing response text block");
      }

      expect(detail.tokenCounts.find((record) => record.subjectType === "block" && record.blockId === block.id))
        .toBeUndefined();
      expect(counter.inputs).toHaveLength(0);

      const tokenEvents = await readSseUntil(reader, "event: token-counts-changed");
      expect(tokenEvents).toContain(`"callId":"${callId}"`);
      expect(tokenEvents).toContain("\"provenance\":\"provider_counted\"");
      expectValidSsePayloads(tokenEvents);
      await waitUntil(() => counter.inputs.length >= expectedBackgroundProviderCount(detail));

      const refreshed = await jsonAs(await fetch(`${handle.url}/api/calls/${encodeURIComponent(callId)}`), SpyCallDetailSchema);
      expect(refreshed.tokenCounts.find((record) => record.subjectType === "block" && record.blockId === responseBlock.id))
        .toMatchObject({ subjectType: "block", direction: "response", provenance: "provider_counted", tokens: 77 });
    } finally {
      await reader.cancel();
    }
  });

  test("counts tokens through explicit provider calls and cached provider counts", async () => {
    const counter = new FakeTokenCounter(77);
    const { handle, spoolDir } = createTestService({ tokenCounter: counter, tokenCountMode: "provider" });
    writeSpoolEvents(spoolDir, fixtureEvents());
    expect(handle.ingestOnce()).toMatchObject({ ingested: 10 });

    const page = await jsonAs(await fetch(`${handle.url}/api/calls?limit=1`), SpyCallSummaryPageSchema);
    const callId = page.items[0]?.call.id;
    if (callId === undefined) {
      throw new Error("missing call id");
    }
    const detail = handle.store.getCallDetail(callId);
    if (detail === null) {
      throw new Error("missing call detail");
    }
    const block = detail.blocks.find((candidate) => candidate.direction === "request" && candidate.text !== undefined);
    if (block === undefined) {
      throw new Error("missing text block");
    }

    const countedBlock = await jsonAs(await fetch(`${handle.url}/api/token-count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "provider", subjects: [{ type: "block", callId, blockId: block.id }] }),
    }), SpyTokenCountResponseSchema);
    expect(countedBlock.records[0]).toMatchObject({ subjectType: "block", provenance: "provider_counted", tokens: 77 });
    expect(counter.inputs).toHaveLength(1);

    const cachedBlock = await jsonAs(await fetch(`${handle.url}/api/token-count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "provider", subjects: [{ type: "block", callId, blockId: block.id }] }),
    }), SpyTokenCountResponseSchema);
    expect(cachedBlock.records[0]).toMatchObject({ subjectType: "block", provenance: "provider_counted", tokens: 77 });
    expect(counter.inputs).toHaveLength(1);

    const selection = await jsonAs(await fetch(`${handle.url}/api/token-count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "provider", subjects: [{ type: "selection", callId, text: "selected text" }] }),
    }), SpyTokenCountResponseSchema);
    expect(selection.records[0]).toMatchObject({ provenance: "provider_counted", tokens: 77 });
    expect(counter.inputs).toHaveLength(2);

    const cachedSelection = await jsonAs(await fetch(`${handle.url}/api/token-count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "provider", subjects: [{ type: "selection", callId, text: "selected text" }] }),
    }), SpyTokenCountResponseSchema);
    expect(cachedSelection.records[0]).toMatchObject({ provenance: "provider_counted", tokens: 77 });
    expect(counter.inputs).toHaveLength(2);

    const reported = await jsonAs(await fetch(`${handle.url}/api/token-count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "provider", subjects: [{ type: "call", callId, direction: "request" }] }),
    }), SpyTokenCountResponseSchema);
    expect(reported.records[0]).toMatchObject({ subjectType: "call", provenance: "provider_counted", tokens: 77 });
    expect(counter.inputs).toHaveLength(3);
  });

  test("returns unavailable token records when provider counting fails", async () => {
    const { handle, spoolDir } = createTestService({
      tokenCounter: new FakeTokenCounter(0, new Error("provider offline")),
      tokenCountMode: "provider",
    });
    writeSpoolEvents(spoolDir, fixtureEvents());
    expect(handle.ingestOnce()).toMatchObject({ ingested: 10 });

    const page = await jsonAs(await fetch(`${handle.url}/api/calls?limit=1`), SpyCallSummaryPageSchema);
    const callId = page.items[0]?.call.id;
    if (callId === undefined) {
      throw new Error("missing call id");
    }
    const response = await jsonAs(await fetch(`${handle.url}/api/token-count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "provider", subjects: [{ type: "selection", callId, text: "selected text" }] }),
    }), SpyTokenCountResponseSchema);
    expect(response.records[0]).toMatchObject({
      subjectType: "selection",
      provenance: "unavailable",
      tokens: null,
      error: "provider offline",
    });
  });

  test("returns a Cursor-specific unavailable token record without calling Bedrock CountTokens", async () => {
    const counter = new FakeTokenCounter(77);
    const { handle } = createTestService({
      tokenCounter: counter,
      tokenCountMode: "provider",
    });
    handle.store.persistRequest(cursorRequest("fixture-cursor-token-count"));
    expect(handle.store.persistResponse(cursorResponse("fixture-cursor-token-count"))).toBe(true);

    const callId = "call-cursor-fixture-cursor-token-count";
    const detail = await jsonAs(await fetch(`${handle.url}/api/calls/${encodeURIComponent(callId)}`), SpyCallDetailSchema);
    expect(detail.tokenCounts.some((record) =>
      record.subjectType === "call"
      && record.direction === "request"
      && record.provenance === "unavailable"
      && record.error === "provider token counting is currently available only for Bedrock captures; Cursor request/block token recounting is not implemented"
    )).toBe(true);
    expect(detail.tokenCounts.some((record) => record.subjectType === "block" && record.provenance === "unavailable")).toBe(true);
    expect(counter.inputs).toHaveLength(0);

    const response = await jsonAs(await fetch(`${handle.url}/api/token-count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "provider",
        subjects: [{ type: "call", callId, direction: "request" }],
      }),
    }), SpyTokenCountResponseSchema);

    expect(counter.inputs).toHaveLength(0);
    expect(response.records[0]).toMatchObject({
      subjectType: "call",
      provenance: "unavailable",
      tokens: null,
      error: "provider token counting is currently available only for Bedrock captures; Cursor request/block token recounting is not implemented",
    });
  });

  test("returns raw payloads only when raw storage is enabled", async () => {
    const { handle, spoolDir } = createTestService({ storeRaw: true });
    writeSpoolEvents(spoolDir, fixtureEvents());
    expect(handle.ingestOnce().ingested).toBe(10);

    const page = await jsonAs(await fetch(`${handle.url}/api/calls?limit=1`), SpyCallSummaryPageSchema);
    const callId = page.items[0]?.call.id;
    if (callId === undefined) {
      throw new Error("missing raw payload call id");
    }

    const detail = await jsonAs(await fetch(`${handle.url}/api/calls/${encodeURIComponent(callId)}`), SpyCallDetailSchema);
    expect(detail.rawPayloads).toHaveLength(2);
    expect(detail.rawPayloads.some((payload) => payload.direction === "request" && payload.body_text !== undefined)).toBe(true);
    expect(detail.rawPayloads.some((payload) => payload.direction === "response" && payload.body_encoding === "aws-eventstream")).toBe(true);
  });

  test("clears captured rows and pending spool only with confirmation", async () => {
    const { handle, spoolDir } = createTestService();
    const events = fixtureEvents();
    writeSpoolEvents(spoolDir, events);
    expect(handle.ingestOnce().ingested).toBe(10);
    writeSpoolEvents(spoolDir, events.slice(0, 1));

    const rejected = await fetch(`${handle.url}/api/clear`, {
      method: "POST",
      body: JSON.stringify({ confirm: false }),
    });
    expect(rejected.status).toBe(400);

    const cleared = await fetch(`${handle.url}/api/clear`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    expect(cleared.status).toBe(200);
    expect(await jsonAs(cleared, ClearDataResultSchema)).toMatchObject({
      deletedSpoolFiles: 1,
      clearGeneration: 1,
    });
    expect(readdirSync(spoolDir)).toEqual([]);

    const health = await jsonAs(await fetch(`${handle.url}/api/health`), SpyServiceHealthSchema);
    expect(health.store.providerCallCount).toBe(0);
  });

  test("emits SSE hello, calls-changed, health, and cleared events", async () => {
    const { handle, spoolDir } = createTestService();
    const response = await fetch(`${handle.url}/api/events`);
    expect(response.status).toBe(200);
    if (response.body === null) {
      throw new Error("missing SSE body");
    }
    const reader = response.body.getReader();
    try {
      const initialEvents = await readSseUntil(reader, "event: hello");
      expect(initialEvents).toContain("event: health");
      expectValidSsePayloads(initialEvents);

      writeSpoolEvents(spoolDir, fixtureEvents().slice(0, 2));
      expect(handle.ingestOnce().ingested).toBe(2);
      const changedEvents = await readSseUntil(reader, "event: calls-changed");
      expect(changedEvents).toContain("event: health");
      expectValidSsePayloads(changedEvents);

      const cleared = await fetch(`${handle.url}/api/clear`, {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      expect(cleared.status).toBe(200);
      const clearedEvents = await readSseUntil(reader, "event: cleared");
      expect(clearedEvents).toContain("event: health");
      expectValidSsePayloads(clearedEvents);
    } finally {
      await reader.cancel();
    }
  });

  test("serves static assets, falls back to index, and rejects traversal", async () => {
    const { handle } = createTestService();

    const asset = await fetch(`${handle.url}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(await asset.text()).toContain("rootcellSpyAsset");

    const route = await fetch(`${handle.url}/calls/call-fixture-flow-simple`, {
      headers: { accept: "text/html" },
    });
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("Rootcell Spy");

    const traversal = await fetch(`${handle.url}/..%2fPLAN.md`);
    expect(traversal.status).toBe(403);
  });
});

async function readSseUntil(
  reader: SseReader,
  needle: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 2_000;
  while (!text.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`timed out waiting for ${needle}; saw ${text}`);
    }
    const result = await Promise.race([
      reader.read(),
      sleep(remaining).then(() => "timeout" as const),
    ]);
    if (result === "timeout") {
      throw new Error(`timed out waiting for ${needle}; saw ${text}`);
    }
    if (result.done) {
      throw new Error(`SSE ended before ${needle}; saw ${text}`);
    }
    text += decoder.decode(result.value, { stream: true });
  }
  return text;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await sleep(10);
  }
}

function expectedBackgroundProviderCount(detail: SpyCallDetail): number {
  const present = new Set(detail.tokenCounts
    .filter((record) => record.provenance !== "unavailable")
    .map((record) => {
      if (record.subjectType === "call") {
        return ["call", record.callId ?? "", record.direction ?? "", "", "", ""].join(":");
      }
      if (record.subjectType === "section") {
        return ["section", record.callId ?? "", record.direction ?? "", "", record.kind ?? "", ""].join(":");
      }
      if (record.subjectType === "block") {
        return ["block", record.callId ?? "", "", record.blockId ?? "", ""].join(":");
      }
      return ["selection", record.callId ?? "", "", "", "", record.label ?? record.sourceHash].join(":");
    }));
  const missing = new Set<string>();
  const callKey = ["call", detail.summary.call.id, "request", "", "", ""].join(":");
  if (!present.has(callKey)) {
    missing.add(callKey);
  }
  for (const block of detail.blocks) {
    const sectionKey = ["section", detail.summary.call.id, block.direction, "", block.kind, ""].join(":");
    if (!present.has(sectionKey)) {
      missing.add(sectionKey);
    }
    const blockKey = ["block", detail.summary.call.id, "", block.id, "", ""].join(":");
    if (!present.has(blockKey)) {
      missing.add(blockKey);
    }
  }
  return missing.size;
}

function expectValidSsePayloads(text: string): void {
  const frames = text.split("\n\n").filter((frame) => frame.trim().length > 0);
  for (const frame of frames) {
    const lines = frame.split("\n");
    if (lines.every((line) => line.startsWith(":"))) {
      continue;
    }
    const rawEventName = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
    const data = lines
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .join("\n");
    if (rawEventName === undefined || data.length === 0) {
      throw new Error(`invalid SSE frame in test: ${frame}`);
    }
    const eventName = SseEventNameSchema.parse(rawEventName);
    const payload = JSON.parse(data) as unknown;
    SseEventPayloadSchemas[eventName].parse(payload);
  }
}
