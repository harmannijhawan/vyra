/**
 * SQLite-backed long-term memory for VYRA.
 *
 * better-sqlite3 is required lazily (inside try/catch): if the native module
 * is unavailable in this environment the constructor throws a clear,
 * actionable error instead of crashing at import time. Tests use ":memory:".
 *
 * Schema:
 *   memories(key TEXT PRIMARY KEY, value TEXT, category TEXT,
 *            created_at TEXT, updated_at TEXT)
 *
 * Query today is a LIKE search over key/value/category — documented upgrade
 * path is an FTS5 virtual table (or vector embeddings) when recall quality
 * needs it; the RecallOptions interface already carries the query shape.
 *
 * SECURITY: remember()/updateMemory() refuse any key matching
 * /api[_-]?key|token|secret|password/i. Secrets are not ordinary memory —
 * they belong in the Secure Vault, never in this table.
 */
import { createRequire } from 'node:module';
import type { AgentEvent } from '@vyra/shared';

const SECRET_KEY_PATTERN = /api[_-]?key|token|secret|password/i;

export interface MemoryRecord {
  key: string;
  value: string;
  category: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecallOptions {
  query?: string;
  category?: string;
  limit?: number;
}

export interface SQLiteMemoryOptions {
  /** Sink for 'memory.event' AgentEvents (remember/recall/update/forget). */
  emit?: (event: AgentEvent) => void;
}

/** Minimal structural type for the better-sqlite3 handle (loaded lazily). */
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    all(...params: unknown[]): Record<string, unknown>[];
  };
  close(): void;
}

let CachedDatabase: (new (path: string) => SqliteDb) | null = null;
let loadFailed = false;

function loadDatabaseConstructor(): new (path: string) => SqliteDb {
  if (CachedDatabase) return CachedDatabase;
  if (loadFailed) {
    throw new Error(
      '[VYRA memory] better-sqlite3 could not be loaded — persistent memory is unavailable.',
    );
  }
  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    CachedDatabase = require('better-sqlite3') as new (path: string) => SqliteDb;
    return CachedDatabase;
  } catch {
    loadFailed = true;
    throw new Error(
      '[VYRA memory] better-sqlite3 is not available in this environment — ' +
        'persistent memory cannot run. Install the "better-sqlite3" dependency to enable it.',
    );
  }
}

/** Escape LIKE wildcards so a user query is matched literally. */
function escapeLike(query: string): string {
  return query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class SQLiteMemory {
  private db: SqliteDb | null = null;
  private readonly emitFn?: (event: AgentEvent) => void;

  /**
   * @param dbPath filesystem path for the SQLite file, or ":memory:" for
   * an ephemeral database (used by tests).
   */
  constructor(
    private readonly dbPath: string,
    options: SQLiteMemoryOptions = {},
  ) {
    if (!dbPath) {
      throw new Error('[VYRA memory] dbPath is required.');
    }
    this.emitFn = options.emit;
  }

  private open(): SqliteDb {
    if (this.db) return this.db;
    const Database = loadDatabaseConstructor();
    const db = new Database(this.dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        category TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
    `);
    this.db = db;
    return db;
  }

  private emitEvent(action: 'remember' | 'recall' | 'update' | 'forget', key?: string): void {
    this.emitFn?.({
      type: 'memory.event',
      timestamp: new Date().toISOString(),
      payload: { action, key },
    });
  }

  private rejectSecretKey(key: string): void {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(
        'SECURITY: refusing to store a secret-like key. ' +
          'Secrets are not ordinary memory — use the Secure Vault instead.',
      );
    }
  }

  private static rowToRecord(row: Record<string, unknown>): MemoryRecord {
    return {
      key: String(row['key']),
      value: String(row['value']),
      category: row['category'] == null ? null : String(row['category']),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }

  /** Store a memory (upsert by key). Throws a SECURITY error for secret-like keys. */
  remember(key: string, value: string, category?: string): void {
    if (!key || !key.trim()) {
      throw new Error('[VYRA memory] remember() requires a non-empty key.');
    }
    this.rejectSecretKey(key);
    const now = new Date().toISOString();
    this.open()
      .prepare(
        `INSERT INTO memories (key, value, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           category = excluded.category,
           updated_at = excluded.updated_at`,
      )
      .run(key, value, category ?? null, now, now);
    this.emitEvent('remember', key);
  }

  /**
   * Recall memories, newest first. `query` does a LIKE search over
   * key/value/category (upgrade path: FTS5 or embeddings).
   */
  recall(options: RecallOptions = {}): MemoryRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (options.category) {
      where.push('category = ?');
      params.push(options.category);
    }
    if (options.query) {
      const like = `%${escapeLike(options.query)}%`;
      where.push("(key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }

    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const sql =
      'SELECT key, value, category, created_at, updated_at FROM memories' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY updated_at DESC, key ASC' +
      ` LIMIT ${limit}`;
    const rows = this.open().prepare(sql).all(...params);
    this.emitEvent('recall');
    return rows.map(SQLiteMemory.rowToRecord);
  }

  /** Replace the value of an existing memory. Throws if the key is unknown. */
  updateMemory(key: string, value: string): void {
    this.rejectSecretKey(key);
    const info = this.open()
      .prepare('UPDATE memories SET value = ?, updated_at = ? WHERE key = ?')
      .run(value, new Date().toISOString(), key);
    if (info.changes === 0) {
      throw new Error(`[VYRA memory] No memory stored under key "${key}".`);
    }
    this.emitEvent('update', key);
  }

  /** Delete a memory. Returns true when a row was actually removed. */
  forgetMemory(key: string): boolean {
    const info = this.open().prepare('DELETE FROM memories WHERE key = ?').run(key);
    const removed = info.changes > 0;
    if (removed) this.emitEvent('forget', key);
    return removed;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
