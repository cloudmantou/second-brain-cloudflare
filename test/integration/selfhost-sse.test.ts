import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWithWorker } from "../../src/selfhost/fetch-adapter";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";

describe("self-host SSE forwarding", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it("keeps /chat open until every SSE delta is written", async () => {
    const encoder = new TextEncoder();
    const env = makeTestEnv(makeTestDb(), {
      AI: {
        run: async () => new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"response":"第一段"}\n\n'));
            setTimeout(() => {
              controller.enqueue(encoder.encode('data: {"response":"第二段"}\n\n'));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }, 25);
          },
        }),
      } as unknown as Ai,
    });
    const app = Fastify();
    apps.push(app);
    app.post("/chat", async (request, reply) => {
      await handleWithWorker(request, reply, env);
    });

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      payload: {
        query: "我在忙什么？",
        memories: "一条近期记忆",
        mode: "recent_activity",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('"response":"第一段"');
    expect(response.body).toContain('"response":"第二段"');
    expect(response.body).toContain("[DONE]");
  });

  it("keeps serving requests after an SSE client disconnects", async () => {
    const encoder = new TextEncoder();
    let upstreamCancelled = false;
    const env = makeTestEnv(makeTestDb(), {
      AI: {
        run: async () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"response":"第一段"}\n\n'));
            },
            cancel() {
              upstreamCancelled = true;
            },
          }),
      } as unknown as Ai,
    });
    const app = Fastify();
    apps.push(app);
    app.post("/chat", async (request, reply) => {
      await handleWithWorker(request, reply, env);
    });
    app.get("/probe", async () => ({ ok: true }));

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fastify did not expose a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const controller = new AbortController();
    try {
      const response = await fetch(`${baseUrl}/chat`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "我在忙什么？",
          memories: "一条近期记忆",
          mode: "recent_activity",
        }),
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("SSE response did not expose a body");
      const firstChunk = await reader.read();

      expect(response.status).toBe(200);
      expect(firstChunk.done).toBe(false);
      expect(firstChunk.value?.byteLength).toBeGreaterThan(0);
    } finally {
      controller.abort();
    }

    await vi.waitFor(() => expect(upstreamCancelled).toBe(true), {
      timeout: 1_000,
    });
    const probe = await fetch(`${baseUrl}/probe`, {
      signal: AbortSignal.timeout(1_000),
    });

    expect(probe.status).toBe(200);
    await expect(probe.json()).resolves.toEqual({ ok: true });
  });
});
