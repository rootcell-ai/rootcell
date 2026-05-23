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
  StreamEventPageSchema,
  SseEventNameSchema,
  SseEventPayloadSchemas,
} from "./api-contracts.ts";
import { SpoolEventSchema, type SpoolEvent } from "./schemas.ts";
import { startSpyService, type SpyServiceHandle } from "./service.ts";

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
      ingestIntervalMs: 60_000,
      retentionIntervalMs: 60_000,
    },
    startIngestion: options.startIngestion ?? false,
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

async function jsonAs<T>(response: Response, schema: ZodType<T>): Promise<T> {
  const parsed: unknown = await response.json();
  return schema.parse(parsed);
}

describe("spy web service", () => {
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
    expect(health.service.storeRaw).toBe(false);
    expect(health.store.providerCallCount).toBe(5);

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

    const invalidCursorResponse = await fetch(`${handle.url}/api/calls?cursor=not-a-cursor`);
    expect(invalidCursorResponse.status).toBe(400);

    const missingResponse = await fetch(`${handle.url}/api/calls/missing-call`);
    expect(missingResponse.status).toBe(404);
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
