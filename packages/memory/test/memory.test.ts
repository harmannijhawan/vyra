import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@vyra/shared';
import { SessionContext, SQLiteMemory } from '../src/index.js';

describe('SQLiteMemory (:memory:)', () => {
  let memories: SQLiteMemory[] = [];

  afterEach(() => {
    for (const m of memories) m.close();
    memories = [];
  });

  function fresh(emit?: (event: AgentEvent) => void): SQLiteMemory {
    const m = new SQLiteMemory(':memory:', emit ? { emit } : {});
    memories.push(m);
    return m;
  }

  it('round-trips remember → recall → update → forget', () => {
    const mem = fresh();

    mem.remember('user.name', 'Harman', 'profile');
    mem.remember('user.editor', 'vscode', 'preferences');

    const all = mem.recall();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.key === 'user.name')).toMatchObject({
      value: 'Harman',
      category: 'profile',
    });

    mem.updateMemory('user.name', 'Harman Nijhawan');
    expect(mem.recall({ query: 'user.name' })[0]?.value).toBe('Harman Nijhawan');

    expect(mem.forgetMemory('user.name')).toBe(true);
    expect(mem.recall({ query: 'user.name' })).toHaveLength(0);

    // Forgetting an unknown key returns false, not an error.
    expect(mem.forgetMemory('does.not.exist')).toBe(false);
  });

  it('remember() upserts on key conflict', () => {
    const mem = fresh();
    mem.remember('k', 'v1', 'a');
    mem.remember('k', 'v2', 'b');
    const [record] = mem.recall({ query: 'k' });
    expect(record).toMatchObject({ value: 'v2', category: 'b' });
  });

  it('recall filters by query (LIKE over key/value/category)', () => {
    const mem = fresh();
    mem.remember('project.alpha.deadline', 'Friday', 'work');
    mem.remember('project.beta.deadline', 'Monday', 'work');
    mem.remember('favorite.snack', 'samosa', 'personal');

    const deadlines = mem.recall({ query: 'deadline' });
    expect(deadlines.map((r) => r.key).sort()).toEqual([
      'project.alpha.deadline',
      'project.beta.deadline',
    ]);

    // Query matches inside values too.
    expect(mem.recall({ query: 'samosa' }).map((r) => r.key)).toEqual(['favorite.snack']);
  });

  it('recall filters by category', () => {
    const mem = fresh();
    mem.remember('a', '1', 'work');
    mem.remember('b', '2', 'personal');

    expect(mem.recall({ category: 'work' }).map((r) => r.key)).toEqual(['a']);
    expect(mem.recall({ category: 'personal' }).map((r) => r.key)).toEqual(['b']);
  });

  it('recall respects limit', () => {
    const mem = fresh();
    for (let i = 0; i < 10; i++) mem.remember(`key.${i}`, `value ${i}`);
    expect(mem.recall({ limit: 3 })).toHaveLength(3);
  });

  it('remember() rejects secret-like keys with a SECURITY error', () => {
    const mem = fresh();
    for (const key of ['github_token', 'OPENAI_API_KEY', 'db-password', 'client_secret', 'apiKey']) {
      expect(() => mem.remember(key, 'super-secret-value')).toThrow(/SECURITY/i);
    }
    // And nothing was stored.
    expect(mem.recall()).toHaveLength(0);
  });

  it('updateMemory() also rejects secret-like keys and unknown keys', () => {
    const mem = fresh();
    mem.remember('safe.key', 'v');
    expect(() => mem.updateMemory('github_token', 'x')).toThrow(/SECURITY/i);
    expect(() => mem.updateMemory('missing.key', 'x')).toThrow(/no memory stored/i);
  });

  it('emits memory.event AgentEvents for remember/update/forget', () => {
    const events: AgentEvent[] = [];
    const mem = fresh((e) => events.push(e));

    mem.remember('k', 'v');
    mem.updateMemory('k', 'v2');
    mem.forgetMemory('k');

    const actions = events
      .filter((e) => e.type === 'memory.event')
      .map((e) => (e.payload as { action: string }).action);
    expect(actions).toEqual(['remember', 'update', 'forget']);
  });

  it('requires a dbPath', () => {
    // The better-sqlite3-missing path is guarded by the lazy loader in
    // memory.ts; without the native module installed it throws a clear
    // "[VYRA memory] better-sqlite3 is not available" error.
    expect(() => new SQLiteMemory('')).toThrow(/dbPath is required/i);
  });
});

describe('SessionContext', () => {
  it('stores turns, task context and screen context; clear() resets', () => {
    const session = new SessionContext();

    session.addTurn('user', 'open chrome');
    session.addTurn('assistant', 'opening chrome');
    session.setTaskContext('task-123');
    session.setScreenContext('Chrome window with 3 tabs');

    expect(session.getRecent(10)).toHaveLength(2);
    expect(session.getRecent(1)[0]).toMatchObject({ role: 'assistant', text: 'opening chrome' });
    expect(session.getTaskContext()).toBe('task-123');
    expect(session.getScreenContext()).toBe('Chrome window with 3 tabs');

    session.clear();
    expect(session.getRecent(10)).toEqual([]);
    expect(session.getTaskContext()).toBeNull();
    expect(session.getScreenContext()).toBeNull();
  });

  it('bounds the turn buffer to maxTurns', () => {
    const session = new SessionContext(5);
    for (let i = 0; i < 10; i++) session.addTurn('user', `msg ${i}`);
    expect(session.getTurnCount()).toBe(5);
    expect(session.getRecent(5)[0]?.text).toBe('msg 5');
  });

  it('getRecent(0) returns an empty list', () => {
    const session = new SessionContext();
    session.addTurn('user', 'hi');
    expect(session.getRecent(0)).toEqual([]);
  });

  it('rejects invalid maxTurns', () => {
    expect(() => new SessionContext(0)).toThrow(/maxTurns/i);
  });
});
