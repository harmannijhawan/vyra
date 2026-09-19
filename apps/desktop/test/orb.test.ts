/**
 * Orb animation mapping tests — every VoiceState must resolve to a
 * defined CSS class; nothing may fall through to undefined.
 */
import { describe, expect, it } from 'vitest';
import { VoiceState } from '@vyra/shared';
import { ORB_CLASS_BY_STATE, orbClassForState } from '../src/renderer/lib/orbState';

const ALL_STATES = Object.values(VoiceState);

describe('orb voice-state mapping', () => {
  it('covers all 10 voice states', () => {
    expect(ALL_STATES).toHaveLength(10);
    for (const state of ALL_STATES) {
      expect(ORB_CLASS_BY_STATE[state], `missing mapping for ${state}`).toBeDefined();
    }
  });

  it('returns a non-empty CSS class for every state', () => {
    for (const state of ALL_STATES) {
      const cls = orbClassForState(state);
      expect(typeof cls).toBe('string');
      expect(cls.length).toBeGreaterThan(0);
      expect(cls).toMatch(/^orb--/);
    }
  });

  it('gives each state a distinct animation class', () => {
    const classes = ALL_STATES.map((s) => orbClassForState(s));
    expect(new Set(classes).size).toBe(ALL_STATES.length);
  });

  it('throws on an unknown state instead of returning undefined', () => {
    expect(() => orbClassForState('SLEEPING' as VoiceState)).toThrow();
  });
});
