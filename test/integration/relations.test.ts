import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";

const ctx = { waitUntil() {} } as unknown as ExecutionContext;

describe("GET /relations", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
    db.entries.push(
      {
        id: "source",
        content: "Original project decision",
        tags: '["work"]',
        source: "api",
        created_at: 100,
        vector_ids: "[]",
      },
      {
        id: "digest",
        content: "Current project digest",
        tags: '["synthesized","work"]',
        source: "system",
        created_at: 200,
        vector_ids: "[]",
      },
      {
        id: "update",
        content: "Updated project decision",
        tags: '["work"]',
        source: "api",
        created_at: 300,
        vector_ids: "[]",
      }
    );
    db.relations.push(
      {
        id: "r-digest",
        from_memory_id: "digest",
        to_memory_id: "source",
        relation_type: "digest_of",
        score: null,
        metadata_json: '{"derived_type":"digest"}',
        created_at: 200,
      },
      {
        id: "r-update",
        from_memory_id: "update",
        to_memory_id: "source",
        relation_type: "supersedes",
        score: 0.91,
        metadata_json: '{}',
        created_at: 300,
      }
    );
  });

  it("requires owner authentication", async () => {
    const response = await worker.fetch(
      req("GET", "/relations?id=source", { token: null }),
      env,
      ctx
    );
    expect(response.status).toBe(401);
  });

  it("validates the memory id", async () => {
    const response = await worker.fetch(req("GET", "/relations"), env, ctx);
    expect(response.status).toBe(400);
  });

  it("returns incoming and outgoing evidence with the related memory content", async () => {
    const response = await worker.fetch(
      req("GET", "/relations?id=source"),
      env,
      ctx
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, id: "source" });
    expect(body.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "incoming",
          relation: "digest_of",
          other: expect.objectContaining({
            id: "digest",
            content: "Current project digest",
          }),
        }),
        expect.objectContaining({
          direction: "incoming",
          relation: "supersedes",
          score: 0.91,
          other: expect.objectContaining({
            id: "update",
            content: "Updated project decision",
          }),
        }),
      ])
    );
  });
});
