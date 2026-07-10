import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";

function makeSseStream(response: string) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`)
      );
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function makeDecisionAI(
  decision: string,
  classification = '{"importance":3,"canonical":false,"kind":"semantic"}'
): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string, options: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5") {
        return { data: [new Array(384).fill(0.1)] };
      }
      const prompt = (options?.messages ?? [])
        .map((message: any) => message.content)
        .join("\n");
      return makeSseStream(
        prompt.includes("Choose exactly one action") ? decision : classification
      );
    }),
  } as unknown as Ai;
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

function seedEntry(
  db: D1Mock,
  overrides: Partial<Record<string, unknown>> = {}
) {
  db.entries.push({
    id: "existing-id",
    content: "I use VSCode",
    tags: '["work"]',
    source: "api",
    created_at: Date.now() - 1_000,
    vector_ids: '["existing-vector"]',
    recall_count: 0,
    importance_score: 2,
    contradiction_wins: 0,
    contradiction_losses: 0,
    ...overrides,
  });
}

describe("automatic capture is append-only", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("stores a replacement as a new memory and links it with supersedes", async () => {
    seedEntry(db);
    const insert = vi.fn().mockResolvedValue({ mutationId: "insert" });
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "delete" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [
            {
              id: "existing-vector",
              score: 0.88,
              metadata: { parentId: "existing-id" },
            },
          ],
        }),
        insert,
        deleteByIds,
      }),
      AI: makeDecisionAI('{"action":"replace","target_id":"existing-id"}'),
    });
    const { ctx, drain } = makeCtx();

    const response = await worker.fetch(
      req("POST", "/capture", { body: { content: "I switched to Cursor IDE" } }),
      env,
      ctx
    );
    const body = (await response.json()) as any;
    await drain();

    expect(body).toMatchObject({
      ok: true,
      action: "linked",
      relation: "supersedes",
      linked_id: "existing-id",
      preserved: true,
    });
    expect(body.id).not.toBe("existing-id");
    expect(db.entries).toHaveLength(2);
    expect(db.entries.find((entry) => entry.id === "existing-id")?.content).toBe(
      "I use VSCode"
    );
    expect(db.entries.find((entry) => entry.id === body.id)?.content).toBe(
      "I switched to Cursor IDE"
    );
    expect(db.relations).toContainEqual(
      expect.objectContaining({
        from_memory_id: body.id,
        to_memory_id: "existing-id",
        relation_type: "supersedes",
      })
    );
    expect(db.revisions).toContainEqual(
      expect.objectContaining({
        memory_id: body.id,
        event_type: "ADD",
        old_content: null,
        new_content: "I switched to Cursor IDE",
      })
    );
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalled();
  });

  it("stores raw follow-up content instead of the model's merged rewrite", async () => {
    seedEntry(db, { content: "I prefer dark mode" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [
            {
              id: "existing-vector",
              score: 0.89,
              metadata: { parentId: "existing-id" },
            },
          ],
        }),
      }),
      AI: makeDecisionAI(
        '{"action":"merge","target_id":"existing-id","merged_content":"MODEL REWRITE"}'
      ),
    });
    const { ctx, drain } = makeCtx();

    const response = await worker.fetch(
      req("POST", "/capture", { body: { content: "I like dark mode at night" } }),
      env,
      ctx
    );
    const body = (await response.json()) as any;
    await drain();

    expect(body).toMatchObject({
      ok: true,
      action: "linked",
      relation: "continuation_of",
      linked_id: "existing-id",
      preserved: true,
    });
    expect(db.entries.find((entry) => entry.id === "existing-id")?.content).toBe(
      "I prefer dark mode"
    );
    expect(db.entries.find((entry) => entry.id === body.id)?.content).toBe(
      "I like dark mode at night"
    );
    expect(db.entries.some((entry) => entry.content === "MODEL REWRITE")).toBe(false);
  });

  it("keeps both sides of a contradiction and records an evidence link", async () => {
    seedEntry(db, { content: "I live in NYC" });
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "delete" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [
            {
              id: "existing-vector",
              score: 0.88,
              metadata: { parentId: "existing-id" },
            },
          ],
        }),
        deleteByIds,
      }),
      AI: makeDecisionAI(
        '{"action":"contradiction","conflicting_id":"existing-id","reason":"different city"}'
      ),
    });
    const { ctx, drain } = makeCtx();

    const response = await worker.fetch(
      req("POST", "/capture", { body: { content: "I moved to LA" } }),
      env,
      ctx
    );
    const body = (await response.json()) as any;
    await drain();

    expect(body).toMatchObject({
      ok: true,
      relation: "contradicts",
      conflict_id: "existing-id",
      preserved: true,
      reason: "different city",
    });
    expect(db.entries).toHaveLength(2);
    expect(db.entries.find((entry) => entry.id === "existing-id")?.content).toBe(
      "I live in NYC"
    );
    expect(db.relations).toContainEqual(
      expect.objectContaining({
        from_memory_id: body.id,
        to_memory_id: "existing-id",
        relation_type: "contradicts",
      })
    );
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  it("stores a protected replacement candidate as a linked draft", async () => {
    seedEntry(db, { tags: '["work","status:canonical"]' });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [
            {
              id: "existing-vector",
              score: 0.88,
              metadata: { parentId: "existing-id" },
            },
          ],
        }),
      }),
      AI: makeDecisionAI('{"action":"replace","target_id":"existing-id"}'),
    });
    const { ctx, drain } = makeCtx();

    const response = await worker.fetch(
      req("POST", "/capture", { body: { content: "Replacement candidate" } }),
      env,
      ctx
    );
    const body = (await response.json()) as any;
    await drain();

    expect(db.entries).toHaveLength(2);
    expect(db.entries.find((entry) => entry.id === "existing-id")?.content).toBe(
      "I use VSCode"
    );
    const candidate = db.entries.find((entry) => entry.id === body.id);
    expect(JSON.parse(candidate.tags)).toContain("status:draft");
    expect(db.relations).toContainEqual(
      expect.objectContaining({
        from_memory_id: body.id,
        to_memory_id: "existing-id",
        relation_type: "similar",
      })
    );
  });
});
