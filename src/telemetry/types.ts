/** Telemetry / Observatory data contracts (PR-008 foundation). */

export type ContentLoggingMode = "off" | "metadata" | "preview" | "full";

export interface TelemetryConfig {
  telemetryEnabled: boolean;
  contentLogging: ContentLoggingMode;
  previewMaxChars: number;
  retentionDays: number;
  storeModelResponses: boolean;
}

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  telemetryEnabled: true,
  contentLogging: "preview",
  previewMaxChars: 400,
  retentionDays: 30,
  storeModelResponses: false,
};

export interface RequestLog {
  id: string;
  trace_id: string;
  method: string;
  route: string;
  operation: string;
  source: string;
  status_code: number;
  success: number; // 0/1 for SQLite
  started_at: number;
  duration_ms: number;
  request_bytes: number;
  response_bytes: number;
  content_preview: string | null;
  content_hash: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface ModelCallLog {
  id: string;
  trace_id: string;
  call_type: "chat" | "embedding";
  provider: string;
  model: string;
  duration_ms: number;
  status: "success" | "error";
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
  input_preview: string | null;
  output_preview: string | null;
  error_message: string | null;
  created_at: number;
}

export type MemoryEventType =
  | "created"
  | "recalled"
  | "updated"
  | "appended"
  | "deleted"
  | "merged"
  | "replaced"
  | "contradiction_detected"
  | "classified"
  | "vectorized"
  | "digest_created"
  | "imported";

export interface MemoryEventLog {
  id: string;
  trace_id: string;
  memory_id: string;
  event_type: MemoryEventType;
  source: string;
  metadata_json: string;
  created_at: number;
}

export type TelemetryEvent =
  | { kind: "request"; data: RequestLog }
  | { kind: "model_call"; data: ModelCallLog }
  | { kind: "memory_event"; data: MemoryEventLog };
