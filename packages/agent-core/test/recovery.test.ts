/**
 * Tests for the RecoveryEngine. The tool registry holds fake executors
 * (mocking at the tool boundary only); timing uses small backoff values.
 */
import { describe, expect, it } from 'vitest';
import {
  createTask,
  toolFail,
  toolOk,
  VYRA_PHRASES,
  type AgentEvent,
  type TaskStep,
  type ToolContext,
} from '@vyra/shared';
import { RecoveryEngine } from '../src/recovery.js';
import { ToolRegistry } from '../src/tool-registry.js';

function makeCtx(signal?: AbortSignal): ToolContext {
  return {
    signal: signal ?? new AbortController().signal,
    emit: () => {},
    timeoutMs: 1000,
  };
}

function makeStep(tool: string, args: Record<string, unknown> = {}): TaskStep {
  return {
    id: 's1',
    label: 'Test step',
    tool,
    args,
    status: 'RUNNING',
    attempts: 1,
    maxAttempts: 2,
  };
}

function executorCtx(registry: ToolRegistry) {
  return {
    signal: new AbortController().signal,
    execute: (tool: string, args: Record<string, unknown>) =>
      registry.execute(tool, args, makeCtx()),
  };
}

describe('RecoveryEngine', () => {
  it('respects backoff timing and gives up after max attempts', async () => {
    const registry = new ToolRegistry();
    let calls = 0;
    registry.register(
      {
        name: 'flaky',
        description: 'Always fails with a timeout.',
        parameters: {},
        sideEffecting: false,
        risk: 'safe',
      },
      async () => {
        calls += 1;
        return toolFail('TIMEOUT', 'timed out', 1);
      },
    );
    const events: Array<Omit<AgentEvent, 'timestamp'>> = [];
    const recovery = new RecoveryEngine({
      registry,
      backoffBaseMs: 10,
      backoffFactor: 2,
      maxAttemptsPerStep: 3,
      onEvent: (e) => events.push(e),
    });

    const started = Date.now();
    const outcome = await recovery.onStepFailure(
      createTask('backoff test'),
      makeStep('flaky'),
      toolFail('TIMEOUT', 'timed out', 5),
      executorCtx(registry),
    );
    const elapsed = Date.now() - started;

    expect(outcome.outcome).toBe('give_up');
    if (outcome.outcome === 'give_up') {
      // The identical call was retried once, never a third time blindly
      // ('flaky' has no alternative tool mapping).
      expect(calls).toBe(1);
      expect(outcome.reason).toContain('twice');
    }
    // Sleeps: 10ms before the retry + 20ms before the give-up.
    expect(elapsed).toBeGreaterThanOrEqual(20);
    const activity = events.find((e) => e.type === 'activity');
    expect(activity?.payload).toMatchObject({ message: VYRA_PHRASES.recovering });
  });

  it('does not retry non-recoverable errors (e.g. PERMISSION_DENIED)', async () => {
    const registry = new ToolRegistry();
    let calls = 0;
    registry.register(
      {
        name: 'guarded',
        description: 'Always denied.',
        parameters: {},
        sideEffecting: true,
        risk: 'destructive',
      },
      async () => {
        calls += 1;
        return toolFail('PERMISSION_DENIED', 'access denied', 1, {
          recoverable: false,
        });
      },
    );
    const recovery = new RecoveryEngine({ registry, backoffBaseMs: 1 });

    const outcome = await recovery.onStepFailure(
      createTask('permission test'),
      makeStep('guarded'),
      toolFail('PERMISSION_DENIED', 'access denied', 5, { recoverable: false }),
      executorCtx(registry),
    );

    expect(outcome.outcome).toBe('give_up');
    expect(calls).toBe(0);
    if (outcome.outcome === 'give_up') {
      expect(outcome.reason).toContain('Not recoverable');
      expect(outcome.reason).toContain('PERMISSION_DENIED');
    }
  });

  it('switches to an alternative tool after two identical failures', async () => {
    const registry = new ToolRegistry();
    let browserCalls = 0;
    registry.register(
      {
        name: 'browser_click',
        description: 'Clicks a selector.',
        parameters: {
          selector: { type: 'string', description: 'CSS selector.', required: true },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async () => {
        browserCalls += 1;
        return toolFail('ELEMENT_NOT_FOUND', 'no such element', 1);
      },
    );
    let fallbackCalls = 0;
    registry.register(
      {
        name: 'computer_click',
        description: 'Clicks at coordinates.',
        parameters: {
          // Declared optional so the step's args validate for the fallback.
          selector: { type: 'string', description: 'Ignored.', required: false },
          x: { type: 'number', description: 'X.', required: false },
          y: { type: 'number', description: 'Y.', required: false },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async () => {
        fallbackCalls += 1;
        return toolOk({ clicked: true }, 1);
      },
    );
    const recovery = new RecoveryEngine({
      registry,
      backoffBaseMs: 1,
      backoffFactor: 1,
      maxAttemptsPerStep: 3,
    });

    const outcome = await recovery.onStepFailure(
      createTask('fallback test'),
      makeStep('browser_click', { selector: '#go' }),
      toolFail('ELEMENT_NOT_FOUND', 'no such element', 5),
      executorCtx(registry),
    );

    expect(outcome).toMatchObject({ outcome: 'recovered' });
    // One identical retry, then the alternative — never a third identical call.
    expect(browserCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    if (outcome.outcome === 'recovered') {
      expect(outcome.note).toContain('computer_click');
    }
  });

  it('stops recovery immediately when the signal aborts', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'slow',
        description: 'Always fails.',
        parameters: {},
        sideEffecting: false,
        risk: 'safe',
      },
      async () => toolFail('TIMEOUT', 'timed out', 1),
    );
    const recovery = new RecoveryEngine({
      registry,
      backoffBaseMs: 5000,
      maxAttemptsPerStep: 3,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const outcome = await recovery.onStepFailure(
      createTask('abort test'),
      makeStep('slow'),
      toolFail('TIMEOUT', 'timed out', 5),
      { signal: controller.signal, execute: (t, a) => registry.execute(t, a, makeCtx()) },
    );

    expect(outcome.outcome).toBe('give_up');
    if (outcome.outcome === 'give_up') {
      expect(outcome.reason).toContain('aborted');
    }
  });
});
