export const MEMORY_REVISION_EVENTS = [
  "ADD",
  "UPDATE",
  "APPEND",
  "STATUS",
  "DEPRECATE",
  "ROLLUP",
  "UNROLL",
] as const;

export type MemoryRevisionEvent = (typeof MEMORY_REVISION_EVENTS)[number];

export interface MemoryRevisionInput {
  memoryId: string;
  eventType: MemoryRevisionEvent;
  oldContent?: string | null;
  newContent?: string | null;
  oldMetadata?: Record<string, unknown> | null;
  newMetadata?: Record<string, unknown> | null;
  reason?: string | null;
  actor: string;
  createdAt?: number;
}

function metadataJson(metadata: Record<string, unknown> | null | undefined): string | null {
  return metadata ? JSON.stringify(metadata) : null;
}

export interface MemoryRevisionRecord extends MemoryRevisionInput {
  id: string;
  createdAt: number;
}

function buildMemoryRevision(input: MemoryRevisionInput): MemoryRevisionRecord {
  const memoryId = input.memoryId.trim();
  const actor = input.actor.trim();
  if (!memoryId || !actor) {
    throw new Error("Memory revision requires memoryId and actor");
  }

  return {
    ...input,
    memoryId,
    actor,
    id: crypto.randomUUID(),
    createdAt: input.createdAt ?? Date.now(),
  };
}

function revisionStatement(db: D1Database, revision: MemoryRevisionRecord) {
  return db
    .prepare(
      `INSERT INTO sb_memory_revisions (
        id, memory_id, event_type, old_content, new_content,
        old_metadata_json, new_metadata_json, reason, actor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      revision.id,
      revision.memoryId,
      revision.eventType,
      revision.oldContent ?? null,
      revision.newContent ?? null,
      metadataJson(revision.oldMetadata),
      metadataJson(revision.newMetadata),
      revision.reason ?? null,
      revision.actor,
      revision.createdAt
    );
}

export function prepareMemoryRevision(
  db: D1Database,
  input: MemoryRevisionInput
) {
  const record = buildMemoryRevision(input);
  return { record, statement: revisionStatement(db, record) };
}
