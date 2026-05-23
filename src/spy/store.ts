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
  NormalizedBlockSchema,
  ProviderCallSchema,
  RawPayloadRecordSchema,
  SpoolEventSchema,
  StreamEventSchema,
  UsageRecordSchema,
  type DiffClassification,
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
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 500;
const REQUEST_COMPOSITION_SECTION_ORDER: readonly NormalizedBlock["kind"][] = [
  "provider-envelope",
  "harness-system-context",
  "user-visible-message",
  "prior-conversation-history",
  "current-user-input",
  "assistant-output",
  "thinking",
  "tool-definition",
  "tool-call",
  "tool-result",
  "cache-marker",
  "media-summary",
  "unknown",
];

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

export interface SpyUsageSummary {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly totalTokens: number | null;
}

export interface SpyCallSummary {
  readonly call: ProviderCall;
  readonly durationMs: number | null;
  readonly usage: SpyUsageSummary;
  readonly requestBlockCount: number;
  readonly responseBlockCount: number;
  readonly requestByteSize: number;
  readonly responseByteSize: number;
  readonly cacheMarkerCount: number;
  readonly streamEventCount: number;
  readonly rawPayloadCount: number;
}

export interface SpyRequestCompositionSection {
  readonly kind: NormalizedBlock["kind"];
  readonly present: boolean;
  readonly blockCount: number;
  readonly messageCount: number;
  readonly charSize: number;
  readonly byteSize: number;
}

export interface SpyRequestComposition {
  readonly totalBlockCount: number;
  readonly totalMessageCount: number;
  readonly totalCharSize: number;
  readonly totalByteSize: number;
  readonly sections: readonly SpyRequestCompositionSection[];
  readonly toolDefinitionCount: number;
  readonly toolSchemaCharSize: number;
  readonly toolSchemaByteSize: number;
  readonly cacheMarkerCount: number;
  readonly cacheMarkerCharSize: number;
  readonly cacheMarkerByteSize: number;
  readonly mediaSummaryCount: number;
  readonly mediaSummaryCharSize: number;
  readonly mediaSummaryByteSize: number;
  readonly usage: SpyUsageSummary;
}

export interface SpyPaginatedResult<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string | undefined;
}

export interface SpyListCallsOptions {
  readonly since?: number | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface SpySearchCallsOptions {
  readonly query: string;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface SpyStreamEventsOptions {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface SpyCallDetail {
  readonly summary: SpyCallSummary;
  readonly requestComposition: SpyRequestComposition;
  readonly httpEvents: readonly HttpEventRecord[];
  readonly blocks: readonly NormalizedBlock[];
  readonly usageRecords: readonly UsageRecord[];
  readonly rawPayloads: readonly RawPayloadRecord[];
}

export interface SpyBlockDiff {
  readonly block: NormalizedBlock;
  readonly classification: DiffClassification;
  readonly previousBlockId?: string | undefined;
}

export interface SpyCallDiff {
  readonly call: SpyCallSummary;
  readonly previousCall: SpyCallSummary | null;
  readonly blocks: readonly SpyBlockDiff[];
}

export interface SpyStore {
  ingestSpoolBatch(options?: IngestSpoolBatchOptions): IngestSpoolBatchResult;
  persistRequest(event: SpoolRequestEvent): void;
  persistResponse(event: SpoolResponseEvent): boolean;
  listCallSummaries(options?: SpyListCallsOptions): SpyPaginatedResult<SpyCallSummary>;
  getCallDetail(callId: string): SpyCallDetail | null;
  getCallDiff(callId: string): SpyCallDiff | null;
  getStreamEvents(callId: string, options?: SpyStreamEventsOptions): SpyPaginatedResult<StreamEvent>;
  searchCallSummaries(options: SpySearchCallsOptions): SpyPaginatedResult<SpyCallSummary>;
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

interface SumRow {
  readonly total: number | null;
}

interface IdRow {
  readonly id: string;
}

type PragmaRow = Readonly<Record<string, number>>;

interface ProviderCallRow {
  readonly id: string;
  readonly provider: "bedrock";
  readonly operation: string;
  readonly model_id: string;
  readonly status: ProviderCall["status"];
  readonly started_at: number;
  readonly completed_at: number | null;
  readonly status_code: number | null;
  readonly request_flow_id: string;
  readonly response_flow_id: string | null;
  readonly request_content_hash: string | null;
  readonly response_content_hash: string | null;
}

interface HttpEventRow {
  readonly id: string;
  readonly call_id: string;
  readonly direction: "request" | "response";
  readonly observed_at: number;
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly status_code: number | null;
  readonly reason: string | null;
  readonly headers_json: string;
  readonly request_headers_json: string | null;
  readonly body_text: string | null;
  readonly body_b64: string | null;
  readonly body_sha256: string | null;
  readonly body_encoding: "aws-eventstream" | null;
  readonly content_type: string | null;
}

interface NormalizedBlockRow {
  readonly id: string;
  readonly call_id: string;
  readonly direction: "request" | "response";
  readonly ordinal: number;
  readonly role: string | null;
  readonly kind: NormalizedBlock["kind"];
  readonly source: string;
  readonly provider_path: string | null;
  readonly text: string | null;
  readonly json: string | null;
  readonly char_size: number;
  readonly byte_size: number;
  readonly content_hash: string;
  readonly cache_marker: number;
}

interface UsageRecordRow {
  readonly id: string;
  readonly call_id: string;
  readonly source: "provider-reported";
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly total_tokens: number | null;
  readonly raw_json: string | null;
}

interface StreamEventRow {
  readonly id: string;
  readonly call_id: string;
  readonly ordinal: number;
  readonly event_type: string;
  readonly headers_json: string;
  readonly payload_json: string | null;
  readonly payload_text: string | null;
  readonly payload_sha256: string | null;
  readonly observed_at: number | null;
}

interface RawPayloadRow {
  readonly id: string;
  readonly call_id: string;
  readonly direction: "request" | "response";
  readonly content_type: string | null;
  readonly body_text: string | null;
  readonly body_b64: string | null;
  readonly body_sha256: string | null;
  readonly body_encoding: "aws-eventstream" | null;
}

interface UsageSummaryRow {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly total_tokens: number | null;
}

type SqlParam = string | number;

interface CallCursor {
  readonly startedAt: number;
  readonly id: string;
}

interface StreamCursor {
  readonly ordinal: number;
  readonly id: string;
}

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

  listCallSummaries(options: SpyListCallsOptions = {}): SpyPaginatedResult<SpyCallSummary> {
    const limit = queryLimit(options.limit);
    const cursor = options.cursor === undefined ? undefined : decodeCallCursor(options.cursor);
    const conditions: string[] = [];
    const params: SqlParam[] = [];

    if (options.since !== undefined) {
      conditions.push("started_at >= ?");
      params.push(options.since);
    }
    if (cursor !== undefined) {
      conditions.push("(started_at < ? OR (started_at = ? AND id < ?))");
      params.push(cursor.startedAt, cursor.startedAt, cursor.id);
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.db.query(`
SELECT id, provider, operation, model_id, status, started_at, completed_at,
       status_code, request_flow_id, response_flow_id, request_content_hash,
       response_content_hash
FROM provider_call
${where}
ORDER BY started_at DESC, id DESC
LIMIT ?
`).all(...params, limit + 1) as ProviderCallRow[];

    return this.paginatedCallSummaries(rows, limit);
  }

  getCallDetail(callId: string): SpyCallDetail | null {
    const row = this.callRow(callId);
    if (row === null) {
      return null;
    }

    const summary = this.callSummaryForRow(row);
    const httpEvents = this.db.query(`
SELECT id, call_id, direction, observed_at, host, method, path, status_code,
       reason, headers_json, request_headers_json, body_text, body_b64,
       body_sha256, body_encoding, content_type
FROM http_event
WHERE call_id = ?
ORDER BY observed_at ASC, direction ASC
`).all(callId) as HttpEventRow[];

    const blocks = this.blocksForCall(callId);
    return {
      summary,
      requestComposition: requestCompositionForBlocks(
        blocks.filter((block) => block.direction === "request"),
        summary.usage,
      ),
      httpEvents: httpEvents.map(httpEventFromRow),
      blocks,
      usageRecords: this.usageRecordsForCall(callId),
      rawPayloads: this.rawPayloadsForCall(callId),
    };
  }

  getCallDiff(callId: string): SpyCallDiff | null {
    const row = this.callRow(callId);
    if (row === null) {
      return null;
    }

    const previousRow = this.db.query(`
SELECT id, provider, operation, model_id, status, started_at, completed_at,
       status_code, request_flow_id, response_flow_id, request_content_hash,
       response_content_hash
FROM provider_call
WHERE provider = ?
  AND model_id = ?
  AND operation = ?
  AND (started_at < ? OR (started_at = ? AND id < ?))
ORDER BY started_at DESC, id DESC
LIMIT 1
`).get(row.provider, row.model_id, row.operation, row.started_at, row.started_at, row.id) as ProviderCallRow | null;

    const currentBlocks = this.blocksForCall(callId, "request");
    const previousBlocks = previousRow === null ? [] : this.blocksForCall(previousRow.id, "request");
    const previousByHash = new Map<string, NormalizedBlock>();
    const previousBySignature = new Map<string, NormalizedBlock>();
    for (const block of previousBlocks) {
      previousByHash.set(block.content_hash, block);
      previousBySignature.set(blockSignature(block), block);
    }

    const diffs = currentBlocks.map((block): SpyBlockDiff => {
      if (previousRow === null) {
        return { block, classification: "unknown" };
      }
      const hashMatch = previousByHash.get(block.content_hash);
      if (hashMatch !== undefined) {
        return { block, classification: "repeated", previousBlockId: hashMatch.id };
      }
      const signatureMatch = previousBySignature.get(blockSignature(block));
      if (signatureMatch !== undefined) {
        return { block, classification: "changed", previousBlockId: signatureMatch.id };
      }
      return { block, classification: "new" };
    });

    return {
      call: this.callSummaryForRow(row),
      previousCall: previousRow === null ? null : this.callSummaryForRow(previousRow),
      blocks: diffs,
    };
  }

  getStreamEvents(callId: string, options: SpyStreamEventsOptions = {}): SpyPaginatedResult<StreamEvent> {
    const limit = queryLimit(options.limit);
    const cursor = options.cursor === undefined ? undefined : decodeStreamCursor(options.cursor);
    const conditions = ["call_id = ?"];
    const params: SqlParam[] = [callId];
    if (cursor !== undefined) {
      conditions.push("(ordinal > ? OR (ordinal = ? AND id > ?))");
      params.push(cursor.ordinal, cursor.ordinal, cursor.id);
    }

    const rows = this.db.query(`
SELECT id, call_id, ordinal, event_type, headers_json, payload_json,
       payload_text, payload_sha256, observed_at
FROM stream_event
WHERE ${conditions.join(" AND ")}
ORDER BY ordinal ASC, id ASC
LIMIT ?
`).all(...params, limit + 1) as StreamEventRow[];

    const pageRows = rows.slice(0, limit);
    const items = pageRows.map(streamEventFromRow);
    if (rows.length <= limit) {
      return { items };
    }
    const last = pageRows.at(-1);
    return last === undefined ? { items } : { items, nextCursor: encodeStreamCursor({ ordinal: last.ordinal, id: last.id }) };
  }

  searchCallSummaries(options: SpySearchCallsOptions): SpyPaginatedResult<SpyCallSummary> {
    const ftsQuery = ftsQueryForSearch(options.query);
    if (ftsQuery === null) {
      return { items: [] };
    }

    const limit = queryLimit(options.limit);
    const cursor = options.cursor === undefined ? undefined : decodeCallCursor(options.cursor);
    const callConditions: string[] = [];
    const params: SqlParam[] = [ftsQuery];
    if (cursor !== undefined) {
      callConditions.push("(pc.started_at < ? OR (pc.started_at = ? AND pc.id < ?))");
      params.push(cursor.startedAt, cursor.startedAt, cursor.id);
    }
    const callWhere = callConditions.length === 0 ? "" : `WHERE ${callConditions.join(" AND ")}`;

    const rows = this.db.query(`
WITH matched_call AS (
  SELECT DISTINCT nb.call_id
  FROM normalized_block_fts
  JOIN normalized_block nb ON nb.id = normalized_block_fts.block_id
  WHERE normalized_block_fts MATCH ?
)
SELECT pc.id, pc.provider, pc.operation, pc.model_id, pc.status, pc.started_at,
       pc.completed_at, pc.status_code, pc.request_flow_id, pc.response_flow_id,
       pc.request_content_hash, pc.response_content_hash
FROM provider_call pc
JOIN matched_call matched ON matched.call_id = pc.id
${callWhere}
ORDER BY pc.started_at DESC, pc.id DESC
LIMIT ?
`).all(...params, limit + 1) as ProviderCallRow[];

    return this.paginatedCallSummaries(rows, limit);
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

  private paginatedCallSummaries(rows: readonly ProviderCallRow[], limit: number): SpyPaginatedResult<SpyCallSummary> {
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row) => this.callSummaryForRow(row));
    if (rows.length <= limit) {
      return { items };
    }
    const last = pageRows.at(-1);
    return last === undefined ? { items } : {
      items,
      nextCursor: encodeCallCursor({ startedAt: last.started_at, id: last.id }),
    };
  }

  private callRow(callId: string): ProviderCallRow | null {
    return this.db.query(`
SELECT id, provider, operation, model_id, status, started_at, completed_at,
       status_code, request_flow_id, response_flow_id, request_content_hash,
       response_content_hash
FROM provider_call
WHERE id = ?
`).get(callId) as ProviderCallRow | null;
  }

  private callSummaryForRow(row: ProviderCallRow): SpyCallSummary {
    const call = providerCallFromRow(row);
    const completedAt = call.completed_at ?? null;
    return {
      call,
      durationMs: completedAt === null ? null : Math.max(0, Math.round((completedAt - call.started_at) * 1000)),
      usage: this.usageSummaryForCall(call.id),
      requestBlockCount: this.countRows("normalized_block", "call_id = ? AND direction = 'request'", [call.id]),
      responseBlockCount: this.countRows("normalized_block", "call_id = ? AND direction = 'response'", [call.id]),
      requestByteSize: this.sumRows("normalized_block", "byte_size", "call_id = ? AND direction = 'request'", [call.id]),
      responseByteSize: this.sumRows("normalized_block", "byte_size", "call_id = ? AND direction = 'response'", [call.id]),
      cacheMarkerCount: this.countRows("normalized_block", "call_id = ? AND cache_marker = 1", [call.id]),
      streamEventCount: this.countRows("stream_event", "call_id = ?", [call.id]),
      rawPayloadCount: this.countRows("raw_payload", "call_id = ?", [call.id]),
    };
  }

  private usageSummaryForCall(callId: string): SpyUsageSummary {
    const row = this.db.query(`
SELECT SUM(input_tokens) AS input_tokens,
       SUM(output_tokens) AS output_tokens,
       SUM(cache_read_tokens) AS cache_read_tokens,
       SUM(cache_write_tokens) AS cache_write_tokens,
       SUM(total_tokens) AS total_tokens
FROM usage_record
WHERE call_id = ?
`).get(callId) as UsageSummaryRow | null;

    return {
      inputTokens: row?.input_tokens ?? null,
      outputTokens: row?.output_tokens ?? null,
      cacheReadTokens: row?.cache_read_tokens ?? null,
      cacheWriteTokens: row?.cache_write_tokens ?? null,
      totalTokens: row?.total_tokens ?? null,
    };
  }

  private blocksForCall(callId: string, direction?: NormalizedBlock["direction"]): NormalizedBlock[] {
    const where = direction === undefined ? "call_id = ?" : "call_id = ? AND direction = ?";
    const params = direction === undefined ? [callId] : [callId, direction];
    const rows = this.db.query(`
SELECT id, call_id, direction, ordinal, role, kind, source, provider_path,
       text, json, char_size, byte_size, content_hash, cache_marker
FROM normalized_block
WHERE ${where}
ORDER BY direction ASC, ordinal ASC, id ASC
`).all(...params) as NormalizedBlockRow[];
    return rows.map(normalizedBlockFromRow);
  }

  private usageRecordsForCall(callId: string): UsageRecord[] {
    const rows = this.db.query(`
SELECT id, call_id, source, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, total_tokens, raw_json
FROM usage_record
WHERE call_id = ?
ORDER BY id ASC
`).all(callId) as UsageRecordRow[];
    return rows.map(usageRecordFromRow);
  }

  private rawPayloadsForCall(callId: string): RawPayloadRecord[] {
    const rows = this.db.query(`
SELECT id, call_id, direction, content_type, body_text, body_b64, body_sha256,
       body_encoding
FROM raw_payload
WHERE call_id = ?
ORDER BY direction ASC, id ASC
`).all(callId) as RawPayloadRow[];
    return rows.map(rawPayloadFromRow);
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

  private countRows(table: string, where?: string, params: readonly SqlParam[] = []): number {
    const sql = where === undefined ? `SELECT COUNT(*) AS count FROM ${table}` : `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`;
    const row = this.db.query(sql).get(...params) as CountRow | null;
    return row?.count ?? 0;
  }

  private sumRows(table: string, column: string, where: string, params: readonly SqlParam[]): number {
    const row = this.db.query(`SELECT SUM(${column}) AS total FROM ${table} WHERE ${where}`).get(...params) as SumRow | null;
    return row?.total ?? 0;
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

function requestCompositionForBlocks(
  requestBlocks: readonly NormalizedBlock[],
  usage: SpyUsageSummary,
): SpyRequestComposition {
  const totalMessageIndexes = new Set<number>();
  const sections = new Map<NormalizedBlock["kind"], {
    blockCount: number;
    messageIndexes: Set<number>;
    charSize: number;
    byteSize: number;
  }>();
  for (const kind of REQUEST_COMPOSITION_SECTION_ORDER) {
    sections.set(kind, {
      blockCount: 0,
      messageIndexes: new Set<number>(),
      charSize: 0,
      byteSize: 0,
    });
  }

  let totalCharSize = 0;
  let totalByteSize = 0;
  let toolDefinitionCount = 0;
  let toolSchemaCharSize = 0;
  let toolSchemaByteSize = 0;
  let cacheMarkerCount = 0;
  let cacheMarkerCharSize = 0;
  let cacheMarkerByteSize = 0;
  let mediaSummaryCount = 0;
  let mediaSummaryCharSize = 0;
  let mediaSummaryByteSize = 0;

  for (const block of requestBlocks) {
    totalCharSize += block.char_size;
    totalByteSize += block.byte_size;

    const section = sections.get(block.kind);
    if (section !== undefined) {
      section.blockCount += 1;
      section.charSize += block.char_size;
      section.byteSize += block.byte_size;
      const messageIndex = messageIndexForBlock(block);
      if (messageIndex !== undefined) {
        section.messageIndexes.add(messageIndex);
        totalMessageIndexes.add(messageIndex);
      }
    }

    if (block.kind === "tool-definition") {
      toolDefinitionCount += 1;
      toolSchemaCharSize += block.char_size;
      toolSchemaByteSize += block.byte_size;
    }
    if (block.kind === "cache-marker" || block.cache_marker) {
      cacheMarkerCount += 1;
      cacheMarkerCharSize += block.char_size;
      cacheMarkerByteSize += block.byte_size;
    }
    if (block.kind === "media-summary") {
      mediaSummaryCount += 1;
      mediaSummaryCharSize += block.char_size;
      mediaSummaryByteSize += block.byte_size;
    }
  }

  return {
    totalBlockCount: requestBlocks.length,
    totalMessageCount: totalMessageIndexes.size,
    totalCharSize,
    totalByteSize,
    sections: REQUEST_COMPOSITION_SECTION_ORDER.map((kind): SpyRequestCompositionSection => {
      const section = sections.get(kind);
      if (section === undefined) {
        throw new Error(`missing request composition section ${kind}`);
      }
      return {
        kind,
        present: section.blockCount > 0,
        blockCount: section.blockCount,
        messageCount: section.messageIndexes.size,
        charSize: section.charSize,
        byteSize: section.byteSize,
      };
    }),
    toolDefinitionCount,
    toolSchemaCharSize,
    toolSchemaByteSize,
    cacheMarkerCount,
    cacheMarkerCharSize,
    cacheMarkerByteSize,
    mediaSummaryCount,
    mediaSummaryCharSize,
    mediaSummaryByteSize,
    usage,
  };
}

function messageIndexForBlock(block: NormalizedBlock): number | undefined {
  const match = /^\$\.messages\[(\d+)\]/.exec(block.provider_path ?? "");
  if (match === null) {
    return undefined;
  }
  return Number(match[1]);
}

function providerCallFromRow(row: ProviderCallRow): ProviderCall {
  return ProviderCallSchema.parse({
    id: row.id,
    provider: row.provider,
    operation: row.operation,
    model_id: row.model_id,
    status: row.status,
    started_at: row.started_at,
    ...(row.completed_at === null ? {} : { completed_at: row.completed_at }),
    ...(row.status_code === null ? {} : { status_code: row.status_code }),
    request_flow_id: row.request_flow_id,
    ...(row.response_flow_id === null ? {} : { response_flow_id: row.response_flow_id }),
    ...(row.request_content_hash === null ? {} : { request_content_hash: row.request_content_hash }),
    ...(row.response_content_hash === null ? {} : { response_content_hash: row.response_content_hash }),
  });
}

function httpEventFromRow(row: HttpEventRow): HttpEventRecord {
  return HttpEventRecordSchema.parse({
    id: row.id,
    call_id: row.call_id,
    direction: row.direction,
    observed_at: row.observed_at,
    host: row.host,
    method: row.method,
    path: row.path,
    ...(row.status_code === null ? {} : { status_code: row.status_code }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    headers: parseJson(row.headers_json),
    ...(row.request_headers_json === null ? {} : { request_headers: parseJson(row.request_headers_json) }),
    ...(row.body_text === null ? {} : { body_text: row.body_text }),
    ...(row.body_b64 === null ? {} : { body_b64: row.body_b64 }),
    ...(row.body_sha256 === null ? {} : { body_sha256: row.body_sha256 }),
    ...(row.body_encoding === null ? {} : { body_encoding: row.body_encoding }),
    ...(row.content_type === null ? {} : { content_type: row.content_type }),
  });
}

function normalizedBlockFromRow(row: NormalizedBlockRow): NormalizedBlock {
  return NormalizedBlockSchema.parse({
    id: row.id,
    call_id: row.call_id,
    direction: row.direction,
    ordinal: row.ordinal,
    ...(row.role === null ? {} : { role: row.role }),
    kind: row.kind,
    source: row.source,
    ...(row.provider_path === null ? {} : { provider_path: row.provider_path }),
    ...(row.text === null ? {} : { text: row.text }),
    ...(row.json === null ? {} : { json: parseJson(row.json) }),
    char_size: row.char_size,
    byte_size: row.byte_size,
    content_hash: row.content_hash,
    cache_marker: row.cache_marker === 1,
  });
}

function usageRecordFromRow(row: UsageRecordRow): UsageRecord {
  return UsageRecordSchema.parse({
    id: row.id,
    call_id: row.call_id,
    source: row.source,
    ...(row.input_tokens === null ? {} : { input_tokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { output_tokens: row.output_tokens }),
    ...(row.cache_read_tokens === null ? {} : { cache_read_tokens: row.cache_read_tokens }),
    ...(row.cache_write_tokens === null ? {} : { cache_write_tokens: row.cache_write_tokens }),
    ...(row.total_tokens === null ? {} : { total_tokens: row.total_tokens }),
    ...(row.raw_json === null ? {} : { raw: parseJson(row.raw_json) }),
  });
}

function streamEventFromRow(row: StreamEventRow): StreamEvent {
  return StreamEventSchema.parse({
    id: row.id,
    call_id: row.call_id,
    ordinal: row.ordinal,
    event_type: row.event_type,
    headers: parseJson(row.headers_json),
    ...(row.payload_json === null ? {} : { payload: parseJson(row.payload_json) }),
    ...(row.payload_text === null ? {} : { payload_text: row.payload_text }),
    ...(row.payload_sha256 === null ? {} : { payload_sha256: row.payload_sha256 }),
    ...(row.observed_at === null ? {} : { observed_at: row.observed_at }),
  });
}

function rawPayloadFromRow(row: RawPayloadRow): RawPayloadRecord {
  return RawPayloadRecordSchema.parse({
    id: row.id,
    call_id: row.call_id,
    direction: row.direction,
    ...(row.content_type === null ? {} : { content_type: row.content_type }),
    ...(row.body_text === null ? {} : { body_text: row.body_text }),
    ...(row.body_b64 === null ? {} : { body_b64: row.body_b64 }),
    ...(row.body_sha256 === null ? {} : { body_sha256: row.body_sha256 }),
    ...(row.body_encoding === null ? {} : { body_encoding: row.body_encoding }),
  });
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function queryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_QUERY_LIMIT;
  }
  return Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.trunc(value)));
}

function encodeCallCursor(cursor: CallCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCallCursor(cursor: string): CallCursor {
  const value = parseCursor(cursor);
  if (
    typeof value === "object"
    && value !== null
    && "startedAt" in value
    && "id" in value
    && typeof value.startedAt === "number"
    && typeof value.id === "string"
  ) {
    return { startedAt: value.startedAt, id: value.id };
  }
  throw new Error("invalid call cursor");
}

function encodeStreamCursor(cursor: StreamCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeStreamCursor(cursor: string): StreamCursor {
  const value = parseCursor(cursor);
  if (
    typeof value === "object"
    && value !== null
    && "ordinal" in value
    && "id" in value
    && typeof value.ordinal === "number"
    && typeof value.id === "string"
  ) {
    return { ordinal: value.ordinal, id: value.id };
  }
  throw new Error("invalid stream cursor");
}

function parseCursor(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid cursor");
  }
}

function ftsQueryForSearch(query: string): string | null {
  const tokens = query
    .trim()
    .split(/[^A-Za-z0-9_]+/)
    .filter((token) => token.length > 0)
    .slice(0, 16);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${token.replaceAll("\"", "\"\"")}"`).join(" AND ");
}

function blockSignature(block: NormalizedBlock): string {
  return [
    block.direction,
    block.ordinal,
    block.kind,
    block.role ?? "",
    block.source,
    block.provider_path ?? "",
  ].join("\u001f");
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
