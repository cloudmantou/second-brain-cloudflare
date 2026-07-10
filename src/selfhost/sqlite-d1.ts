/**
 * D1-compatible SQLite adapter for self-host (better-sqlite3).
 * Supports prepare/bind/first/all/run/exec and SQLite json_each used by the app.
 */

import Database from "better-sqlite3";

type SqlValue = string | number | null | bigint;

export class SqliteD1Database {
  constructor(private db: Database.Database) {}

  prepare(sql: string): SqliteD1PreparedStatement {
    return new SqliteD1PreparedStatement(this.db, sql);
  }

  async exec(sql: string): Promise<D1ExecResult> {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  /** D1-compatible atomic batch used by telemetry and other bulk writes. */
  async batch(statements: SqliteD1PreparedStatement[]): Promise<D1Result[]> {
    const runBatch = this.db.transaction(() => {
      return statements.map((statement) => statement.runSync());
    });
    return runBatch();
  }

  /** Escape hatch for self-host internals (vector/KV tables). */
  raw(): Database.Database {
    return this.db;
  }
}

class SqliteD1PreparedStatement {
  private params: SqlValue[] = [];

  constructor(
    private db: Database.Database,
    private sql: string
  ) {}

  bind(...values: SqlValue[]): this {
    this.params = values.map((v) => (v === undefined ? null : v));
    return this;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) return (row[colName] as T) ?? null;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...this.params) as T[];
    return {
      results,
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: results.length,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
    };
  }

  async run(): Promise<D1Result> {
    return this.runSync();
  }

  runSync(): D1Result {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    return {
      results: [],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        changed_db: info.changes > 0,
        changes: info.changes,
      },
    };
  }
}
