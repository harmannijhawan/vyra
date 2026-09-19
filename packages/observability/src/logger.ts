/**
 * JsonlLogger — VYRA's structured log sink.
 *
 * - Appends StructuredLog records (timestamp, level, taskId?, tool?,
 *   action, result?, durationMs?, error?, component) as JSONL to a
 *   daily-rotated file under `<dataDir>/logs/vyra-YYYY-MM-DD.jsonl`.
 * - Keeps an in-memory ring buffer for the live log panel (getRecent(n)).
 * - query({ level, taskId, limit }) reads records back from disk.
 * - EVERYTHING written passes through redactSecrets() first.
 * - Never throws on write failure: it falls back to console.error and
 *   keeps the record in the ring buffer.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StructuredLog } from '@vyra/shared';
import { redactSecrets } from './redact.js';

export interface LogQuery {
  level?: StructuredLog['level'];
  taskId?: string;
  /** Max records to return (most recent first). Defaults to 200. */
  limit?: number;
}

export interface JsonlLoggerOptions {
  /** e.g. ~/.vyra — logs land in <dataDir>/logs. */
  dataDir: string;
  /** Component name stamped on records logged via the helpers. */
  component?: string;
  /** Ring buffer size for the live panel. Defaults to 500. */
  ringSize?: number;
  /** Override "today" for rotation (tests). Defaults to the real date. */
  now?: () => Date;
}

export type LogInput = Omit<StructuredLog, 'timestamp' | 'component'> & {
  timestamp?: string;
  component?: string;
};

function dayStamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class JsonlLogger {
  private readonly logDir: string;
  private readonly ring: StructuredLog[] = [];
  private readonly ringSize: number;
  private readonly defaultComponent: string;
  private readonly now: () => Date;

  constructor(opts: JsonlLoggerOptions) {
    this.logDir = join(opts.dataDir, 'logs');
    this.ringSize = opts.ringSize ?? 500;
    this.defaultComponent = opts.component ?? 'vyra';
    this.now = opts.now ?? (() => new Date());
  }

  /** Path of the current daily log file (useful for tests/diagnostics). */
  currentFilePath(): string {
    return join(this.logDir, `vyra-${dayStamp(this.now())}.jsonl`);
  }

  /** Write one structured record. Never throws. */
  log(input: LogInput): void {
    const record = redactSecrets<StructuredLog>({
      timestamp: new Date().toISOString(),
      ...input,
      component: input.component ?? this.defaultComponent,
    });
    this.ring.push(record);
    if (this.ring.length > this.ringSize) {
      this.ring.splice(0, this.ring.length - this.ringSize);
    }
    try {
      mkdirSync(this.logDir, { recursive: true });
      appendFileSync(this.currentFilePath(), JSON.stringify(record) + '\n', {
        encoding: 'utf8',
      });
    } catch (err) {
      // Logging must never crash the app; keep the record in memory.
      console.error(
        '[vyra] failed to write log record:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  debug(action: string, extra?: Partial<LogInput>): void {
    this.log({ level: 'debug', action, ...extra });
  }
  info(action: string, extra?: Partial<LogInput>): void {
    this.log({ level: 'info', action, ...extra });
  }
  warn(action: string, extra?: Partial<LogInput>): void {
    this.log({ level: 'warn', action, ...extra });
  }
  error(action: string, extra?: Partial<LogInput>): void {
    this.log({ level: 'error', action, ...extra });
  }

  /** Most recent n records from the in-memory ring (oldest → newest). */
  getRecent(n: number): StructuredLog[] {
    return this.ring.slice(Math.max(0, this.ring.length - n));
  }

  /**
   * Read records back from the daily JSONL files. Filters by level and
   * taskId; returns the most recent `limit` matches (oldest → newest).
   * Never throws — returns [] when the log dir is unreadable.
   */
  query(q: LogQuery = {}): StructuredLog[] {
    const limit = q.limit ?? 200;
    let files: string[] = [];
    try {
      files = readdirSync(this.logDir)
        .filter((f: string) => f.startsWith('vyra-') && f.endsWith('.jsonl'))
        .sort();
    } catch {
      return [];
    }
    const matches: StructuredLog[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(this.logDir, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed) as StructuredLog;
          if (q.level && record.level !== q.level) continue;
          if (q.taskId && record.taskId !== q.taskId) continue;
          matches.push(record);
        } catch {
          // Skip corrupt lines; never fail a query over one bad line.
        }
      }
    }
    return matches.slice(Math.max(0, matches.length - limit));
  }
}

/** Create a logger in one call. */
export function createLogger(opts: JsonlLoggerOptions): JsonlLogger {
  return new JsonlLogger(opts);
}
