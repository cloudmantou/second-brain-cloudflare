import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";
import { SqliteVectorizeIndex } from "../../src/selfhost/sqlite-vectorize";
import { SqliteKVNamespace } from "../../src/selfhost/sqlite-kv";

describe("SqliteD1Database", () => {
  let dbPath: string;
  let raw: Database.Database;
  let d1: SqliteD1Database;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sb-d1-${Date.now()}-${Math.random()}.db`);
    raw = new Database(dbPath);
    d1 = new SqliteD1Database(raw);
  });

  afterEach(() => {
    raw.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("supports exec + prepare/bind/first/all/run", async () => {
    await d1.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)`);
    await d1.prepare(`INSERT INTO t (id, n) VALUES (?, ?)`).bind("a", 1).run();
    await d1.prepare(`INSERT INTO t (id, n) VALUES (?, ?)`).bind("b", 2).run();

    const row = await d1.prepare(`SELECT n FROM t WHERE id = ?`).bind("a").first<{ n: number }>();
    expect(row?.n).toBe(1);

    const { results } = await d1.prepare(`SELECT id FROM t ORDER BY n`).all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("supports json_each like the Worker queries", async () => {
    await d1.exec(`CREATE TABLE entries (id TEXT, tags TEXT)`);
    await d1
      .prepare(`INSERT INTO entries (id, tags) VALUES (?, ?)`)
      .bind("1", JSON.stringify(["work", "second-brain"]))
      .run();

    const { results } = await d1
      .prepare(`SELECT DISTINCT value FROM entries, json_each(entries.tags) ORDER BY value`)
      .all<{ value: string }>();
    expect(results.map((r) => r.value)).toEqual(["second-brain", "work"]);
  });
});

describe("SqliteVectorizeIndex", () => {
  let dbPath: string;
  let raw: Database.Database;
  let vec: SqliteVectorizeIndex;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sb-vec-${Date.now()}-${Math.random()}.db`);
    raw = new Database(dbPath);
    vec = new SqliteVectorizeIndex(raw);
  });

  afterEach(() => {
    raw.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("inserts, queries by cosine, getByIds, deleteByIds", async () => {
    await vec.insert([
      { id: "v1", values: [1, 0, 0], metadata: { parentId: "p1" } },
      { id: "v2", values: [0, 1, 0], metadata: { parentId: "p2" } },
      { id: "v3", values: [0.9, 0.1, 0], metadata: { parentId: "p3" } },
    ]);

    const { matches } = await vec.query([1, 0, 0], { topK: 2, returnMetadata: "all" });
    expect(matches).toHaveLength(2);
    expect(matches[0].id).toBe("v1");
    expect(matches[0].score).toBeCloseTo(1, 5);
    expect((matches[0] as any).metadata.parentId).toBe("p1");

    const got = await vec.getByIds(["v2"]);
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe("v2");

    await vec.deleteByIds(["v1"]);
    const after = await vec.query([1, 0, 0], { topK: 5 });
    expect(after.matches.find((m) => m.id === "v1")).toBeUndefined();
  });
});

describe("SqliteKVNamespace", () => {
  let dbPath: string;
  let raw: Database.Database;
  let kv: SqliteKVNamespace;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sb-kv-${Date.now()}-${Math.random()}.db`);
    raw = new Database(dbPath);
    kv = new SqliteKVNamespace(raw);
  });

  afterEach(() => {
    raw.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("put/get/delete/list", async () => {
    await kv.put("a", "1");
    await kv.put("ab", "2");
    expect(await kv.get("a")).toBe("1");
    const listed = await kv.list({ prefix: "a" });
    expect(listed.keys.map((k) => k.name).sort()).toEqual(["a", "ab"]);
    const firstPage = await kv.list({ prefix: "a", limit: 1 });
    expect(firstPage).toMatchObject({
      keys: [{ name: "a" }],
      list_complete: false,
      cursor: "a",
    });
    const secondPage = await kv.list({
      prefix: "a",
      limit: 1,
      cursor: firstPage.cursor,
    });
    expect(secondPage).toMatchObject({
      keys: [{ name: "ab" }],
      list_complete: true,
    });
    await kv.delete("a");
    expect(await kv.get("a")).toBeNull();
  });

  it("expires inactive OAuth clients after 30 days and renews active clients", async () => {
    let now = 1_700_000_000_000;
    kv = new SqliteKVNamespace(raw, { now: () => now });
    await kv.put(
      "client:test",
      JSON.stringify({ clientId: "test" }),
      { expirationTtl: 2_160 * 60 * 60 }
    );
    const initial = raw
      .prepare("SELECT expires_at FROM sb_kv WHERE key = ?")
      .get("client:test") as { expires_at: number };
    expect(initial.expires_at).toBe(now + 30 * 24 * 60 * 60 * 1000);

    now += 29 * 24 * 60 * 60 * 1000;
    expect(await kv.get("client:test", { type: "json" })).toEqual({ clientId: "test" });
    const renewed = raw
      .prepare("SELECT expires_at FROM sb_kv WHERE key = ?")
      .get("client:test") as { expires_at: number };
    expect(renewed.expires_at).toBe(now + 30 * 24 * 60 * 60 * 1000);

    now += 31 * 24 * 60 * 60 * 1000;
    expect(await kv.get("client:test")).toBeNull();
  });

  it("assigns the idle expiry to legacy OAuth clients", () => {
    raw.exec(`
      INSERT INTO sb_kv (key, value, expires_at)
      VALUES ('client:legacy', '{"clientId":"legacy"}', NULL)
    `);
    const now = 1_800_000_000_000;
    kv = new SqliteKVNamespace(raw, { now: () => now });
    const migrated = raw
      .prepare("SELECT expires_at FROM sb_kv WHERE key = ?")
      .get("client:legacy") as { expires_at: number };
    expect(migrated.expires_at).toBe(now + 30 * 24 * 60 * 60 * 1000);
  });
});
