import { describe, expect, it } from 'vitest';
import { InMemoryMemory, createMemory } from '../src/fallback.js';

describe('InMemoryMemory', () => {
  it('remembers, recalls, updates, and forgets', () => {
    const mem = new InMemoryMemory();
    mem.remember('user.name', 'Harman Nijhawan', 'identity');
    mem.remember('other', 'x');

    const byCategory = mem.recall({ category: 'identity' });
    expect(byCategory).toHaveLength(1);
    expect(byCategory[0]).toMatchObject({
      key: 'user.name',
      value: 'Harman Nijhawan',
      category: 'identity',
    });

    const byQuery = mem.recall({ query: 'nijhawan' });
    expect(byQuery).toHaveLength(1);
    expect(byQuery[0].key).toBe('user.name');

    mem.updateMemory('user.name', 'Harman');
    expect(mem.recall({ query: 'harman' })[0].value).toBe('Harman');
    expect(() => mem.updateMemory('missing', 'v')).toThrow(/No memory stored/);

    expect(mem.forgetMemory('user.name')).toBe(true);
    expect(mem.forgetMemory('user.name')).toBe(false);
    expect(mem.recall({ category: 'identity' })).toHaveLength(0);
  });

  it('respects limit and orders like SQLite (updated_at DESC, key ASC)', () => {
    const mem = new InMemoryMemory();
    mem.remember('a', '1');
    mem.remember('b', '2');
    mem.remember('c', '3');
    const all = mem.recall();
    // Same-millisecond writes tie on updated_at, so key ASC breaks the tie —
    // identical to the SQLite ORDER BY.
    expect(all.map((r) => r.key)).toEqual(['a', 'b', 'c']);
    expect(mem.recall({ limit: 2 })).toHaveLength(2);
  });

  it('refuses secret-like keys, like SQLiteMemory does', () => {
    const mem = new InMemoryMemory();
    expect(() => mem.remember('api_key', 'x')).toThrow(/SECURITY/);
    expect(() => mem.remember('  ', 'x')).toThrow(/non-empty key/);
    mem.remember('ok', 'v');
    expect(() => mem.updateMemory('my_token', 'v')).toThrow(/SECURITY/);
  });
});

describe('createMemory', () => {
  it('returns working memory backed by SQLite when the native module loads', () => {
    const onDegraded: Error[] = [];
    const mem = createMemory(':memory:', {
      onDegraded: (e) => onDegraded.push(e),
    });
    mem.remember('k', 'v');
    expect(mem.recall({ query: 'k' })).toHaveLength(1);
    expect(onDegraded).toHaveLength(0);
    mem.close();
  });
});
