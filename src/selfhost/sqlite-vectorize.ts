/**
 * Vectorize-compatible local store using SQLite + in-process cosine similarity.
 * Fine for personal-scale corpora; swap for sqlite-vec later without changing callers.
 */

import type Database from "better-sqlite3";

/** Local copy to avoid circular import with the Worker entrypoint. */
function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface StoredVector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class SqliteVectorizeIndex {
  constructor(private db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sb_vectors (
        id TEXT PRIMARY KEY,
        values_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    `);
  }

  async insert(
    vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]
  ): Promise<{ mutationId: string }> {
    const upsert = this.db.prepare(`
      INSERT INTO sb_vectors (id, values_json, metadata_json)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        values_json = excluded.values_json,
        metadata_json = excluded.metadata_json
    `);
    const tx = this.db.transaction((rows: typeof vectors) => {
      for (const v of rows) {
        upsert.run(v.id, JSON.stringify(v.values), JSON.stringify(v.metadata ?? {}));
      }
    });
    tx(vectors);
    return { mutationId: `ins-${Date.now()}` };
  }

  async upsert(
    vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]
  ): Promise<{ mutationId: string }> {
    return this.insert(vectors);
  }

  async deleteByIds(ids: string[]): Promise<{ mutationId: string }> {
    if (!ids.length) return { mutationId: `del-${Date.now()}` };
    const del = this.db.prepare(`DELETE FROM sb_vectors WHERE id = ?`);
    const tx = this.db.transaction((rowIds: string[]) => {
      for (const id of rowIds) del.run(id);
    });
    tx(ids);
    return { mutationId: `del-${Date.now()}` };
  }

  async getByIds(ids: string[]): Promise<VectorizeVector[]> {
    if (!ids.length) return [];
    const get = this.db.prepare(
      `SELECT id, values_json, metadata_json FROM sb_vectors WHERE id = ?`
    );
    const out: VectorizeVector[] = [];
    for (const id of ids) {
      const row = get.get(id) as
        | { id: string; values_json: string; metadata_json: string }
        | undefined;
      if (!row) continue;
      out.push({
        id: row.id,
        values: parseJson<number[]>(row.values_json, []),
        metadata: parseJson(row.metadata_json, {}),
      } as VectorizeVector);
    }
    return out;
  }

  async query(
    vector: number[],
    options: {
      topK?: number;
      returnMetadata?: boolean | "none" | "indexed" | "all";
      returnValues?: boolean;
      filter?: Record<string, unknown>;
    } = {}
  ): Promise<VectorizeMatches> {
    const topK = options.topK ?? 10;
    const rows = this.db
      .prepare(`SELECT id, values_json, metadata_json FROM sb_vectors`)
      .all() as { id: string; values_json: string; metadata_json: string }[];

    const scored = rows.map((row) => {
      const values = parseJson<number[]>(row.values_json, []);
      const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
      return {
        id: row.id,
        score: cosineSim(vector, values),
        metadata,
        values: options.returnValues ? values : undefined,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const matches = scored.slice(0, topK).map((m) => {
      const match: VectorizeMatch = {
        id: m.id,
        score: m.score,
      } as VectorizeMatch;
      if (options.returnMetadata && options.returnMetadata !== "none") {
        (match as any).metadata = m.metadata;
      }
      if (m.values) (match as any).values = m.values;
      return match;
    });

    return { matches, count: matches.length } as VectorizeMatches;
  }

  async describe(): Promise<VectorizeIndexDetails> {
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM sb_vectors`).get() as { n: number };
    return {
      id: "local",
      name: "second-brain-vectors",
      config: { dimensions: 384, metric: "cosine" },
      vectorsCount: row.n,
      dimensions: 384,
      vectorCount: row.n,
      processedUpToDatetime: new Date().toISOString(),
      processedUpToMutation: 0,
    } as unknown as VectorizeIndexDetails;
  }
}
