import type { Database } from "bun:sqlite";

export interface SpyMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const SPY_SQLITE_MIGRATIONS: readonly SpyMigration[] = [
  {
    version: 1,
    name: "initial spy capture schema",
    sql: `
CREATE TABLE IF NOT EXISTS provider_call (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'error', 'dropped')),
  started_at REAL NOT NULL,
  completed_at REAL,
  status_code INTEGER,
  request_flow_id TEXT NOT NULL,
  response_flow_id TEXT,
  request_content_hash TEXT,
  response_content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_call_request_flow_id_idx
  ON provider_call(request_flow_id);
CREATE INDEX IF NOT EXISTS provider_call_started_at_idx
  ON provider_call(started_at);
CREATE INDEX IF NOT EXISTS provider_call_model_started_idx
  ON provider_call(provider, model_id, operation, started_at);

CREATE TABLE IF NOT EXISTS http_event (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES provider_call(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('request', 'response')),
  observed_at REAL NOT NULL,
  host TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER,
  reason TEXT,
  headers_json TEXT NOT NULL,
  request_headers_json TEXT,
  body_text TEXT,
  body_b64 TEXT,
  body_sha256 TEXT,
  body_encoding TEXT,
  content_type TEXT
);

CREATE INDEX IF NOT EXISTS http_event_call_direction_idx
  ON http_event(call_id, direction);

CREATE TABLE IF NOT EXISTS normalized_block (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES provider_call(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('request', 'response')),
  ordinal INTEGER NOT NULL,
  role TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  provider_path TEXT,
  text TEXT,
  json TEXT,
  char_size INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  cache_marker INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS normalized_block_call_ordinal_idx
  ON normalized_block(call_id, direction, ordinal);
CREATE INDEX IF NOT EXISTS normalized_block_hash_idx
  ON normalized_block(content_hash);
CREATE INDEX IF NOT EXISTS normalized_block_kind_idx
  ON normalized_block(kind);
CREATE VIRTUAL TABLE IF NOT EXISTS normalized_block_fts
  USING fts5(block_id UNINDEXED, text);

CREATE TABLE IF NOT EXISTS usage_record (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES provider_call(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS usage_record_call_idx
  ON usage_record(call_id);

CREATE TABLE IF NOT EXISTS stream_event (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES provider_call(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  payload_json TEXT,
  payload_text TEXT,
  payload_sha256 TEXT,
  observed_at REAL
);

CREATE INDEX IF NOT EXISTS stream_event_call_ordinal_idx
  ON stream_event(call_id, ordinal);
CREATE INDEX IF NOT EXISTS stream_event_type_idx
  ON stream_event(event_type);

CREATE TABLE IF NOT EXISTS raw_payload (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES provider_call(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('request', 'response')),
  content_type TEXT,
  body_text TEXT,
  body_b64 TEXT,
  body_sha256 TEXT,
  body_encoding TEXT
);

CREATE INDEX IF NOT EXISTS raw_payload_call_idx
  ON raw_payload(call_id);

CREATE TABLE IF NOT EXISTS health_counter (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`,
  },
  {
    version: 2,
    name: "normalized block fts triggers",
    sql: `
CREATE TRIGGER IF NOT EXISTS normalized_block_fts_insert
AFTER INSERT ON normalized_block
WHEN NEW.text IS NOT NULL
BEGIN
  INSERT INTO normalized_block_fts(block_id, text)
    VALUES (NEW.id, NEW.text);
END;

CREATE TRIGGER IF NOT EXISTS normalized_block_fts_update
AFTER UPDATE OF text ON normalized_block
BEGIN
  DELETE FROM normalized_block_fts WHERE block_id = OLD.id;
  INSERT INTO normalized_block_fts(block_id, text)
    SELECT NEW.id, NEW.text WHERE NEW.text IS NOT NULL;
END;

CREATE TRIGGER IF NOT EXISTS normalized_block_fts_delete
AFTER DELETE ON normalized_block
BEGIN
  DELETE FROM normalized_block_fts WHERE block_id = OLD.id;
END;

INSERT INTO normalized_block_fts(block_id, text)
  SELECT id, text
  FROM normalized_block
  WHERE text IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM normalized_block_fts
      WHERE normalized_block_fts.block_id = normalized_block.id
    );
`,
  },
  {
    version: 3,
    name: "token count cache",
    sql: `
CREATE TABLE IF NOT EXISTS token_count (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES provider_call(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('call', 'section', 'block')),
  direction TEXT CHECK (direction IN ('request', 'response')),
  block_id TEXT,
  kind TEXT,
  source_hash TEXT NOT NULL,
  cache_key TEXT NOT NULL UNIQUE,
  model_id TEXT NOT NULL,
  tokens INTEGER,
  provenance TEXT NOT NULL CHECK (provenance = 'provider_counted'),
  counted_at REAL NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS token_count_call_idx
  ON token_count(call_id);
CREATE INDEX IF NOT EXISTS token_count_subject_idx
  ON token_count(subject_type, call_id, direction, block_id, kind);
`,
  },
  {
    version: 4,
    name: "provider-only token count cache subjects",
    sql: `
CREATE TABLE IF NOT EXISTS token_count_next (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES provider_call(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('call', 'section', 'block', 'selection')),
  direction TEXT CHECK (direction IN ('request', 'response')),
  block_id TEXT,
  kind TEXT,
  label TEXT,
  source_hash TEXT NOT NULL,
  cache_key TEXT NOT NULL UNIQUE,
  model_id TEXT NOT NULL,
  tokens INTEGER,
  provenance TEXT NOT NULL CHECK (provenance = 'provider_counted'),
  counted_at REAL NOT NULL,
  error TEXT
);

INSERT OR REPLACE INTO token_count_next (
  id, call_id, subject_type, direction, block_id, kind, label, source_hash,
  cache_key, model_id, tokens, provenance, counted_at, error
)
SELECT id, call_id, subject_type, direction, block_id, kind, NULL, source_hash,
       cache_key, model_id, tokens, provenance, counted_at, error
FROM token_count;

DROP TABLE token_count;
ALTER TABLE token_count_next RENAME TO token_count;

CREATE INDEX IF NOT EXISTS token_count_call_idx
  ON token_count(call_id);
CREATE INDEX IF NOT EXISTS token_count_subject_idx
  ON token_count(subject_type, call_id, direction, block_id, kind);
`,
  },
  {
    version: 5,
    name: "provider response stream chunk captures",
    sql: `
CREATE TABLE IF NOT EXISTS stream_chunk_capture (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES provider_call(id) ON DELETE CASCADE,
  flow_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  observed_at REAL NOT NULL,
  host TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  body_b64 TEXT NOT NULL,
  body_sha256 TEXT,
  body_encoding TEXT,
  content_type TEXT,
  UNIQUE(call_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS stream_chunk_capture_call_idx
  ON stream_chunk_capture(call_id, chunk_index);
CREATE INDEX IF NOT EXISTS stream_chunk_capture_flow_idx
  ON stream_chunk_capture(flow_id, chunk_index);
`,
  },
];

export function applySpyMigrations(db: Database): void {
  db.run("PRAGMA foreign_keys = ON");
  db.run(`
CREATE TABLE IF NOT EXISTS schema_migration (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

  const applied = new Set<number>(
    db.query("SELECT version FROM schema_migration").all()
      .map((row) => (row as { version: number }).version),
  );

  for (const migration of SPY_SQLITE_MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.transaction(() => {
      db.run(migration.sql);
      db.query("INSERT INTO schema_migration (version, name) VALUES (?, ?)")
        .run(migration.version, migration.name);
    })();
  }
}

export function currentSpySchemaVersion(): number {
  return SPY_SQLITE_MIGRATIONS.at(-1)?.version ?? 0;
}
