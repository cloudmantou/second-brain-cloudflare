import { beforeEach, describe, expect, it } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import { createExecutionContext, createSelfhostEnv } from "../../src/selfhost/env";
import { resetSettingsCache } from "../../src/settings/store";
import { flushTelemetry } from "../../src/telemetry";

describe("Observatory analytics API", () => {
  beforeEach(() => {
    resetSettingsCache();
  });

  it("protects analytics and returns P95 plus hourly points", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    await initializeDatabase(env);
    const now = Date.now();
    db.prepare(
      `INSERT INTO sb_request_logs
       (id, trace_id, method, route, operation, source, status_code, success,
        started_at, duration_ms, request_bytes, response_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("request-1", "trace-1", "GET", "/stats", "memory.stats", "test", 200, 1, now, 100, 0, 10);
    db.prepare(
      `INSERT INTO sb_request_logs
       (id, trace_id, method, route, operation, source, status_code, success,
        started_at, duration_ms, request_bytes, response_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("request-2", "trace-2", "GET", "/stats", "memory.stats", "test", 200, 1, now, 200, 0, 10);

    const ctx = createExecutionContext();
    const unauthorized = await worker.fetch(
      new Request("http://localhost/analytics/overview"),
      env,
      ctx
    );
    expect(unauthorized.status).toBe(401);

    const overview = await worker.fetch(
      new Request("http://localhost/analytics/overview?hours=24", {
        headers: { Authorization: "Bearer test-token" },
      }),
      env,
      ctx
    );
    expect(overview.status).toBe(200);
    const overviewBody = await overview.json() as any;
    expect(overviewBody.requests.count).toBeGreaterThanOrEqual(2);
    expect(overviewBody.requests.p95_ms).toBe(200);

    const timeseries = await worker.fetch(
      new Request("http://localhost/analytics/timeseries?hours=24", {
        headers: { Authorization: "Bearer test-token" },
      }),
      env,
      ctx
    );
    const timeseriesBody = await timeseries.json() as any;
    expect(timeseriesBody.points[0].p50_ms).toBe(100);
    expect(timeseriesBody.points[0].p95_ms).toBe(200);

    await flushTelemetry(env.DB);
    db.close();
  });
});
