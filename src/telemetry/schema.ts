/** Ensure Observatory tables exist (idempotent). */

export async function ensureTelemetryTables(db: D1Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sb_request_logs (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      method TEXT NOT NULL,
      route TEXT NOT NULL,
      operation TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'api',
      status_code INTEGER NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      request_bytes INTEGER NOT NULL DEFAULT 0,
      response_bytes INTEGER NOT NULL DEFAULT 0,
      content_preview TEXT,
      content_hash TEXT,
      error_code TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_req_logs_started ON sb_request_logs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_req_logs_trace ON sb_request_logs(trace_id);
    CREATE INDEX IF NOT EXISTS idx_req_logs_op ON sb_request_logs(operation);

    CREATE TABLE IF NOT EXISTS sb_model_calls (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      call_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      estimated_cost_usd REAL,
      input_preview TEXT,
      output_preview TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_calls_created ON sb_model_calls(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_model_calls_trace ON sb_model_calls(trace_id);

    CREATE TABLE IF NOT EXISTS sb_memory_events (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'api',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mem_events_created ON sb_memory_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mem_events_memory ON sb_memory_events(memory_id);
    CREATE INDEX IF NOT EXISTS idx_mem_events_type ON sb_memory_events(event_type);

    CREATE TABLE IF NOT EXISTS sb_metrics_hourly (
      bucket_at INTEGER NOT NULL,
      metric TEXT NOT NULL,
      dimension TEXT NOT NULL DEFAULT '',
      value REAL NOT NULL,
      PRIMARY KEY (bucket_at, metric, dimension)
    );
  `);
}
