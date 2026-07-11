import { describe, it, expect, beforeEach } from "vitest";
import { importEntries, parseImportPayload } from "../../src/import-entries";
import { D1Mock } from "../helpers/d1-mock";

describe("parseImportPayload", () => {
  it("accepts raw array", () => {
    expect(parseImportPayload([{ content: "a" }])).toHaveLength(1);
  });
  it("accepts { entries }", () => {
    expect(parseImportPayload({ entries: [{ content: "a" }, { content: "b" }] })).toHaveLength(2);
  });
  it("throws on invalid", () => {
    expect(() => parseImportPayload({ foo: 1 })).toThrow(/array/i);
  });
});

describe("importEntries", () => {
  let db: D1Mock;

  beforeEach(() => {
    db = new D1Mock();
  });

  it("imports Cloudflare-style export rows and clears vector_ids", async () => {
    const raw = [
      {
        id: "9a9b28ed-ce21-4858-85f9-feb7ddc2d0fc",
        content: "AppFlex next step",
        tags: '["work","appflex"]',
        source: "claude-desktop",
        created_at: 1783557972343,
        vector_ids: '["9a9b28ed-ce21-4858-85f9-feb7ddc2d0fc"]',
      },
    ];
    const result = await importEntries(db as unknown as D1Database, raw, {
      mode: "skip",
      extraTags: ["cf-import"],
    });
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].id).toBe("9a9b28ed-ce21-4858-85f9-feb7ddc2d0fc");
    expect(db.entries[0].vector_ids).toBe("[]");
    expect(db.entries[0].created_at).toBe(1783557972343);
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("work");
    expect(tags).toContain("cf-import");
    expect(result.pendingVectorizeCount).toBe(1);
    expect(result.pendingVectorizeSample).toEqual(["9a9b28ed-ce21-4858-85f9-feb7ddc2d0fc"]);
  });

  it("normalizes unix-seconds timestamps to ms", async () => {
    const { normalizeTimestamp } = await import("../../src/import-entries");
    expect(normalizeTimestamp(1_712_345_678)).toBe(1_712_345_678_000);
    expect(normalizeTimestamp(1_712_345_678_000)).toBe(1_712_345_678_000);
    expect(normalizeTimestamp(99)).toBe(99);
  });

  it("preserves recall_count and importance on import", async () => {
    await importEntries(db as unknown as D1Database, [
      {
        id: "stats-1",
        content: "with stats",
        tags: "[]",
        source: "api",
        created_at: 1_700_000_000_000,
        recall_count: 5,
        importance_score: 4,
        contradiction_wins: 1,
        contradiction_losses: 2,
      },
    ], { extraTags: [] });
    expect(db.entries[0].recall_count).toBe(5);
    expect(db.entries[0].importance_score).toBe(4);
    expect(db.entries[0].contradiction_wins).toBe(1);
  });

  it("preserves a complete successful classification from a backup", async () => {
    await importEntries(db as unknown as D1Database, [{
      id: "classified",
      content: "A stable fact",
      tags: '["kind:semantic"]',
      classification_status: "succeeded",
      classification_confidence: 0.91,
      classification_attempts: 1,
      classification_version: 1,
      classified_at: 1_700_000_000_000,
    }], { extraTags: [] });
    expect(db.entries[0]).toMatchObject({
      classification_status: "succeeded",
      classification_confidence: 0.91,
      classification_attempts: 1,
      classified_at: 1_700_000_000_000,
    });
  });

  it("migrates a legacy kind-only backup row as an existing classification", async () => {
    await importEntries(db as unknown as D1Database, [{
      id: "legacy-kind-only",
      content: "A legacy stable fact",
      tags: '["work","kind:semantic"]',
      created_at: 1_700_000_000_000,
    }], { extraTags: [] });

    expect(db.entries[0]).toMatchObject({
      classification_status: "succeeded",
      classification_confidence: 0.5,
      classification_attempts: 1,
      classified_at: 1_700_000_000_000,
    });
  });

  it("resets incomplete claimed-success metadata to pending", async () => {
    await importEntries(db as unknown as D1Database, [{
      id: "invalid-classification",
      content: "Missing kind and confidence",
      tags: "[]",
      classification_status: "succeeded",
    }], { extraTags: [] });
    expect(db.entries[0]).toMatchObject({
      classification_status: "pending",
      classification_confidence: null,
      classification_started_at: null,
    });
  });

  it("rejects unknown kind tags as successful classification evidence", async () => {
    await importEntries(db as unknown as D1Database, [{
      id: "invalid-kind",
      content: "Invalid classification",
      tags: '["kind:garbage"]',
      classification_status: "succeeded",
      classification_confidence: 0.9,
    }], { extraTags: [] });
    expect(db.entries[0]).toMatchObject({
      classification_status: "pending",
      classification_confidence: null,
      classification_attempts: 0,
    });
  });

  it("keeps exactly one valid kind and removes invalid kind tags", async () => {
    await importEntries(db as unknown as D1Database, [{
      id: "mixed-kind",
      content: "A stable fact",
      tags: '["work","kind:garbage","kind:semantic"]',
      classification_status: "succeeded",
      classification_confidence: 0.9,
    }], { extraTags: [] });

    expect(JSON.parse(db.entries[0].tags)).toEqual(["work", "kind:semantic"]);
    expect(db.entries[0].classification_status).toBe("succeeded");
  });

  it("resets classification when imported valid kind tags conflict", async () => {
    await importEntries(db as unknown as D1Database, [{
      id: "conflicting-kinds",
      content: "Conflicting classification",
      tags: '["work","kind:semantic","kind:episodic"]',
      classification_status: "succeeded",
      classification_confidence: 0.9,
    }], { extraTags: [] });

    expect(JSON.parse(db.entries[0].tags)).toEqual(["work"]);
    expect(db.entries[0]).toMatchObject({
      classification_status: "pending",
      classification_confidence: null,
      classification_attempts: 0,
    });
  });

  it("normalizes imported status and attempt combinations", async () => {
    await importEntries(db as unknown as D1Database, [
      { id: "pending", content: "pending", classification_status: "pending", classification_attempts: 3 },
      { id: "retry", content: "retry", classification_status: "retryable_error", classification_attempts: 99 },
      { id: "terminal", content: "terminal", classification_status: "terminal_error", classification_attempts: 0 },
    ], { extraTags: [] });
    expect(db.entries.find(entry => entry.id === "pending")).toMatchObject({
      classification_status: "pending",
      classification_attempts: 0,
    });
    expect(db.entries.find(entry => entry.id === "retry")).toMatchObject({
      classification_status: "retryable_error",
      classification_attempts: 2,
      classification_next_attempt_at: expect.any(Number),
    });
    expect(db.entries.find(entry => entry.id === "terminal")).toMatchObject({
      classification_status: "terminal_error",
      classification_attempts: 3,
    });
  });

  it("skips existing ids in skip mode", async () => {
    await importEntries(db as unknown as D1Database, [
      { id: "a", content: "one", tags: "[]", source: "api", created_at: 1 },
    ]);
    const second = await importEntries(db as unknown as D1Database, [
      { id: "a", content: "two", tags: "[]", source: "api", created_at: 2 },
    ], { mode: "skip" });
    expect(second.skipped).toBe(1);
    expect(second.inserted).toBe(0);
    expect(db.entries[0].content).toBe("one");
  });

  it("overwrites existing ids in overwrite mode", async () => {
    await importEntries(db as unknown as D1Database, [
      { id: "a", content: "one", tags: "[]", source: "api", created_at: 1 },
    ]);
    const second = await importEntries(db as unknown as D1Database, [
      { id: "a", content: "two", tags: '["x"]', source: "import", created_at: 99 },
    ], { mode: "overwrite", extraTags: ["cf-import"] });
    expect(second.updated).toBe(1);
    expect(db.entries[0].content).toBe("two");
    expect(db.entries[0].created_at).toBe(99);
    expect(JSON.parse(db.entries[0].tags)).toContain("cf-import");
  });

  it("accepts tags as arrays", async () => {
    await importEntries(db as unknown as D1Database, [
      { content: "hello", tags: ["a", "b"], source: "api" },
    ], { extraTags: [] });
    expect(JSON.parse(db.entries[0].tags)).toEqual(["a", "b"]);
  });
});
