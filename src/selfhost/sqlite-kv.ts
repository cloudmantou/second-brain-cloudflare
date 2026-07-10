/**
 * Minimal KVNamespace implementation backed by SQLite (for OAuthProvider state).
 */

import type Database from "better-sqlite3";
import { OAUTH_CLIENT_IDLE_TTL_MS } from "../oauth/constants";

export const SELFHOST_OAUTH_CLIENT_IDLE_TTL_MS = OAUTH_CLIENT_IDLE_TTL_MS;

export interface SqliteKVOptions {
  oauthClientIdleTtlMs?: number;
  now?: () => number;
}

export class SqliteKVNamespace {
  private readonly oauthClientIdleTtlMs: number;
  private readonly now: () => number;

  constructor(private db: Database.Database, options: SqliteKVOptions = {}) {
    this.oauthClientIdleTtlMs = Math.max(
      1,
      options.oauthClientIdleTtlMs ?? SELFHOST_OAUTH_CLIENT_IDLE_TTL_MS
    );
    this.now = options.now ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sb_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );
    `);
    this.db
      .prepare(
        `UPDATE sb_kv SET expires_at = ?
         WHERE key LIKE 'client:%' AND expires_at IS NULL`
      )
      .run(this.now() + this.oauthClientIdleTtlMs);
  }

  async get(
    key: string,
    options?: { type?: string } | string
  ): Promise<string | null> {
    this.purgeExpired();
    const row = this.db
      .prepare(
        `SELECT value FROM sb_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`
      )
      .get(key, this.now()) as { value: string } | undefined;
    if (!row) return null;
    if (key.startsWith("client:")) {
      this.db
        .prepare(`UPDATE sb_kv SET expires_at = ? WHERE key = ?`)
        .run(this.now() + this.oauthClientIdleTtlMs, key);
    }
    const type = typeof options === "string" ? options : options?.type;
    if (type === "json") {
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    }
    return row.value;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: { expirationTtl?: number; expiration?: number }
  ): Promise<void> {
    let text: string;
    if (typeof value === "string") text = value;
    else if (value instanceof ArrayBuffer) {
      text = Buffer.from(value).toString("utf8");
    } else {
      text = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
    }

    let expiresAt: number | null = null;
    if (key.startsWith("client:")) {
      // Override the provider's longer fixed registration TTL. Self-hosted
      // clients use the personal 30-day sliding idle window instead.
      expiresAt = this.now() + this.oauthClientIdleTtlMs;
    } else if (options?.expirationTtl != null) {
      expiresAt = this.now() + options.expirationTtl * 1000;
    } else if (options?.expiration != null) {
      expiresAt = options.expiration * 1000;
    }

    this.db
      .prepare(
        `INSERT INTO sb_kv (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
      )
      .run(key, text, expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare(`DELETE FROM sb_kv WHERE key = ?`).run(key);
  }

  async list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    keys: { name: string; expiration?: number }[];
    list_complete: boolean;
    cursor?: string;
    cacheStatus: null;
  }> {
    this.purgeExpired();
    const limit = Math.min(Math.max(options?.limit ?? 1000, 1), 1000);
    const prefix = options?.prefix ?? "";
    const cursor = options?.cursor ?? "";
    const rows = this.db
      .prepare(
        `SELECT key, expires_at FROM sb_kv
         WHERE key LIKE ? AND key > ?
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY key LIMIT ?`
      )
      .all(`${prefix}%`, cursor, this.now(), limit + 1) as {
        key: string;
        expires_at: number | null;
      }[];
    const page = rows.slice(0, limit);
    const listComplete = rows.length <= limit;

    return {
      keys: page.map((r) => ({
        name: r.key,
        ...(r.expires_at != null ? { expiration: Math.floor(r.expires_at / 1000) } : {}),
      })),
      list_complete: listComplete,
      ...(listComplete || page.length === 0
        ? {}
        : { cursor: page[page.length - 1].key }),
      cacheStatus: null,
    };
  }

  async getWithMetadata(
    key: string
  ): Promise<{ value: string | null; metadata: unknown; cacheStatus: null }> {
    const value = await this.get(key);
    return { value, metadata: null, cacheStatus: null };
  }

  private purgeExpired(): void {
    this.db.prepare(`DELETE FROM sb_kv WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(this.now());
  }
}
