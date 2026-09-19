/**
 * IPC allowlist tests — the preload bridge must expose EXACTLY the
 * channels in the @vyra/shared contract: no more, no less.
 */
import { describe, expect, it } from 'vitest';
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '@vyra/shared';
import {
  ALLOWED_EVENT_CHANNELS,
  ALLOWED_INVOKE_CHANNELS,
  assertEventChannel,
  assertInvokeChannel,
} from '../src/preload/bridge';

describe('preload channel allowlist', () => {
  it('exposes exactly INVOKE_CHANNELS — no more, no less', () => {
    expect([...ALLOWED_INVOKE_CHANNELS].sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(ALLOWED_INVOKE_CHANNELS).toHaveLength(INVOKE_CHANNELS.length);
  });

  it('exposes exactly EVENT_CHANNELS — no more, no less', () => {
    expect([...ALLOWED_EVENT_CHANNELS].sort()).toEqual([...EVENT_CHANNELS].sort());
    expect(ALLOWED_EVENT_CHANNELS).toHaveLength(EVENT_CHANNELS.length);
  });

  it('contains no wildcards or empty strings', () => {
    for (const channel of [...ALLOWED_INVOKE_CHANNELS, ...ALLOWED_EVENT_CHANNELS]) {
      expect(channel).toMatch(/^vyra:[a-z0-9-]+(:[a-z0-9-]+)*$/);
      expect(channel).not.toContain('*');
    }
  });

  it('accepts every allowlisted invoke channel', () => {
    for (const channel of INVOKE_CHANNELS) {
      expect(() => assertInvokeChannel(channel)).not.toThrow();
    }
  });

  it('rejects non-allowlisted invoke channels', () => {
    expect(() => assertInvokeChannel('vyra:evil:channel')).toThrow();
    expect(() => assertInvokeChannel('')).toThrow();
    expect(() => assertInvokeChannel('vyra:task:start ')).toThrow();
  });

  it('accepts the event channel and rejects anything else', () => {
    expect(() => assertEventChannel('vyra:event')).not.toThrow();
    expect(() => assertEventChannel('vyra:task:start')).toThrow();
    expect(() => assertEventChannel('')).toThrow();
  });
});
