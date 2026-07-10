/**
 * Async telemetry queue — batch insert, never fail the main request path.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type {
  MemoryEventLog,
  ModelCallLog,
  RequestLog,
  TelemetryConfig,
  TelemetryEvent,
} from "./types";
import { DEFAULT_TELEMETRY_CONFIG } from "./types";
import { getTelemetryConfig, getTelemetryStore, getTraceId } from "./context";
import { previewText } from "./redact";
import { hourBucket, TELEMETRY_HOUR_MS } from "./analytics";

const MAX_QUEUE = 5000;
const FLUSH_EVERY_MS = 500;
const FLUSH_BATCH = 100;
const RETRY_DELAYS_MS = [500, 2_000] as const;

interface QueuedTelemetryEvent {
  event: TelemetryEvent;
  failedAttempts: number;
}

export interface TelemetryQueueStats {
  queueLength: number;
  droppedEvents: number;
  lastFlushError: string | null;
  lastFlushDurationMs: number | null;
  lastFlushAt: number | null;
  retrying: boolean;
}

let queue: QueuedTelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let dbRef: D1Database | null = null;
let flushing = false;
let retryNotBefore = 0;
let droppedEvents = 0;
let lastFlushError: string | null = null;
let lastFlushDurationMs: number | null = null;
let lastFlushAt: number | null = null;

export function bindTelemetryDb(db: D1Database): void {
  dbRef = db;
  ensureFlushTimer();
}

function ensureFlushTimer(): void {
  if (flushTimer != null) return;
  try {
    flushTimer = setInterval(() => {
      void flushTelemetry();
    }, FLUSH_EVERY_MS);
    // Don't keep Node process alive solely for telemetry
    if (typeof flushTimer === "object" && flushTimer && "unref" in flushTimer) {
      (flushTimer as NodeJS.Timeout).unref?.();
    }
  } catch {
    /* Workers may restrict setInterval in some contexts — flush opportunistically */
  }
}

export function enqueueTelemetry(event: TelemetryEvent): void {
  const cfg = getTelemetryConfig();
  if (!cfg.telemetryEnabled) return;
  if (queue.length >= MAX_QUEUE) {
    queue = queue.slice(1);
    droppedEvents += 1;
  }
  queue = [...queue, { event, failedAttempts: 0 }];
  if (queue.length >= FLUSH_BATCH) {
    void flushTelemetry();
  }
}

export function getTelemetryQueueStats(now = Date.now()): TelemetryQueueStats {
  return {
    queueLength: queue.length,
    droppedEvents,
    lastFlushError,
    lastFlushDurationMs,
    lastFlushAt,
    retrying: retryNotBefore > now,
  };
}

function scheduleRetry(database: D1Database, delayMs: number): void {
  if (retryTimer != null) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushTelemetry(database);
  }, delayMs);
  if (typeof retryTimer === "object" && retryTimer && "unref" in retryTimer) {
    (retryTimer as NodeJS.Timeout).unref?.();
  }
}

function clearRetryTimer(): void {
  if (retryTimer == null) return;
  clearTimeout(retryTimer);
  retryTimer = null;
}

export async function flushTelemetry(db?: D1Database): Promise<void> {
  const database = db ?? dbRef ?? getTelemetryStore()?.db;
  const now = Date.now();
  if (!database || flushing || queue.length === 0 || now < retryNotBefore) return;
  flushing = true;
  const startedAt = Date.now();
  const batch = queue.slice(0, FLUSH_BATCH * 5);
  queue = queue.slice(batch.length);
  try {
    await insertTelemetryBatch(database, batch.map((item) => item.event));
    retryNotBefore = 0;
    clearRetryTimer();
    lastFlushError = null;
  } catch (e) {
    console.error("[telemetry] flush failed:", e);
    lastFlushError = String(e instanceof Error ? e.message : e).slice(0, 500);
    const failedBatch = batch.map((item) => ({
      ...item,
      failedAttempts: item.failedAttempts + 1,
    }));
    const retryBatch = failedBatch.filter(
      (item) => item.failedAttempts <= RETRY_DELAYS_MS.length
    );
    const exhausted = failedBatch.length - retryBatch.length;
    droppedEvents += exhausted;
    if (retryBatch.length > 0) {
      const attempts = Math.max(...retryBatch.map((item) => item.failedAttempts));
      const available = Math.max(0, MAX_QUEUE - retryBatch.length);
      const retainedQueue = queue.slice(0, available);
      droppedEvents += queue.length - retainedQueue.length;
      queue = [...retryBatch, ...retainedQueue];
      const delayMs = RETRY_DELAYS_MS[attempts - 1];
      retryNotBefore = Date.now() + delayMs;
      scheduleRetry(database, delayMs);
    } else {
      retryNotBefore = 0;
      clearRetryTimer();
    }
  } finally {
    lastFlushAt = Date.now();
    lastFlushDurationMs = Math.max(0, lastFlushAt - startedAt);
    flushing = false;
    if (queue.length > 0 && Date.now() >= retryNotBefore) {
      // schedule another flush soon
      void Promise.resolve().then(() => flushTelemetry(database));
    }
  }
}

async function insertTelemetryBatch(db: D1Database, events: TelemetryEvent[]): Promise<void> {
  const statements = events.map((event) => {
    if (event.kind === "request") return requestStatement(db, event.data);
    if (event.kind === "model_call") return modelCallStatement(db, event.data);
    return memoryEventStatement(db, event.data);
  });

  // D1 batch is the atomic/batched equivalent of a SQLite transaction. The
  // fallback keeps lightweight test doubles and older adapters compatible.
  const batch = (db as D1Database & {
    batch?: (statements: D1PreparedStatement[]) => Promise<unknown>;
  }).batch;
  if (typeof batch === "function") {
    await batch.call(db, statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

function requestStatement(db: D1Database, d: RequestLog): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sb_request_logs (
        id, trace_id, method, route, operation, source, status_code, success,
        started_at, duration_ms, request_bytes, response_bytes,
        content_preview, content_hash, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      d.id,
      d.trace_id,
      d.method,
      d.route,
      d.operation,
      d.source,
      d.status_code,
      d.success,
      d.started_at,
      d.duration_ms,
      d.request_bytes,
      d.response_bytes,
      d.content_preview,
      d.content_hash,
      d.error_code,
      d.error_message
    );
}

function modelCallStatement(db: D1Database, d: ModelCallLog): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sb_model_calls (
        id, trace_id, call_type, provider, model, duration_ms, status,
        input_tokens, output_tokens, total_tokens, estimated_cost_usd,
        input_preview, output_preview, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      d.id,
      d.trace_id,
      d.call_type,
      d.provider,
      d.model,
      d.duration_ms,
      d.status,
      d.input_tokens,
      d.output_tokens,
      d.total_tokens,
      d.estimated_cost_usd,
      d.input_preview,
      d.output_preview,
      d.error_message,
      d.created_at
    );
}

function memoryEventStatement(db: D1Database, d: MemoryEventLog): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sb_memory_events (
        id, trace_id, memory_id, event_type, source, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      d.id,
      d.trace_id,
      d.memory_id,
      d.event_type,
      d.source,
      d.metadata_json,
      d.created_at
    );
}

/** Persist one completed hour into the long-lived aggregate table. */
export async function aggregateTelemetryHour(
  db: D1Database,
  bucketAt = hourBucket(Date.now() - TELEMETRY_HOUR_MS)
): Promise<{ bucketAt: number; metrics: number }> {
  const nextBucket = bucketAt + TELEMETRY_HOUR_MS;
  const [requests, models, memories] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS errors,
                COALESCE(SUM(duration_ms), 0) AS duration_sum
         FROM sb_request_logs WHERE started_at >= ? AND started_at < ?`
      )
      .bind(bucketAt, nextBucket)
      .first<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN call_type = 'chat' THEN 1 ELSE 0 END), 0) AS chat_count,
           COALESCE(SUM(CASE WHEN call_type = 'embedding' THEN 1 ELSE 0 END), 0) AS embedding_count,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(estimated_cost_usd), 0) AS cost
         FROM sb_model_calls WHERE created_at >= ? AND created_at < ?`
      )
      .bind(bucketAt, nextBucket)
      .first<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN event_type = 'created' THEN 1 ELSE 0 END), 0) AS created,
           COALESCE(SUM(CASE WHEN event_type = 'recalled' THEN 1 ELSE 0 END), 0) AS recalled
         FROM sb_memory_events WHERE created_at >= ? AND created_at < ?`
      )
      .bind(bucketAt, nextBucket)
      .first<Record<string, unknown>>(),
  ]);

  const metrics: Array<[string, number]> = [
    ["request.count", Number(requests?.count ?? 0)],
    ["request.error_count", Number(requests?.errors ?? 0)],
    ["request.duration_sum", Number(requests?.duration_sum ?? 0)],
    ["llm.count", Number(models?.chat_count ?? 0)],
    ["llm.input_tokens", Number(models?.input_tokens ?? 0)],
    ["llm.output_tokens", Number(models?.output_tokens ?? 0)],
    ["llm.cost", Number(models?.cost ?? 0)],
    ["embedding.count", Number(models?.embedding_count ?? 0)],
    ["memory.created", Number(memories?.created ?? 0)],
    ["memory.recalled", Number(memories?.recalled ?? 0)],
  ];
  const statements = metrics.map(([metric, value]) =>
    db
      .prepare(
        `INSERT INTO sb_metrics_hourly (bucket_at, metric, dimension, value)
         VALUES (?, ?, '', ?)
         ON CONFLICT(bucket_at, metric, dimension)
         DO UPDATE SET value = excluded.value`
      )
      .bind(bucketAt, metric, value)
  );
  const batch = (db as D1Database & {
    batch?: (statements: D1PreparedStatement[]) => Promise<unknown>;
  }).batch;
  if (typeof batch === "function") await batch.call(db, statements);
  else for (const statement of statements) await statement.run();
  return { bucketAt, metrics: metrics.length };
}

function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `e${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Public helpers for instrumentation sites. */
export function logModelCall(partial: {
  call_type: "chat" | "embedding";
  provider: string;
  model: string;
  duration_ms: number;
  status: "success" | "error";
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  estimated_cost_usd?: number | null;
  input?: string | null;
  output?: string | null;
  error_message?: string | null;
}): void {
  const cfg = getTelemetryConfig();
  if (!cfg.telemetryEnabled) return;
  const mode = cfg.contentLogging;
  const inP = previewText(partial.input, mode, cfg.previewMaxChars);
  const outP = cfg.storeModelResponses
    ? previewText(partial.output, mode, cfg.previewMaxChars)
    : {
        preview: null,
        hash: null,
        length: partial.output?.length ?? 0,
      };

  enqueueTelemetry({
    kind: "model_call",
    data: {
      id: newId(),
      trace_id: getTraceId(),
      call_type: partial.call_type,
      provider: partial.provider,
      model: partial.model,
      duration_ms: partial.duration_ms,
      status: partial.status,
      input_tokens: partial.input_tokens ?? null,
      output_tokens: partial.output_tokens ?? null,
      total_tokens: partial.total_tokens ?? null,
      estimated_cost_usd: partial.estimated_cost_usd ?? null,
      input_preview: inP.preview,
      output_preview: outP.preview,
      error_message: partial.error_message ?? null,
      created_at: Date.now(),
    },
  });
}

export function logMemoryEvent(
  memoryId: string,
  eventType: MemoryEventLog["event_type"],
  metadata: Record<string, unknown> = {},
  source = "api"
): void {
  const cfg = getTelemetryConfig();
  if (!cfg.telemetryEnabled) return;
  enqueueTelemetry({
    kind: "memory_event",
    data: {
      id: newId(),
      trace_id: getTraceId(),
      memory_id: memoryId,
      event_type: eventType,
      source,
      metadata_json: JSON.stringify(metadata),
      created_at: Date.now(),
    },
  });
}

export function logRequest(partial: Omit<RequestLog, "id">): void {
  const cfg = getTelemetryConfig();
  if (!cfg.telemetryEnabled) return;
  enqueueTelemetry({
    kind: "request",
    data: { ...partial, id: newId() },
  });
}

export async function purgeOldTelemetry(
  db: D1Database,
  retentionDays: number
): Promise<{ requests: number; models: number; events: number }> {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const r1 = await db.prepare(`DELETE FROM sb_request_logs WHERE started_at < ?`).bind(cutoff).run();
  const r2 = await db.prepare(`DELETE FROM sb_model_calls WHERE created_at < ?`).bind(cutoff).run();
  const r3 = await db.prepare(`DELETE FROM sb_memory_events WHERE created_at < ?`).bind(cutoff).run();
  return {
    requests: (r1 as any)?.meta?.changes ?? 0,
    models: (r2 as any)?.meta?.changes ?? 0,
    events: (r3 as any)?.meta?.changes ?? 0,
  };
}

export function getTelemetryConfigSafe(): TelemetryConfig {
  return getTelemetryConfig() ?? DEFAULT_TELEMETRY_CONFIG;
}
