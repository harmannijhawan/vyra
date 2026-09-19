/**
 * Tests for the Brain. The AI provider is faked (mocking at the provider
 * boundary only); the registry holds one real tool definition.
 */
import { describe, expect, it } from 'vitest';
import { toolOk, type AIProvider } from '@vyra/shared';
import { Brain, VYRA_SYSTEM_PROMPT } from '../src/brain.js';
import { ToolRegistry } from '../src/tool-registry.js';

const cannedPlan = JSON.stringify([
  {
    label: 'Open Run dialog',
    tool: 'computer_hotkey',
    args: { keys: ['meta', 'r'] },
    verify: 'The Run dialog is open',
    maxAttempts: 2,
  },
]);

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'computer_hotkey',
      description: 'Press a keyboard shortcut.',
      parameters: {
        keys: {
          type: 'array',
          description: 'Keys to press together.',
          required: true,
          items: { type: 'string', description: 'A key.' },
        },
      },
      sideEffecting: true,
      risk: 'normal',
    },
    async (args) => toolOk({ keys: args['keys'] }, 0),
  );
  return registry;
}

function makeFakeAI(opts: { available: boolean; reason?: string; text?: string }) {
  const state = { chatCalls: 0 };
  const provider: AIProvider = {
    id: 'fake-ai',
    displayName: 'Fake AI',
    checkAvailability: async () =>
      opts.available
        ? { available: true }
        : { available: false, reason: opts.reason ?? 'no API key configured' },
    chat: async () => {
      state.chatCalls += 1;
      return { text: opts.text ?? cannedPlan, toolCalls: [] };
    },
  };
  return { provider, state };
}

describe('Brain', () => {
  it('identifies as VYRA in its system prompt', () => {
    expect(VYRA_SYSTEM_PROMPT).toContain('VYRA');
    expect(VYRA_SYSTEM_PROMPT).not.toContain('JARVIS');
  });

  it('plan() produces validated steps from the AI response', async () => {
    const { provider, state } = makeFakeAI({ available: true });
    const brain = new Brain({ ai: provider, registry: makeRegistry() });

    const plan = await brain.plan('open the run dialog');

    expect(plan.ok).toBe(true);
    expect(plan.error).toBeUndefined();
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      label: 'Open Run dialog',
      tool: 'computer_hotkey',
      status: 'PENDING',
      verify: 'The Run dialog is open',
      maxAttempts: 2,
      attempts: 0,
    });
    expect(plan.steps[0]?.args).toEqual({ keys: ['meta', 'r'] });
    expect(state.chatCalls).toBe(1);
  });

  it('plan() fails honestly when the AI provider is unavailable', async () => {
    const { provider, state } = makeFakeAI({
      available: false,
      reason: 'missing API key',
    });
    const brain = new Brain({ ai: provider, registry: makeRegistry() });

    const plan = await brain.plan('do something impossible');

    expect(plan.ok).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.error).toContain('unavailable');
    expect(plan.error).toContain('missing API key');
    // Never fabricates: the AI was not even asked.
    expect(state.chatCalls).toBe(0);
  });

  it('plan() rejects a plan that uses an unknown tool', async () => {
    const { provider } = makeFakeAI({
      available: true,
      text: JSON.stringify([{ label: 'Bogus', tool: 'teleport' }]),
    });
    const brain = new Brain({ ai: provider, registry: makeRegistry() });

    const plan = await brain.plan('teleport somewhere');

    expect(plan.ok).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.error).toContain('unknown tool');
  });

  it('observe() honestly reports when no computer provider exists', async () => {
    const { provider } = makeFakeAI({ available: true });
    const brain = new Brain({ ai: provider, registry: makeRegistry() });

    const observation = await brain.observe();

    expect(observation.ok).toBe(false);
    expect(observation.reason).toContain('unavailable');
  });
});
