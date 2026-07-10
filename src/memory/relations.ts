export const MEMORY_RELATION_TYPES = [
  "updates",
  "supersedes",
  "contradicts",
  "supports",
  "similar",
  "continuation_of",
  "digest_of",
  "derived_from",
  "same_entity",
] as const;

export type MemoryRelationType = (typeof MEMORY_RELATION_TYPES)[number];

export interface MemoryRelationInput {
  fromMemoryId: string;
  toMemoryId: string;
  relationType: MemoryRelationType;
  score?: number | null;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export interface MemoryRelationRecord {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  relationType: MemoryRelationType;
  score: number | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface MemoryRelationView {
  id: string;
  direction: "incoming" | "outgoing";
  relation: MemoryRelationType;
  score: number | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  other: {
    id: string;
    content: string | null;
    tags: string[];
    source: string | null;
    createdAt: number | null;
  };
}

interface StoredRelationRow {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  relation_type: MemoryRelationType;
  score: number | null;
  metadata_json: string;
  created_at: number;
}

interface RelatedEntryRow {
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
}

function validateScore(score: number | null): number | null {
  if (score === null) return null;
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error("Memory relation score must be between 0 and 1");
  }
  return score;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseTags(raw: string): string[] {
  try {
    const value = JSON.parse(raw || "[]");
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

export function buildMemoryRelation(input: MemoryRelationInput): MemoryRelationRecord {
  const fromMemoryId = input.fromMemoryId.trim();
  const toMemoryId = input.toMemoryId.trim();
  if (!fromMemoryId || !toMemoryId) {
    throw new Error("Memory relation endpoints are required");
  }
  if (fromMemoryId === toMemoryId) {
    throw new Error("A memory cannot relate to itself");
  }
  if (!(MEMORY_RELATION_TYPES as readonly string[]).includes(input.relationType)) {
    throw new Error("Unsupported memory relation type");
  }

  return {
    id: crypto.randomUUID(),
    fromMemoryId,
    toMemoryId,
    relationType: input.relationType,
    score: validateScore(input.score ?? null),
    metadata: { ...(input.metadata ?? {}) },
    createdAt: input.createdAt ?? Date.now(),
  };
}

function relationStatement(db: D1Database, relation: MemoryRelationRecord) {
  return db
    .prepare(
      `INSERT INTO sb_memory_relations (
        id, from_memory_id, to_memory_id, relation_type, score, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(from_memory_id, to_memory_id, relation_type) DO NOTHING`
    )
    .bind(
      relation.id,
      relation.fromMemoryId,
      relation.toMemoryId,
      relation.relationType,
      relation.score,
      JSON.stringify(relation.metadata),
      relation.createdAt
    );
}

export function prepareMemoryRelation(
  db: D1Database,
  input: MemoryRelationInput
) {
  const record = buildMemoryRelation(input);
  return { record, statement: relationStatement(db, record) };
}

export async function createMemoryRelations(
  db: D1Database,
  inputs: MemoryRelationInput[]
): Promise<MemoryRelationRecord[]> {
  if (!inputs.length) return [];
  const prepared = inputs.map(input => prepareMemoryRelation(db, input));
  await db.batch(prepared.map(item => item.statement));
  return prepared.map(item => item.record);
}

export async function listMemoryRelations(
  db: D1Database,
  memoryId: string,
  limit = 50
): Promise<MemoryRelationView[]> {
  const id = memoryId.trim();
  if (!id) throw new Error("Memory id is required");
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.trunc(limit), 100))
    : 50;
  const { results } = await db
    .prepare(
      `SELECT id, from_memory_id, to_memory_id, relation_type,
              score, metadata_json, created_at
       FROM sb_memory_relations
       WHERE from_memory_id = ? OR to_memory_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(id, id, safeLimit)
    .all<StoredRelationRow>();
  if (!results.length) return [];

  const otherIds = [...new Set(results.map(row =>
    row.from_memory_id === id ? row.to_memory_id : row.from_memory_id
  ))];
  const entries = new Map<string, RelatedEntryRow>();
  for (let index = 0; index < otherIds.length; index += 100) {
    const batch = otherIds.slice(index, index + 100);
    const placeholders = batch.map(() => "?").join(", ");
    const { results: entryRows } = await db
      .prepare(
        `SELECT id, content, tags, source, created_at
         FROM entries WHERE id IN (${placeholders})`
      )
      .bind(...batch)
      .all<RelatedEntryRow>();
    for (const entry of entryRows) entries.set(entry.id, entry);
  }

  return results.map(row => {
    const outgoing = row.from_memory_id === id;
    const otherId = outgoing ? row.to_memory_id : row.from_memory_id;
    const entry = entries.get(otherId);
    return {
      id: row.id,
      direction: outgoing ? "outgoing" : "incoming",
      relation: row.relation_type,
      score: row.score ?? null,
      metadata: parseJsonObject(row.metadata_json),
      createdAt: row.created_at,
      other: {
        id: otherId,
        content: entry?.content ?? null,
        tags: parseTags(entry?.tags ?? "[]"),
        source: entry?.source ?? null,
        createdAt: entry?.created_at ?? null,
      },
    };
  });
}
