/**
 * Tests for ToolRegistry — mocking stops at the executor boundary:
 * executors are real async functions, only the underlying side effects
 * are faked.
 */
import { describe, expect, it } from 'vitest';
import {
  toolOk,
  type AgentEvent,
  type ToolContext,
  type ToolDefinition,
} from '@vyra/shared';
import { ToolRegistry } from '../src/tool-registry.js';

const echoDef: ToolDefinition = {
  name: 'echo',
  description: 'Echoes text back.',
  parameters: {
    text: { type: 'string', description: 'Text to echo.', required: true },
  },
  sideEffecting: false,
  risk: 'safe',
};

function makeCtx(
  events: Array<Omit<AgentEvent, 'timestamp'>> = [],
): ToolContext {
  return {
    signal: new AbortController().signal,
    emit: (event) => {
      events.push(event);
    },
    timeoutMs: 1000,
  };
}

describe('ToolRegistry', () => {
  it('rejects unknown tools with a structured failure', async () => {
    const registry = new ToolRegistry();
    const events: Array<Omit<AgentEvent, 'timestamp'>> = [];

    const result = await registry.execute('nope', {}, makeCtx(events));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_TOOL');
    expect(result.error?.message).toContain('nope');
    expect(typeof result.durationMs).toBe('number');
    expect(typeof result.timestamp).toBe('string');
    expect(events.map((e) => e.type)).toEqual(['tool.call', 'tool.result']);
  });

  it('rejects invalid args with a structured failure listing every error', async () => {
    const registry = new ToolRegistry();
    registry.register(echoDef, async (args) => toolOk({ echoed: args['text'] }, 0));

    const result = await registry.execute('echo', { bogus: 1 }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGUMENTS');
    expect(result.error?.message).toContain('Missing required parameter: text');
    expect(result.error?.message).toContain('Unknown parameter: bogus');
  });

  it('executes successfully, measures durationMs and emits events', async () => {
    const registry = new ToolRegistry();
    registry.register(echoDef, async (args) => toolOk({ echoed: args['text'] }, 0));
    const events: Array<Omit<AgentEvent, 'timestamp'>> = [];

    const result = await registry.execute('echo', { text: 'hi' }, makeCtx(events));

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ echoed: 'hi' });
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.timestamp).toBe('string');

    const call = events.find((e) => e.type === 'tool.call');
    const res = events.find((e) => e.type === 'tool.result');
    expect(call?.payload).toMatchObject({ tool: 'echo', args: { text: 'hi' } });
    expect(res?.payload).toMatchObject({ tool: 'echo', ok: true });
    expect((res?.payload as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('converts an executor throw into a structured failure (never throws)', async () => {
    const registry = new ToolRegistry();
    registry.register(echoDef, async () => {
      throw new Error('boom');
    });

    const result = await registry.execute('echo', { text: 'hi' }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('EXECUTOR_THROWN');
    expect(result.error?.message).toContain('boom');
  });

  it('supports unregister (used by tests)', () => {
    const registry = new ToolRegistry();
    registry.register(echoDef, async (args) => toolOk(args, 0));
    expect(registry.has('echo')).toBe(true);
    expect(registry.unregister('echo')).toBe(true);
    expect(registry.get('echo')).toBeUndefined();
    expect(registry.unregister('echo')).toBe(false);
  });
});
