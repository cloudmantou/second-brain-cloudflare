import { describe, expect, it, vi, beforeEach } from "vitest";
import { captureEntry } from "../../src/index";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/index";
import type { D1Mock } from "../helpers/d1-mock";

function makeCtx() {
  const pending: Promise<any>[] = [];
  const ctx = {
    waitUntil: (p: Promise<any>) => {
      pending.push(p);
    },
  } as any as ExecutionContext;
  return {
    ctx,
    drain: async () => {
      await Promise.allSettled(pending);
    },
  };
}

function makeExtractionAI(payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") {
        return { data: [new Array(384).fill(0.1)] };
      }
      return new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(`data: {"response":${JSON.stringify(body)}}\n\n`)
          );
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

describe("captureEntry atomic dual-write", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("splits multi-claim input into batch atomic memories with observation provenance", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
      AI: makeExtractionAI({
        facts: [
          {
            content: "用户已完成 Singularity 分类系统。",
            kind: "episodic",
            memory_class: "milestone",
            importance: 4,
            confidence: 0.92,
            entities: ["Singularity"],
          },
          {
            content: "用户正在研究 Graphiti。",
            kind: "semantic",
            memory_class: "project",
            importance: 3,
            confidence: 0.88,
            entities: ["Graphiti"],
          },
          {
            content: "用户计划下周开始开发 Universe UI。",
            kind: "procedural",
            memory_class: "plan",
            importance: 3,
            confidence: 0.8,
            entities: ["Universe"],
          },
        ],
      }),
    });

    const { ctx, drain } = makeCtx();
    const result = await captureEntry(
      "我完成了分类系统，正在研究 Graphiti，下周准备开始 Universe UI。",
      ["work"],
      "api",
      env,
      ctx
    );
    await drain();

    expect(result.status).toBe("batch");
    if (result.status !== "batch") return;
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.status !== "blocked")).toBe(true);
    expect(db.observations).toHaveLength(1);
    expect(db.memories).toHaveLength(3);
    expect(db.memorySources).toHaveLength(3);
    expect(db.entries).toHaveLength(3);
    expect(db.entries.some((e) => String(e.tags).includes("class:milestone"))).toBe(true);
    expect(db.memories.map((m) => m.memory_class).sort()).toEqual(
      ["milestone", "plan", "project"].sort()
    );
    expect(db.memorySources.every((s) => s.observation_id === result.observationId)).toBe(true);
  });

  it("falls back to a single dual-written fact when extraction fails", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
      AI: makeExtractionAI("not valid json at all"),
    });
    const { ctx, drain } = makeCtx();
    const result = await captureEntry("单独一条事实，没有逗号拆分需要。", [], "api", env, ctx);
    await drain();
    expect(result.status).not.toBe("batch");
    expect(db.observations).toHaveLength(1);
    expect(db.entries).toHaveLength(1);
    expect(db.memories).toHaveLength(1);
    expect(db.memorySources).toHaveLength(1);
  });
});
