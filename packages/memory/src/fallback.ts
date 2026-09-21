/**
 * Graceful memory fallback for VYRA.
 *
 * If the better-sqlite3 native module cannot load (wrong ABI, missing build
 * tools, broken install), VYRA must NOT die: it keeps running with
 * session-scoped in-memory storage and says so loudly. Persistent memory is
 * a convenience; tasks, voice, and the wake word are the product.
 */
import type { AgentEvent } from '@vyra/shared';
import {
  SQLiteMemory,
  type MemoryRecord,
  type RecallOptions,
  type SQLiteMemoryOptions,
} from './memory.js';

/**
 * In-memory key/value memory with the same public interface as
 * SQLiteMemory: remember / recall / updateMemory / forgetMemory / close.
 * Same validation rules (secret-like keys are refused), same record shape,
 * same newest-first recall ordering. Data lives only for this session.
 */
export class InMemoryMemory {
  private readonly store = new Map<string, MemoryRecord>();
  private readonly emitFn?: (event: AgentEvent) => void;

  constructor(options: SQLiteMemoryOptions = {}) {
    this.emitFn = options.emit;
  }

  private emitEvent(
    action: 'remember' | 'recall' | 'update' | 'forget',
    key?: string,
  ): void {
    this.emitFn?.({
      type: 'memory.event',
      timestamp: new Date().toISOString(),
      payload: { action, key },
    });
  }

  private static checkKey(
    key: string,
    method: string,
    secretPattern: RegExp,
  ): void {
    if (!key || !key.trim()) {
      throw new Error(`[VYRA memory] ${method}() requires a non-empty key.`);
    }
    if (secretPattern.test(key)) {
      throw new Error(
        'SECURITY: refusing to store a secret-like key. ' +
          'Secrets are not ordinary memory — use the Secure Vault instead.',
      );
    }
  }

  remember(key: string, value: string, category?: string): void {
    InMemoryMemory.checkKey(key, 'remember', SECRET_KEY_PATTERN);
    const now = new Date().toISOString();
    const existing = this.store.get(key);
    this.store.set(key, {
      key,
      value,
      category: category ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.emitEvent('remember', key);
  }

  recall(options: RecallOptions = {}): MemoryRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const query = options.query?.toLowerCase();
    const matches = [...this.store.values()].filter((r) => {
      if (options.category && r.category !== options.category) return false;
      if (query) {
        const haystack =
          `${r.key} ${r.value} ${r.category ?? ''}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    matches.sort((a, b) =>
      a.updatedAt === b.updatedAt
        ? a.key.localeCompare(b.key)
        : a.updatedAt < b.updatedAt
          ? 1
          : -1,
    );
    this.emitEvent('recall');
    return matches.slice(0, limit);
  }

  updateMemory(key: string, value: string): void {
    InMemoryMemory.checkKey(key, 'updateMemory', SECRET_KEY_PATTERN);
    const existing = this.store.get(key);
    if (!existing) {
      throw new Error(`[VYRA memory] No memory stored under key "${key}".`);
    }
    this.store.set(key, {
      ...existing,
      value,
      updatedAt: new Date().toISOString(),
    });
    this.emitEvent('update', key);
  }

  forgetMemory(key: string): boolean {
    const removed = this.store.delete(key);
    if (removed) this.emitEvent('forget', key);
    return removed;
  }

  close(): void {
    this.store.clear();
  }
}

// Same secret-key rule as SQLiteMemory; kept in sync by the tests.
const SECRET_KEY_PATTERN = /api[_-]?key|token|secret|password/i;

export interface CreateMemoryOptions extends SQLiteMemoryOptions {
  /**
   * Called once when persistent memory is unavailable and the session
   * fallback takes over. Receives the real underlying error — log it,
   * show it, never swallow it.
   */
  onDegraded?: (err: Error) => void;
}

/**
 * Build VYRA's memory: SQLite when the native module loads, session memory
 * otherwise. Never throws for a broken native module — the probe forces the
 * load here, at startup, instead of mid-task later.
 */
export function createMemory(
  dbPath: string,
  options: CreateMemoryOptions = {},
): SQLiteMemory | InMemoryMemory {
  const sqlite = new SQLiteMemory(dbPath, options);
  try {
    sqlite.recall({ limit: 1 }); // probe: forces better-sqlite3 to load now
    return sqlite;
  } catch (err) {
    const real = err instanceof Error ? err : new Error(String(err));
    try {
      options.onDegraded?.(real);
    } catch {
      // The reporter must never break startup either.
    }
    return new InMemoryMemory(options);
  }
}
