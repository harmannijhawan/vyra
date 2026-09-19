/**
 * SafetyPolicy tests — allow/confirm/deny classification, arg-based
 * denials, and fail-closed confirmation timeouts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@vyra/shared';
import { SafetyPolicy } from '../src/policy.js';

interface FakeDef {
  risk: string;
}

function makePolicy(
  opts?: { confirmTimeoutMs?: number; denyList?: string[] },
): { policy: SafetyPolicy; emitted: Array<Omit<AgentEvent, 'timestamp'>> } {
  const emitted: Array<Omit<AgentEvent, 'timestamp'>> = [];
  const definitions = new Map<string, FakeDef>([
    ['computer_screenshot', { risk: 'safe' }],
    ['computer_click', { risk: 'normal' }],
    ['computer_hotkey', { risk: 'normal' }],
    ['terminal_run', { risk: 'normal' }],
    ['filesystem_delete', { risk: 'destructive' }],
    ['filesystem_write', { risk: 'destructive' }],
  ]);
  const policy = new SafetyPolicy(
    definitions,
    (event) => {
      emitted.push(event);
    },
    opts,
  );
  return { policy, emitted };
}

describe('SafetyPolicy.evaluate', () => {
  it('allows safe tools', () => {
    const { policy } = makePolicy();
    expect(policy.evaluate('computer_screenshot', {})).toBe('allow');
  });

  it('allows normal-risk tools', () => {
    const { policy } = makePolicy();
    expect(policy.evaluate('computer_click', { x: 10, y: 20 })).toBe('allow');
  });

  it('allows Alt+F4 hotkey (normal risk, unknown context)', () => {
    const { policy } = makePolicy();
    expect(
      policy.evaluate('computer_hotkey', { keys: ['Alt', 'F4'] }),
    ).toBe('allow');
  });

  it('requires confirmation for destructive tools', () => {
    const { policy } = makePolicy();
    expect(
      policy.evaluate('filesystem_delete', { path: 'C:\\temp\\old.txt' }),
    ).toBe('confirm');
    expect(
      policy.evaluate('filesystem_write', { path: 'C:\\notes.txt' }),
    ).toBe('confirm');
  });

  it('denies unknown tools (fail closed)', () => {
    const { policy } = makePolicy();
    expect(policy.evaluate('mystery_tool', {})).toBe('deny');
  });

  it('denies tools on the deny list', () => {
    const { policy } = makePolicy({ denyList: ['terminal_run'] });
    expect(policy.evaluate('terminal_run', { command: 'echo hi' })).toBe(
      'deny',
    );
  });

  it('denies deleting system roots', () => {
    const { policy } = makePolicy();
    for (const path of [
      'C:\\Windows',
      'C:\\Windows\\System32',
      'C:\\',
      'C:/',
      '/',
      '/etc',
      '/etc/passwd',
    ]) {
      expect(
        policy.evaluate('filesystem_delete', { path }),
        `path ${path}`,
      ).toBe('deny');
    }
  });

  it('does not deny deleting an ordinary path', () => {
    const { policy } = makePolicy();
    expect(
      policy.evaluate('filesystem_delete', { path: 'C:\\Projects\\demo' }),
    ).toBe('confirm');
  });

  it('denies destructive shell commands', () => {
    const { policy } = makePolicy();
    for (const command of [
      'rm -rf / --no-preserve-root',
      'format C:',
      'shutdown /s /t 0',
      'mkfs.ext4 /dev/sda1',
    ]) {
      expect(
        policy.evaluate('terminal_run', { command }),
        `command ${command}`,
      ).toBe('deny');
    }
  });

  it('allows benign shell commands', () => {
    const { policy } = makePolicy();
    expect(policy.evaluate('terminal_run', { command: 'dir' })).toBe('allow');
  });
});

describe('SafetyPolicy.requestConfirmation', () => {
  it('emits a safety.confirm.request event and resolves on approval', async () => {
    const { policy, emitted } = makePolicy();
    const promise = policy.requestConfirmation(
      'filesystem_delete',
      { path: 'C:\\temp\\old.txt' },
      'Delete 1 file in C:\\temp?',
    );
    expect(emitted).toHaveLength(1);
    const event = emitted[0];
    expect(event.type).toBe('safety.confirm.request');
    const payload = event.payload as {
      requestId: string;
      question: string;
      tool: string;
      args: Record<string, unknown>;
      risk: string;
    };
    expect(payload.question).toBe('Delete 1 file in C:\\temp?');
    expect(payload.tool).toBe('filesystem_delete');
    expect(payload.args).toEqual({ path: 'C:\\temp\\old.txt' });
    expect(payload.risk).toBe('destructive');

    expect(policy.pendingCount()).toBe(1);
    expect(policy.handleResponse(payload.requestId, true)).toBe(true);
    await expect(promise).resolves.toBe(true);
    expect(policy.pendingCount()).toBe(0);
  });

  it('resolves false when the user rejects', async () => {
    const { policy, emitted } = makePolicy();
    const promise = policy.requestConfirmation('filesystem_delete', {});
    const payload = emitted[0].payload as { requestId: string };
    policy.handleResponse(payload.requestId, false);
    await expect(promise).resolves.toBe(false);
  });

  it('returns false for unknown request ids', () => {
    const { policy } = makePolicy();
    expect(policy.handleResponse('nope', true)).toBe(false);
  });

  it('times out to DENY (fail closed) with a short timeout', async () => {
    vi.useFakeTimers();
    try {
      const { policy, emitted } = makePolicy({ confirmTimeoutMs: 50 });
      const promise = policy.requestConfirmation('filesystem_delete', {});
      const payload = emitted[0].payload as { requestId: string };
      const assertion = expect(promise).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(policy.pendingCount()).toBe(0);
      // A late answer to a timed-out request is ignored.
      expect(policy.handleResponse(payload.requestId, true)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
