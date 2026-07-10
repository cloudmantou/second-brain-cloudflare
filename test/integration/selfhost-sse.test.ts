import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
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
});
