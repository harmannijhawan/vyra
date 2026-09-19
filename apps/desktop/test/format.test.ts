/** Pure helper tests — time formatting used across the renderer. */
import { describe, expect, it } from 'vitest';
import { formatClockTime, timeAgo } from '../src/renderer/lib/format';

describe('formatClockTime', () => {
  it('returns — for invalid input', () => {
    expect(formatClockTime('not-a-date')).toBe('—');
  });
  it('formats a valid timestamp', () => {
    const out = formatClockTime('2026-09-20T12:34:56.000Z');
    expect(out).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });
});

describe('timeAgo', () => {
  const now = new Date('2026-09-20T12:00:00.000Z').getTime();
  it('handles recent and older timestamps', () => {
    expect(timeAgo(new Date(now - 2000).toISOString(), now)).toBe('just now');
    expect(timeAgo(new Date(now - 30_000).toISOString(), now)).toBe('30s ago');
    expect(timeAgo(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5m ago');
    expect(timeAgo(new Date(now - 3 * 3600_000).toISOString(), now)).toBe('3h ago');
    expect(timeAgo(new Date(now - 2 * 86400_000).toISOString(), now)).toBe('2d ago');
  });
  it('returns — for invalid input', () => {
    expect(timeAgo('nope', now)).toBe('—');
  });
});
