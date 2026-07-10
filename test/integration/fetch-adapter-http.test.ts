import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWithWorker } from "../../src/selfhost/fetch-adapter";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";

describe("self-host HTTP forwarding", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(apps.map((app) => app.close()));
  });

  it("buffers a non-SSE count response with the configured public URL", async () => {
    vi.stubEnv("PUBLIC_URL", "https://agent.mtzs.cloud");
    const env = makeTestEnv(makeTestDb());
    const app = Fastify();
    apps.push(app);
    app.get("/count", async (request, reply) => {
      await handleWithWorker(request, reply, env);
    });

    const response = await app.inject({
      method: "GET",
      url: "/count",
      headers: { Authorization: "Bearer test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-length"]).toBe(
      String(Buffer.byteLength(response.body))
    );
    expect(response.json()).toMatchObject({ count: 0 });
  });

  it("forwards empty, string, and buffer request bodies safely", async () => {
    const env = makeTestEnv(makeTestDb());
    const app = Fastify();
    apps.push(app);
    app.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body)
    );
    app.post("/capture", async (request, reply) => {
      await handleWithWorker(request, reply, env);
    });
    const authorization = { Authorization: "Bearer test-token" };

    const empty = await app.inject({
      method: "POST",
      url: "/capture",
      headers: authorization,
    });
    const stringBody = await app.inject({
      method: "POST",
      url: "/capture",
      headers: { ...authorization, "Content-Type": "text/plain" },
      payload: '{"content":"string body","source":"test","tags":[]}',
    });
    const bufferBody = await app.inject({
      method: "POST",
      url: "/capture",
      headers: { ...authorization, "Content-Type": "application/octet-stream" },
      payload: Buffer.from(
        '{"content":"buffer body","source":"test","tags":[]}'
      ),
    });

    expect(empty.statusCode).toBe(400);
    expect(stringBody.statusCode).toBe(200);
    expect(bufferBody.statusCode).toBe(200);
  });
});
