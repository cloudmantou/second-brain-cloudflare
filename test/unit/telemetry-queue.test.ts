import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  aggregateTelemetryHour,
  DEFAULT_TELEMETRY_CONFIG,
  ensureTelemetryTables,
  flushTelemetry,
  getTelemetryQueueStats,
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
      {
        traceId: "trace-test",
        config: {
          ...DEFAULT_TELEMETRY_CONFIG,
          contentLogging: "preview",
          storeModelResponses: false,
        },
        db,
      },
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
    const modelPreview = await db
      .prepare("SELECT input_preview, output_preview FROM sb_model_calls LIMIT 1")
      .first<{ input_preview: string | null; output_preview: string | null }>();
    expect(modelPreview?.input_preview).toBe("hello");
    expect(modelPreview?.output_preview).toBeNull();

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

  it("retries a failed flush after 500ms and preserves the event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const batch = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary telemetry failure"))
      .mockResolvedValueOnce([]);
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({})) })),
      batch,
    } as unknown as D1Database;

    try {
      await runWithTelemetryAsync(
        { traceId: "retry-trace", config: DEFAULT_TELEMETRY_CONFIG, db },
        async () => logMemoryEvent("retry-memory", "created")
      );
      await flushTelemetry(db);
      expect(getTelemetryQueueStats()).toMatchObject({
        queueLength: 1,
        retrying: true,
        lastFlushError: "temporary telemetry failure",
      });

      vi.setSystemTime(10_500);
      await flushTelemetry(db);
      expect(batch).toHaveBeenCalledTimes(2);
      expect(getTelemetryQueueStats()).toMatchObject({
        queueLength: 0,
        retrying: false,
        lastFlushError: null,
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("drops a batch only after the third failed write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const batch = vi.fn().mockRejectedValue(new Error("persistent telemetry failure"));
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({})) })),
      batch,
    } as unknown as D1Database;
    const droppedBefore = getTelemetryQueueStats().droppedEvents;

    try {
      await runWithTelemetryAsync(
        { traceId: "drop-trace", config: DEFAULT_TELEMETRY_CONFIG, db },
        async () => logMemoryEvent("drop-memory", "created")
      );
      await flushTelemetry(db);
      vi.setSystemTime(20_500);
      await flushTelemetry(db);
      vi.setSystemTime(22_500);
      await flushTelemetry(db);

      expect(batch).toHaveBeenCalledTimes(3);
      expect(getTelemetryQueueStats()).toMatchObject({
        queueLength: 0,
        retrying: false,
        droppedEvents: droppedBefore + 1,
        lastFlushError: "persistent telemetry failure",
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("drops only exhausted events when fresh events join an older retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const batch = vi
      .fn()
      .mockRejectedValueOnce(new Error("mixed failure 1"))
      .mockRejectedValueOnce(new Error("mixed failure 2"))
      .mockRejectedValueOnce(new Error("mixed failure 3"))
      .mockResolvedValueOnce([]);
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({})) })),
      batch,
    } as unknown as D1Database;
    const droppedBefore = getTelemetryQueueStats().droppedEvents;
    const enqueueMemory = async (id: string) => {
      await runWithTelemetryAsync(
        { traceId: `mixed-${id}`, config: DEFAULT_TELEMETRY_CONFIG, db },
        async () => logMemoryEvent(id, "created")
      );
    };

    try {
      await enqueueMemory("old");
      await flushTelemetry(db);

      await enqueueMemory("fresh-1");
      vi.setSystemTime(30_500);
      await flushTelemetry(db);

      await enqueueMemory("fresh-2");
      vi.setSystemTime(32_500);
      await flushTelemetry(db);
      expect(getTelemetryQueueStats()).toMatchObject({
        queueLength: 2,
        droppedEvents: droppedBefore + 1,
        retrying: true,
      });

      vi.setSystemTime(34_500);
      await flushTelemetry(db);
      expect(batch).toHaveBeenCalledTimes(4);
      expect(getTelemetryQueueStats()).toMatchObject({
        queueLength: 0,
        droppedEvents: droppedBefore + 1,
        retrying: false,
        lastFlushError: null,
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
