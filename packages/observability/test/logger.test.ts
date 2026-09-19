/**
 * JsonlLogger tests — JSONL append, query filters, ring buffer, redaction,
 * and never-throw behavior on write failure.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlLogger } from '../src/logger.js';
import { REDACTED } from '../src/redact.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vyra-logs-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('JsonlLogger', () => {
  it('appends JSONL records to a daily-rotated file', () => {
    const logger = new JsonlLogger({ dataDir: tempDir(), component: 'test' });
    logger.info('task.start', { taskId: 't1', tool: 'computer_click' });
    const lines = readFileSync(logger.currentFilePath(), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record.level).toBe('info');
    expect(record.action).toBe('task.start');
    expect(record.taskId).toBe('t1');
    expect(record.tool).toBe('computer_click');
    expect(record.component).toBe('test');
    expect(typeof record.timestamp).toBe('string');
  });

  it('redacts secrets before writing', () => {
    const logger = new JsonlLogger({ dataDir: tempDir() });
    logger.info('provider.call', {
      result: 'called with sk-abcdefgh12345678',
    });
    const content = readFileSync(logger.currentFilePath(), 'utf8');
    expect(content).not.toContain('sk-abcdefgh12345678');
    expect(content).toContain(REDACTED);
  });

  it('query() filters by level and taskId', () => {
    const logger = new JsonlLogger({ dataDir: tempDir() });
    logger.info('a', { taskId: 't1' });
    logger.error('b', { taskId: 't1' });
    logger.error('c', { taskId: 't2' });
    expect(logger.query({ level: 'error' })).toHaveLength(2);
    expect(logger.query({ taskId: 't1' })).toHaveLength(2);
    expect(
      logger.query({ level: 'error', taskId: 't2' }).map((r) => r.action),
    ).toEqual(['c']);
  });

  it('query() respects the limit (most recent first window)', () => {
    const logger = new JsonlLogger({ dataDir: tempDir() });
    for (let i = 0; i < 10; i++) logger.info(`action-${i}`);
    const results = logger.query({ limit: 3 });
    expect(results.map((r) => r.action)).toEqual([
      'action-7',
      'action-8',
      'action-9',
    ]);
  });

  it('getRecent(n) serves the live log panel from the ring buffer', () => {
    const logger = new JsonlLogger({
      dataDir: tempDir(),
      ringSize: 3,
    });
    for (let i = 0; i < 5; i++) logger.info(`action-${i}`);
    expect(logger.getRecent(10).map((r) => r.action)).toEqual([
      'action-2',
      'action-3',
      'action-4',
    ]);
    expect(logger.getRecent(2).map((r) => r.action)).toEqual([
      'action-3',
      'action-4',
    ]);
  });

  it('never throws when the log directory is not writable', () => {
    // A file where the log directory should be makes mkdir/append fail.
    const blocker = join(tempDir(), 'blocker');
    writeFileSync(blocker, 'x');
    const logger = new JsonlLogger({ dataDir: join(blocker, 'logs') });
    expect(() => logger.info('should not throw')).not.toThrow();
    // The record is still available in memory for the live panel.
    expect(logger.getRecent(1).map((r) => r.action)).toEqual([
      'should not throw',
    ]);
  });

  it('query() returns [] instead of throwing on a missing log dir', () => {
    const logger = new JsonlLogger({ dataDir: join(tempDir(), 'never-made') });
    expect(logger.query()).toEqual([]);
  });
});
