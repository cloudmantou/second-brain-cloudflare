import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  aggregateTelemetryHour,
  DEFAULT_TELEMETRY_CONFIG,
  ensureTelemetryTables,
  flushTelemetry,
  logMemoryEvent,
  logModelCall,
  logRequest,
  runWithTelemetryAsync,
} from "../../src/telemetry";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("telemetry queue on self-host SQLite", () => {
  it("flushes mixed events through one D1 batch and aggregates a completed hour", async () => {
    const raw = new Database(":memory:");
    const db = new SqliteD1Database(raw) as unknown as D1Database;
    await ensureTelemetryTables(db);
    const bucket = 1_700_000_000_000;

    await runWithTelemetryAsync(
      { traceId: "trace-test", config: DEFAULT_TELEMETRY_CONFIG, db },
      async () => {
        logRequest({
          trace_id: "trace-test",
          method: "POST",
          route: "/capture",
          operation: "memory.capture",
          source: "test",
          status_code: 200,
          success: 1,
          started_at: bucket + 1000,
          duration_ms: 42,
          request_bytes: 20,
          response_bytes: 50,
          content_preview: "hello",
          content_hash: "hash",
          error_code: null,
          error_message: null,
        });
        logModelCall({
          call_type: "chat",
          provider: "test",
          model: "test-model",
          duration_ms: 100,
          status: "success",
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input: "hello",
          output: "world",
        });
        logMemoryEvent("memory-1", "created", { source: "test" });
      }
    );
    await flushTelemetry(db);

    const requestCount = await db
      .prepare("SELECT COUNT(*) AS count FROM sb_request_logs")
      .first<{ count: number }>();
    const modelCount = await db
      .prepare("SELECT COUNT(*) AS count FROM sb_model_calls")
      .first<{ count: number }>();
    expect(requestCount?.count).toBe(1);
    expect(modelCount?.count).toBe(1);

    await aggregateTelemetryHour(db, bucket);
    const metric = await db
      .prepare(
        "SELECT value FROM sb_metrics_hourly WHERE bucket_at = ? AND metric = ?"
      )
      .bind(bucket, "request.count")
      .first<{ value: number }>();
    expect(metric?.value).toBe(1);
    raw.close();
  });
});
