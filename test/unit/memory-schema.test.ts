import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import {
  buildMemoryRelation,
  createMemoryRelations,
  listMemoryRelations,
} from "../../src/memory/relations";
import { forgetMemoryGraph } from "../../src/memory/forget";

describe("memory data model", () => {
  let raw: Database.Database;

  beforeEach(() => {
    raw = new Database(":memory:");
  });

  afterEach(() => {
    raw.close();
  });

  it("creates permanent relation and revision tables idempotently", async () => {
    const db = new SqliteD1Database(raw) as unknown as D1Database;

    await ensureMemoryDataModel(db);
    await ensureMemoryDataModel(db);

    const tables = raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('sb_memory_relations', 'sb_memory_revisions')
         ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(table => table.name)).toEqual([
      "sb_memory_relations",
      "sb_memory_revisions",
    ]);

    const relationIndexes = raw
      .prepare(`PRAGMA index_list('sb_memory_relations')`)
      .all() as Array<{ name: string }>;
    expect(relationIndexes.map(index => index.name)).toEqual(
      expect.arrayContaining([
        "idx_sb_memory_relations_from",
        "idx_sb_memory_relations_to",
      ])
    );
  });

  it("rejects invalid relation endpoints, types, and scores before SQL", () => {
    expect(() => buildMemoryRelation({
      fromMemoryId: "same",
      toMemoryId: "same",
      relationType: "similar",
    })).toThrow(/itself/);
    expect(() => buildMemoryRelation({
      fromMemoryId: "a",
      toMemoryId: "b",
      relationType: "invalid" as any,
    })).toThrow(/Unsupported/);
    expect(() => buildMemoryRelation({
      fromMemoryId: "a",
      toMemoryId: "b",
      relationType: "similar",
      score: 1.1,
    })).toThrow(/between 0 and 1/);
  });

  it("reads evidence links and securely erases derived memories on real SQLite", async () => {
    const db = new SqliteD1Database(raw) as unknown as D1Database;
    await db.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        vector_ids TEXT NOT NULL
      )
    `);
    await ensureMemoryDataModel(db);
    await db.batch([
      db.prepare(`INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)`)
        .bind("source", "private fact", '["work"]', "api", 1, '["source-vector"]'),
      db.prepare(`INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)`)
        .bind("digest", "digest of private fact", '["synthesized"]', "system", 2, '["digest-vector"]'),
      db.prepare(`INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)`)
        .bind("other", "other fact", '["work","rolled-up"]', "api", 3, '["other-vector"]'),
    ]);
    await createMemoryRelations(db, [
      {
        fromMemoryId: "digest",
        toMemoryId: "source",
        relationType: "digest_of",
      },
      {
        fromMemoryId: "digest",
        toMemoryId: "other",
        relationType: "digest_of",
      },
    ]);

    const relations = await listMemoryRelations(db, "source");
    expect(relations).toEqual([
      expect.objectContaining({
        direction: "incoming",
        relation: "digest_of",
        other: expect.objectContaining({ id: "digest" }),
      }),
    ]);

    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "deleted" });
    const result = await forgetMemoryGraph(
      "source",
      db,
      { deleteByIds } as unknown as VectorizeIndex
    );

    expect(result).toMatchObject({ status: "deleted", derivedCount: 1, vectorCount: 2 });
    expect(deleteByIds).toHaveBeenCalledWith(
      expect.arrayContaining(["source-vector", "digest-vector"])
    );
    const { results: remaining } = await db
      .prepare(`SELECT id, tags FROM entries ORDER BY id`)
      .all<{ id: string; tags: string }>();
    expect(remaining).toEqual([{ id: "other", tags: '["work"]' }]);
    const unroll = await db
      .prepare(`SELECT event_type FROM sb_memory_revisions WHERE memory_id = ?`)
      .bind("other")
      .first<{ event_type: string }>();
    expect(unroll?.event_type).toBe("UNROLL");
  });
});
