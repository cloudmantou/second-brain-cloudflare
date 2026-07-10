/**
 * Request-scoped telemetry context (trace_id).
 * Uses AsyncLocalStorage when available (Node / Workers nodejs_compat).
 */

import type { TelemetryConfig } from "./types";
import { DEFAULT_TELEMETRY_CONFIG } from "./types";

export interface TelemetryStore {
  traceId: string;
  config: TelemetryConfig;
  db?: D1Database;
  source?: string;
}

type AlsLike = {
  run: <T>(store: TelemetryStore, fn: () => T) => T;
  getStore: () => TelemetryStore | undefined;
};

let als: AlsLike | null | undefined;

function getAls(): AlsLike | null {
  if (als !== undefined) return als;
  try {
    // Dynamic require-style for environments without static node:async_hooks
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("node:async_hooks") as { AsyncLocalStorage: new () => AlsLike };
    als = new mod.AsyncLocalStorage();
  } catch {
    als = null;
  }
  return als;
}

/** Fallback when ALS unavailable (best-effort, not concurrent-safe on Workers isolate). */
let fallback: TelemetryStore | undefined;

export function runWithTelemetry<T>(store: TelemetryStore, fn: () => T): T {
  const a = getAls();
  if (a) return a.run(store, fn);
  fallback = store;
  try {
    return fn();
  } finally {
    fallback = undefined;
  }
}

export async function runWithTelemetryAsync<T>(
  store: TelemetryStore,
  fn: () => Promise<T>
): Promise<T> {
  const a = getAls();
  if (a) {
    return a.run(store, () => fn());
  }
  fallback = store;
  try {
    return await fn();
  } finally {
    fallback = undefined;
  }
}

export function getTelemetryStore(): TelemetryStore | undefined {
  return getAls()?.getStore() ?? fallback;
}

export function getTraceId(): string {
  return getTelemetryStore()?.traceId ?? "no-trace";
}

export function getTelemetryConfig(): TelemetryConfig {
  return getTelemetryStore()?.config ?? DEFAULT_TELEMETRY_CONFIG;
}

export function newTraceId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
