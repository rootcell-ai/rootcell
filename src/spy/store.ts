import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  bedrockCallIdForFlow,
  normalizeBedrockRequest,
  normalizeBedrockResponse,
} from "./bedrock.ts";
import { applySpyMigrations, currentSpySchemaVersion } from "./migrations.ts";
import {
  HttpEventRecordSchema,
  SpoolEventSchema,
  type HttpEventRecord,
  type NormalizedBlock,
  type ProviderCall,
  type RawPayloadRecord,
  type SpoolDroppedEvent,
  type SpoolErrorEvent,
  type SpoolEvent,
  type SpoolRequestEvent,
  type SpoolResponseEvent,
  type SpoolStreamChunkEvent,
  type StreamEvent,
  type UsageRecord,
} from "./schemas.ts";

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_BYTES = 6 * 1024 * 1024 * 1024;

export interface SpyStoreOptions {
  readonly dbPath: string;
  readonly spoolDir: string;
  readonly retentionDays?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly storeRaw?: boolean | undefined;
  readonly now?: (() => number) | undefined;
}

export interface IngestSpoolBatchOptions {
  readonly limit?: number | undefined;
}

export interface IngestSpoolBatchResult {
  readonly attempted: number;
  readonly ingested: number;
  readonly deleted: number;
  readonly deferred: number;
  readonly malformed: number;
  readonly errors: number;
}

export interface RetentionResult {
  readonly deletedByAge: number;
  readonly deletedBySize: number;
  readonly vacuumed: boolean;
}

export interface ClearDataResult {
  readonly deletedSpoolFiles: number;
  readonly clearGeneration: number;
  readonly clearBaselineTs: number;
}

export interface SpyHealthSnapshot {
  readonly schemaVersion: number;
  readonly dbSizeBytes: number;
  readonly dbUsedBytes: number;
  readonly spoolSizeBytes: number;
  readonly providerCallCount: number;
  readonly pendingCallCount: number;
  readonly counters: Readonly<Record<string, number>>;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SpyStore {
  ingestSpoolBatch(options?: IngestSpoolBatchOptions): IngestSpoolBatchResult;
  persistRequest(event: SpoolRequestEvent): void;
  persistResponse(event: SpoolResponseEvent): boolean;
  runRetention(): RetentionResult;
  clearData(): ClearDataResult;
  getHealthSnapshot(): SpyHealthSnapshot;
  close(): void;
}

interface CounterRow {
  readonly name: string;
  readonly value: number;
}

interface MetadataRow {
  readonly key: string;
  readonly value: string;
}

interface CountRow {
  readonly count: number;
}

interface IdRow {
  readonly id: string;
}

type PragmaRow = Readonly<Record<string, number>>;

class BunSqliteSpyStore implements SpyStore {
  private readonly db: Database;
  private readonly retentionDays: number;
  private readonly maxBytes: number;
  private readonly storeRaw: boolean;
  private readonly now: () => number;
  private locked = false;

  constructor(private readonly options: SpyStoreOptions) {
    this.retentionDays = positiveNumber(options.retentionDays, DEFAULT_RETENTION_DAYS);
    this.maxBytes = positiveNumber(options.maxBytes, DEFAULT_MAX_BYTES);
    this.storeRaw = options.storeRaw === true;
    this.now = options.now ?? (() => Date.now() / 1000);

    if (options.dbPath !== ":memory:") {
      mkdirSync(dirname(options.dbPath), { recursive: true });
    }
    mkdirSync(options.spoolDir, { recursive: true });

    this.db = new Database(options.dbPath, { create: true });
    this.db.run("PRAGMA foreign_keys = ON");
    applySpyMigrations(this.db);
    this.setMetadata("schema_version", String(currentSpySchemaVersion()));
  }

  ingestSpoolBatch(options: IngestSpoolBatchOptions = {}): IngestSpoolBatchResult {
    return this.withWriteLock(() => {
      const limit = Math.max(0, Math.trunc(options.limit ?? Number.MAX_SAFE_INTEGER));
      const files = this.spoolFiles().slice(0, limit);
      const result = {
        attempted: 0,
        ingested: 0,
        deleted: 0,
        deferred: 0,
        malformed: 0,
        errors: 0,
      };

      for (const path of files) {
        result.attempted += 1;
        const fileResult = this.ingestSpoolFileUnlocked(path);
        if (fileResult === "ingested") {
          result.ingested += 1;
          result.deleted += 1;
        } else if (fileResult === "malformed") {
          result.malformed += 1;
          result.deleted += 1;
        } else if (fileResult === "deferred") {
          result.deferred += 1;
        } else {
          result.errors += 1;
        }
      }

      if (result.ingested > 0) {
        this.setMetadata("last_ingest_at", String(this.now()));
      }
      return result;
    });
  }

  persistRequest(event: SpoolRequestEvent): void {
    this.withWriteLock(() => {
      this.persistRequestUnlocked(event);
    });
  }

  persistResponse(event: SpoolResponseEvent): boolean {
    return this.withWriteLock(() => this.persistResponseUnlocked(event));
  }

  runRetention(): RetentionResult {
    return this.withWriteLock(() => {
      let deletedByAge = 0;
      let deletedBySize = 0;
      this.db.transaction(() => {
        const cutoff = this.now() - this.retentionDays * 24 * 60 * 60;
        deletedByAge = this.deleteCallsBefore(cutoff);

        while (this.databaseUsedBytes() > this.maxBytes) {
          const deleted = this.deleteOldestCall();
          if (!deleted) {
            break;
          }
          deletedBySize += 1;
        }

        if (deletedByAge > 0 || deletedBySize > 0) {
          this.setMetadata("last_retention_at", String(this.now()));
          this.incrementCounter("retention_deleted_calls", deletedByAge + deletedBySize);
        }
      })();

      let vacuumed = false;
      if ((deletedByAge > 0 || deletedBySize > 0) && this.databaseSizeBytes() > this.maxBytes) {
        this.db.run("VACUUM");
        vacuumed = true;
      }
      return { deletedByAge, deletedBySize, vacuumed };
    });
  }

  clearData(): ClearDataResult {
    return this.withWriteLock(() => {
      const clearBaselineTs = this.now();
      const clearGeneration = this.clearGeneration() + 1;
      this.db.transaction(() => {
        this.db.run("DELETE FROM provider_call");
        this.db.run("DELETE FROM health_counter");
        this.setMetadata("clear_generation", String(clearGeneration));
        this.setMetadata("clear_baseline_ts", String(clearBaselineTs));
      })();

      const deletedSpoolFiles = this.clearSpoolFiles();
      return { deletedSpoolFiles, clearGeneration, clearBaselineTs };
    });
  }

  getHealthSnapshot(): SpyHealthSnapshot {
    return {
      schemaVersion: currentSpySchemaVersion(),
      dbSizeBytes: this.databaseSizeBytes(),
      dbUsedBytes: this.databaseUsedBytes(),
      spoolSizeBytes: this.spoolSizeBytes(),
      providerCallCount: this.countRows("provider_call"),
      pendingCallCount: this.countRows("provider_call", "status = 'pending'"),
      counters: this.healthCounters(),
      metadata: this.serviceMetadata(),
    };
  }

  close(): void {
    this.db.close();
  }

  private ingestSpoolFileUnlocked(path: string): "ingested" | "deferred" | "malformed" | "error" {
    let event: SpoolEvent;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8")) as unknown;
      event = SpoolEventSchema.parse(parsed);
    } catch (error) {
      this.recordMalformedSpoolFile(path, error);
      unlinkIfExists(path);
      return "malformed";
    }

    try {
      if (event.direction === "request") {
        this.persistRequestUnlocked(event);
      } else if (event.direction === "response") {
        if (!this.persistResponseUnlocked(event)) {
          return "deferred";
        }
      } else if (event.direction === "dropped") {
        this.persistDroppedEventUnlocked(event);
      } else if (event.direction === "error") {
        this.persistErrorEventUnlocked(event);
      } else {
        this.persistStreamChunkEventUnlocked(event);
      }
    } catch (error) {
      this.recordIngestError(path, error);
      return "error";
    }

    unlinkIfExists(path);
    return "ingested";
  }

  private persistRequestUnlocked(event: SpoolRequestEvent): void {
    const normalized = normalizeBedrockRequest(event, { storeRaw: this.storeRaw });
    const httpEvent = httpEventFromRequest(event, normalized.call.id);
    this.db.transaction(() => {
      this.upsertPendingCall(normalized.call);
      this.replaceHttpEvent(httpEvent);
      this.replaceBlocks(normalized.call.id, "request", normalized.blocks);
      this.replaceRawPayloads(normalized.call.id, "request", normalized.rawPayloads);
      this.incrementCounter("spool_request_events", 1);
      this.setMetadata("last_request_at", String(event.ts));
    })();
  }

  private persistResponseUnlocked(event: SpoolResponseEvent): boolean {
    const callId = bedrockCallIdForFlow(event.flow_id);
    if (!this.callExists(callId)) {
      return false;
    }

    const normalized = normalizeBedrockResponse(event, { storeRaw: this.storeRaw });
    const httpEvent = httpEventFromResponse(event, normalized.call.id);
    this.db.transaction(() => {
      this.updateResponseCall(normalized.call);
      this.replaceHttpEvent(httpEvent);
      this.replaceBlocks(normalized.call.id, "response", normalized.blocks);
      this.replaceUsageRecords(normalized.call.id, normalized.usage);
      this.replaceStreamEvents(normalized.call.id, normalized.streamEvents);
      this.replaceRawPayloads(normalized.call.id, "response", normalized.rawPayloads);
      this.incrementCounter("spool_response_events", 1);
      this.setMetadata("last_response_at", String(event.ts));
    })();
    return true;
  }

  private persistDroppedEventUnlocked(event: SpoolDroppedEvent): void {
    this.db.transaction(() => {
      this.incrementCounter("spool_dropped_events", 1);
      this.incrementCounter("captures_dropped", event.dropped_count);
      this.setMetadata("last_dropped_at", String(event.ts));
      this.setMetadata("last_dropped_event", JSON.stringify(event));
    })();
  }

  private persistErrorEventUnlocked(event: SpoolErrorEvent): void {
    this.db.transaction(() => {
      this.incrementCounter("spool_error_events", 1);
      this.setMetadata("last_spool_error_at", String(event.ts));
      this.setMetadata("last_spool_error", JSON.stringify(event));
      if (event.flow_id !== undefined) {
        const callId = bedrockCallIdForFlow(event.flow_id);
        if (this.callExists(callId)) {
          this.db.query(`
UPDATE provider_call
SET status = 'error',
    completed_at = ?,
    response_flow_id = ?
WHERE id = ?
`).run(event.ts, event.flow_id, callId);
        }
      }
    })();
  }

  private persistStreamChunkEventUnlocked(event: SpoolStreamChunkEvent): void {
    this.db.transaction(() => {
      this.incrementCounter("spool_stream_chunk_events", 1);
      this.setMetadata("last_stream_chunk_at", String(event.ts));
      this.setMetadata("last_stream_chunk_event", JSON.stringify({
        flow_id: event.flow_id,
        chunk_index: event.chunk_index,
        body_sha256: event.body_sha256,
      }));
    })();
  }

  private upsertPendingCall(call: ProviderCall): void {
    this.db.query(`
INSERT INTO provider_call (
  id, provider, operation, model_id, status, started_at,
  request_flow_id, request_content_hash
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  provider = excluded.provider,
  operation = excluded.operation,
  model_id = excluded.model_id,
  started_at = excluded.started_at,
  request_flow_id = excluded.request_flow_id,
  request_content_hash = excluded.request_content_hash,
  status = CASE
    WHEN provider_call.status = 'pending' THEN excluded.status
    ELSE provider_call.status
  END
`).run(
      call.id,
      call.provider,
      call.operation,
      call.model_id,
      call.status,
      call.started_at,
      call.request_flow_id,
      call.request_content_hash ?? null,
    );
  }

  private updateResponseCall(call: ProviderCall): void {
    this.db.query(`
UPDATE provider_call
SET status = ?,
    completed_at = ?,
    status_code = ?,
    response_flow_id = ?,
    response_content_hash = ?
WHERE id = ?
`).run(
      call.status,
      call.completed_at ?? null,
      call.status_code ?? null,
      call.response_flow_id ?? null,
      call.response_content_hash ?? null,
      call.id,
    );
  }

  private replaceHttpEvent(event: HttpEventRecord): void {
    HttpEventRecordSchema.parse(event);
    this.db.query("DELETE FROM http_event WHERE id = ?").run(event.id);
    this.db.query(`
INSERT INTO http_event (
  id, call_id, direction, observed_at, host, method, path, status_code, reason,
  headers_json, request_headers_json, body_text, body_b64, body_sha256,
  body_encoding, content_type
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
      event.id,
      event.call_id,
      event.direction,
      event.observed_at,
      event.host,
      event.method,
      event.path,
      event.status_code ?? null,
      event.reason ?? null,
      JSON.stringify(event.headers),
      event.request_headers === undefined ? null : JSON.stringify(event.request_headers),
      event.body_text ?? null,
      event.body_b64 ?? null,
      event.body_sha256 ?? null,
      event.body_encoding ?? null,
      event.content_type ?? null,
    );
  }

  private replaceBlocks(
    callId: string,
    direction: NormalizedBlock["direction"],
    blocks: readonly NormalizedBlock[],
  ): void {
    this.db.query("DELETE FROM normalized_block WHERE call_id = ? AND direction = ?").run(callId, direction);
    const insert = this.db.query(`
INSERT INTO normalized_block (
  id, call_id, direction, ordinal, role, kind, source, provider_path, text, json,
  char_size, byte_size, content_hash, cache_marker
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
    for (const block of blocks) {
      insert.run(
        block.id,
        block.call_id,
        block.direction,
        block.ordinal,
        block.role ?? null,
        block.kind,
        block.source,
        block.provider_path ?? null,
        block.text ?? null,
        block.json === undefined ? null : JSON.stringify(block.json),
        block.char_size,
        block.byte_size,
        block.content_hash,
        block.cache_marker ? 1 : 0,
      );
    }
  }

  private replaceUsageRecords(callId: string, usage: readonly UsageRecord[]): void {
    this.db.query("DELETE FROM usage_record WHERE call_id = ?").run(callId);
    const insert = this.db.query(`
INSERT INTO usage_record (
  id, call_id, source, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, total_tokens, raw_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
    for (const record of usage) {
      insert.run(
        record.id,
        record.call_id,
        record.source,
        record.input_tokens ?? null,
        record.output_tokens ?? null,
        record.cache_read_tokens ?? null,
        record.cache_write_tokens ?? null,
        record.total_tokens ?? null,
        record.raw === undefined ? null : JSON.stringify(record.raw),
      );
    }
  }

  private replaceStreamEvents(callId: string, events: readonly StreamEvent[]): void {
    this.db.query("DELETE FROM stream_event WHERE call_id = ?").run(callId);
    const insert = this.db.query(`
INSERT INTO stream_event (
  id, call_id, ordinal, event_type, headers_json, payload_json,
  payload_text, payload_sha256, observed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
    for (const event of events) {
      insert.run(
        event.id,
        event.call_id,
        event.ordinal,
        event.event_type,
        JSON.stringify(event.headers),
        event.payload === undefined ? null : JSON.stringify(event.payload),
        event.payload_text ?? null,
        event.payload_sha256 ?? null,
        event.observed_at ?? null,
      );
    }
  }

  private replaceRawPayloads(
    callId: string,
    direction: RawPayloadRecord["direction"],
    payloads: readonly RawPayloadRecord[],
  ): void {
    this.db.query("DELETE FROM raw_payload WHERE call_id = ? AND direction = ?").run(callId, direction);
    const insert = this.db.query(`
INSERT INTO raw_payload (
  id, call_id, direction, content_type, body_text, body_b64,
  body_sha256, body_encoding
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
    for (const payload of payloads) {
      insert.run(
        payload.id,
        payload.call_id,
        payload.direction,
        payload.content_type ?? null,
        payload.body_text ?? null,
        payload.body_b64 ?? null,
        payload.body_sha256 ?? null,
        payload.body_encoding ?? null,
      );
    }
  }

  private recordMalformedSpoolFile(path: string, error: unknown): void {
    this.db.transaction(() => {
      this.incrementCounter("spool_malformed_events", 1);
      this.setMetadata("last_malformed_spool_file", path);
      this.setMetadata("last_malformed_error", errorMessage(error));
    })();
  }

  private recordIngestError(path: string, error: unknown): void {
    this.db.transaction(() => {
      this.incrementCounter("spool_ingest_errors", 1);
      this.setMetadata("last_ingest_error_file", path);
      this.setMetadata("last_ingest_error", errorMessage(error));
    })();
  }

  private incrementCounter(name: string, amount: number): void {
    this.db.query(`
INSERT INTO health_counter (name, value)
VALUES (?, ?)
ON CONFLICT(name) DO UPDATE SET
  value = health_counter.value + excluded.value,
  updated_at = CURRENT_TIMESTAMP
`).run(name, amount);
  }

  private setMetadata(key: string, value: string): void {
    this.db.query(`
INSERT INTO service_metadata (key, value)
VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = CURRENT_TIMESTAMP
`).run(key, value);
  }

  private callExists(callId: string): boolean {
    const row = this.db.query("SELECT id FROM provider_call WHERE id = ?").get(callId) as IdRow | null;
    return row !== null;
  }

  private deleteCallsBefore(cutoff: number): number {
    const row = this.db.query("SELECT COUNT(*) AS count FROM provider_call WHERE started_at < ?").get(cutoff) as CountRow | null;
    const count = row?.count ?? 0;
    this.db.query("DELETE FROM provider_call WHERE started_at < ?").run(cutoff);
    return count;
  }

  private deleteOldestCall(): boolean {
    const row = this.db.query("SELECT id FROM provider_call ORDER BY started_at ASC, id ASC LIMIT 1").get() as IdRow | null;
    if (row === null) {
      return false;
    }
    this.db.query("DELETE FROM provider_call WHERE id = ?").run(row.id);
    return true;
  }

  private countRows(table: string, where?: string): number {
    const sql = where === undefined ? `SELECT COUNT(*) AS count FROM ${table}` : `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`;
    const row = this.db.query(sql).get() as CountRow | null;
    return row?.count ?? 0;
  }

  private clearGeneration(): number {
    const row = this.db.query("SELECT value FROM service_metadata WHERE key = 'clear_generation'").get() as { readonly value: string } | null;
    const parsed = row === null ? 0 : Number.parseInt(row.value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private databaseSizeBytes(): number {
    return this.pragmaNumber("page_count") * this.pragmaNumber("page_size");
  }

  private databaseUsedBytes(): number {
    const usedPages = Math.max(0, this.pragmaNumber("page_count") - this.pragmaNumber("freelist_count"));
    return usedPages * this.pragmaNumber("page_size");
  }

  private pragmaNumber(name: "page_count" | "page_size" | "freelist_count"): number {
    const row = this.db.query(`PRAGMA ${name}`).get() as PragmaRow | null;
    return row?.[name] ?? 0;
  }

  private healthCounters(): Readonly<Record<string, number>> {
    const rows = this.db.query("SELECT name, value FROM health_counter ORDER BY name").all() as CounterRow[];
    const counters: Record<string, number> = {};
    for (const row of rows) {
      counters[row.name] = row.value;
    }
    return counters;
  }

  private serviceMetadata(): Readonly<Record<string, string>> {
    const rows = this.db.query("SELECT key, value FROM service_metadata ORDER BY key").all() as MetadataRow[];
    const metadata: Record<string, string> = {};
    for (const row of rows) {
      metadata[row.key] = row.value;
    }
    return metadata;
  }

  private spoolFiles(): string[] {
    if (!existsSync(this.options.spoolDir)) {
      return [];
    }
    return readdirSync(this.options.spoolDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".json"))
      .map((entry) => join(this.options.spoolDir, entry.name))
      .sort();
  }

  private clearSpoolFiles(): number {
    if (!existsSync(this.options.spoolDir)) {
      return 0;
    }
    let deleted = 0;
    for (const entry of readdirSync(this.options.spoolDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(".")) {
        continue;
      }
      unlinkIfExists(join(this.options.spoolDir, entry.name));
      deleted += 1;
    }
    return deleted;
  }

  private spoolSizeBytes(): number {
    if (!existsSync(this.options.spoolDir)) {
      return 0;
    }
    let total = 0;
    for (const entry of readdirSync(this.options.spoolDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      total += statSync(join(this.options.spoolDir, entry.name)).size;
    }
    return total;
  }

  private withWriteLock<T>(action: () => T): T {
    if (this.locked) {
      throw new Error("spy store write already in progress");
    }
    this.locked = true;
    try {
      return action();
    } finally {
      this.locked = false;
    }
  }
}

export function openSpyStore(options: SpyStoreOptions): SpyStore {
  return new BunSqliteSpyStore(options);
}

function httpEventFromRequest(event: SpoolRequestEvent, callId: string): HttpEventRecord {
  return {
    id: `http-${callId}-request`,
    call_id: callId,
    direction: "request",
    observed_at: event.ts,
    host: event.host,
    method: event.method,
    path: event.path,
    headers: event.headers,
    ...(contentType(event.headers) === undefined ? {} : { content_type: contentType(event.headers) }),
  };
}

function httpEventFromResponse(event: SpoolResponseEvent, callId: string): HttpEventRecord {
  return {
    id: `http-${callId}-response`,
    call_id: callId,
    direction: "response",
    observed_at: event.ts,
    host: event.host,
    method: event.method,
    path: event.path,
    status_code: event.status_code,
    reason: event.reason,
    headers: event.headers,
    request_headers: event.request_headers,
    ...(contentType(event.headers) === undefined ? {} : { content_type: contentType(event.headers) }),
  };
}

function contentType(headers: readonly (readonly [string, string])[]): string | undefined {
  const pair = headers.find(([name]) => name.toLowerCase() === "content-type");
  return pair?.[1];
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unlinkIfExists(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort cleanup; ingestion counters preserve the failure context.
  }
}
