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

const MAX_QUEUE = 5000;
const FLUSH_EVERY_MS = 500;
const FLUSH_BATCH = 100;

let queue: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let dbRef: D1Database | null = null;
let flushing = false;

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
    queue.shift(); // drop oldest
  }
  queue.push(event);
  if (queue.length >= FLUSH_BATCH) {
    void flushTelemetry();
  }
}

export async function flushTelemetry(db?: D1Database): Promise<void> {
  const database = db ?? dbRef ?? getTelemetryStore()?.db;
  if (!database || flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, FLUSH_BATCH * 5);
  try {
    for (const ev of batch) {
      if (ev.kind === "request") await insertRequest(database, ev.data);
      else if (ev.kind === "model_call") await insertModelCall(database, ev.data);
      else if (ev.kind === "memory_event") await insertMemoryEvent(database, ev.data);
    }
  } catch (e) {
    console.error("[telemetry] flush failed:", e);
    // Drop failed batch — do not re-queue forever
  } finally {
    flushing = false;
    if (queue.length > 0) {
      // schedule another flush soon
      void Promise.resolve().then(() => flushTelemetry(database));
    }
  }
}

async function insertRequest(db: D1Database, d: RequestLog): Promise<void> {
  await db
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
    )
    .run();
}

async function insertModelCall(db: D1Database, d: ModelCallLog): Promise<void> {
  await db
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
    )
    .run();
}

async function insertMemoryEvent(db: D1Database, d: MemoryEventLog): Promise<void> {
  await db
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
    )
    .run();
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
    : previewText(partial.output, mode === "full" ? "preview" : mode, cfg.previewMaxChars);

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
