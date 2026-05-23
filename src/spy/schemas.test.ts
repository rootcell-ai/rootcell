import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { decodeAwsEventStreamJson } from "./eventstream.ts";
import { applySpyMigrations, currentSpySchemaVersion } from "./migrations.ts";
import {
  SpoolEventSchema,
  type SpoolEvent,
  type SpoolRequestEvent,
  type SpoolResponseEvent,
} from "./schemas.ts";

const FIXTURE_PATH = new URL("./fixtures/bedrock-pi-us-sonnet-4-6.ndjson", import.meta.url);
const bunSqlite = await import("bun:sqlite").catch(() => null);

function fixtureEvents(): SpoolEvent[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => SpoolEventSchema.parse(JSON.parse(line) as unknown));
}

function requestBody(event: SpoolRequestEvent): Record<string, unknown> {
  if (event.body_text === undefined) {
    throw new Error(`request ${event.flow_id} does not include body_text`);
  }
  return JSON.parse(event.body_text) as Record<string, unknown>;
}

function responseEvents(events: readonly SpoolEvent[]): SpoolResponseEvent[] {
  return events.filter((event): event is SpoolResponseEvent => event.direction === "response");
}

function httpEvents(events: readonly SpoolEvent[]): (SpoolRequestEvent | SpoolResponseEvent)[] {
  return events.filter((event): event is SpoolRequestEvent | SpoolResponseEvent => (
    event.direction === "request" || event.direction === "response"
  ));
}

function requestFor(events: readonly SpoolEvent[], flowId: string): SpoolRequestEvent {
  const event = events.find((candidate): candidate is SpoolRequestEvent => candidate.direction === "request" && candidate.flow_id === flowId);
  if (event === undefined) {
    throw new Error(`missing request fixture ${flowId}`);
  }
  return event;
}

describe("spy fixture capture", () => {
  test("validates the real Pi/Bedrock capture under the spool schema", () => {
    const events = fixtureEvents();
    expect(events).toHaveLength(10);
    const captured = httpEvents(events);
    expect(new Set(captured.map((event) => event.flow_id))).toEqual(new Set([
      "fixture-flow-simple",
      "fixture-flow-session-turn-one",
      "fixture-flow-session-turn-two",
      "fixture-flow-tool-use",
      "fixture-flow-tool-result",
    ]));
    expect(events.every((event) => event.provider === "bedrock")).toBe(true);
    expect(captured.every((event) => event.model_id === "us.anthropic.claude-sonnet-4-6")).toBe(true);
  });

  test("keeps credential metadata redacted while preserving body structure", () => {
    const events = fixtureEvents();
    const headerPairs = events.flatMap((event) => [
      ...("headers" in event ? event.headers : []),
      ...("request_headers" in event ? event.request_headers : []),
    ]);
    expect(headerPairs.filter(([name]) => name.toLowerCase() === "authorization"))
      .toEqual(headerPairs.filter(([name]) => name.toLowerCase() === "authorization").map(([name]) => [name, "[redacted]"]));

    const simple = requestFor(events, "fixture-flow-simple");
    const body = requestBody(simple);
    expect(body).toHaveProperty("messages");
    expect(JSON.stringify(body)).toContain("cachePoint");
    expect(JSON.stringify(body)).toContain("toolConfig");
  });

  test("captures prior conversation history and tool result request shapes", () => {
    const events = fixtureEvents();
    const history = requestFor(events, "fixture-flow-session-turn-two");
    const toolResult = requestFor(events, "fixture-flow-tool-result");

    const historyBody = requestBody(history);
    expect(JSON.stringify(historyBody)).toContain("turn-one-ok");
    expect(JSON.stringify(historyBody)).toContain("RCSPY-ALPHA");

    const toolResultBody = requestBody(toolResult);
    expect(JSON.stringify(toolResultBody)).toContain("toolUse");
    expect(JSON.stringify(toolResultBody)).toContain("toolResult");
    expect(JSON.stringify(toolResultBody)).toContain("tool-fixture-ok");
  });

  test("decodes response event streams, usage, and tool use deltas", () => {
    const responses = responseEvents(fixtureEvents());
    expect(responses).toHaveLength(5);

    const decoded = responses.map((event) => decodeAwsEventStreamJson(event.body_b64 ?? ""));
    expect(decoded.every((messages) => messages.some((message) => message.headers[":event-type"] === "metadata"))).toBe(true);
    expect(JSON.stringify(decoded)).toContain("inputTokens");
    expect(JSON.stringify(decoded)).toContain("outputTokens");

    const toolUse = decoded[3];
    const toolUseJson = JSON.stringify(toolUse);
    expect(toolUseJson).toContain("tool_use");
    expect(toolUseJson).toContain("toolUse");
    expect(toolUseJson).toContain("tooluse_");
  });
});

describe("spy sqlite migrations", () => {
  const testWithBunSqlite = bunSqlite === null ? test.skip : test;

  testWithBunSqlite("creates the v1 schema and supports core provider call inserts", () => {
    if (bunSqlite === null) {
      throw new Error("bun:sqlite unavailable");
    }
    const db = new bunSqlite.Database(":memory:");
    try {
      applySpyMigrations(db);
      expect(currentSpySchemaVersion()).toBe(1);
      expect(db.query("SELECT version FROM schema_migration").get()).toEqual({ version: 1 });

      db.query(`
INSERT INTO provider_call (
  id, provider, operation, model_id, status, started_at, completed_at,
  status_code, request_flow_id, response_flow_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
        "call-fixture-flow-simple",
        "bedrock",
        "converse-stream",
        "us.anthropic.claude-sonnet-4-6",
        "complete",
        1779496800,
        1779496801,
        200,
        "fixture-flow-simple",
        "fixture-flow-simple",
      );

      db.query(`
INSERT INTO normalized_block (
  id, call_id, direction, ordinal, kind, source, text,
  char_size, byte_size, content_hash, cache_marker
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
        "block-simple-user",
        "call-fixture-flow-simple",
        "request",
        0,
        "current-user-input",
        "bedrock-converse",
        "Fixture capture simple prompt.",
        30,
        30,
        "hash-simple-user",
        0,
      );

      expect(db.query("SELECT COUNT(*) AS count FROM provider_call").get()).toEqual({ count: 1 });
      db.query("DELETE FROM provider_call WHERE id = ?").run("call-fixture-flow-simple");
      expect(db.query("SELECT COUNT(*) AS count FROM normalized_block").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
