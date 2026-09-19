/**
 * Tests for TaskEngine + FileTaskStore. The store points at a fresh tmp
 * dir per test; the registry uses fake executors (mocking at the tool
 * boundary only).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTask,
  TaskStatus,
  toolFail,
  toolOk,
  type AgentEvent,
  type TaskStep,
} from '@vyra/shared';
import {
  FileTaskStore,
  TaskEngine,
  TaskTransitionError,
} from '../src/task-engine.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { RecoveryEngine } from '../src/recovery.js';

let tmpDir: string;
let store: FileTaskStore;
let registry: ToolRegistry;

const echoStep: TaskStep = {
  id: 's1',
  label: 'Say hi',
  tool: 'echo',
  args: { text: 'hi' },
  status: 'PENDING',
  attempts: 0,
  maxAttempts: 2,
};

const flakyStep: TaskStep = {
  id: 's1',
  label: 'Flaky step',
  tool: 'flaky',
  args: {},
  status: 'PENDING',
  attempts: 0,
  maxAttempts: 1,
};

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'vyra-agent-core-'));
  store = new FileTaskStore(tmpDir);
  registry = new ToolRegistry();
  registry.register(
    {
      name: 'echo',
      description: 'Echoes text back.',
      parameters: {
        text: { type: 'string', description: 'Text.', required: true },
      },
      sideEffecting: false,
      risk: 'safe',
    },
    async (args) => toolOk({ echoed: args['text'] }, 0),
  );
  registry.register(
    {
      name: 'flaky',
      description: 'Always fails with a recoverable timeout.',
      parameters: {},
      sideEffecting: false,
      risk: 'safe',
    },
    async () => toolFail('TIMEOUT', 'timed out', 1),
  );
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('TaskEngine', () => {
  it('runs create → plan → run → complete (happy path)', async () => {
    const events: AgentEvent[] = [];
    const engine = await TaskEngine.create({
      store,
      registry,
      planner: async () => [{ ...echoStep }],
      onEvent: (e) => events.push(e),
    });

    const task = await engine.createTask('say hi');
    expect(task.status).toBe(TaskStatus.QUEUED);

    const final = await engine.start(task.id);

    expect(final.status).toBe(TaskStatus.COMPLETED);
    expect(final.steps[0]?.status).toBe('DONE');
    expect(final.steps[0]?.lastResult?.ok).toBe(true);

    const transitions = events
      .filter((e) => e.type === 'task.status')
      .map((e) => (e.payload as { to: TaskStatus }).to);
    expect(transitions).toEqual([
      TaskStatus.PLANNING,
      TaskStatus.RUNNING,
      TaskStatus.COMPLETED,
    ]);
    expect(events.some((e) => e.type === 'task.created')).toBe(true);
    expect(events.filter((e) => e.type === 'task.step.start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'task.step.end')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool.call')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool.result')).toHaveLength(1);
  });

  it('rejects illegal transitions (e.g. QUEUED → COMPLETED)', async () => {
    const engine = await TaskEngine.create({ store, registry });
    const task = await engine.createTask('do a thing');

    await expect(engine.setStatus(task.id, TaskStatus.COMPLETED)).rejects.toThrow(
      TaskTransitionError,
    );
    // The task is untouched by the rejected transition.
    expect((await engine.get(task.id))?.status).toBe(TaskStatus.QUEUED);

    // A legal transition still works.
    await expect(
      engine.setStatus(task.id, TaskStatus.PLANNING),
    ).resolves.toMatchObject({ status: TaskStatus.PLANNING });
  });

  it('cancels a running task', async () => {
    // Signal fired the moment the blocker tool actually starts, so the test
    // cancels a genuinely running task instead of racing a fixed sleep.
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    registry.register(
      {
        name: 'blocker',
        description: 'Blocks until aborted.',
        parameters: {},
        sideEffecting: false,
        risk: 'safe',
      },
      async (_args, ctx) => {
        markToolStarted();
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
        return toolOk({}, 0);
      },
    );
    const engine = await TaskEngine.create({
      store,
      registry,
      planner: async () => [
        { ...echoStep, id: 's-block', tool: 'blocker', args: {} },
      ],
    });
    const task = await engine.createTask('block for a bit');

    const runPromise = engine.start(task.id);
    await toolStarted;
    await engine.cancel(task.id);
    const final = await runPromise;

    expect(final.status).toBe(TaskStatus.CANCELLED);
  });

  it('marks the task FAILED when recovery gives up', async () => {
    const recovery = new RecoveryEngine({
      registry,
      backoffBaseMs: 1,
      backoffFactor: 1,
      maxAttemptsPerStep: 2,
    });
    const engine = await TaskEngine.create({
      store,
      registry,
      planner: async () => [{ ...flakyStep }],
      recovery,
    });
    const task = await engine.createTask('flaky work');

    const final = await engine.start(task.id);

    expect(final.status).toBe(TaskStatus.FAILED);
    expect(final.steps[0]?.status).toBe('FAILED');
    expect(final.errors.length).toBeGreaterThan(0);
    expect(final.errors.some((e) => e.recoveryAttempted)).toBe(true);
  });

  it('FileTaskStore round-trips a task in a tmp dir', async () => {
    const task = createTask('remember me');
    await store.save(task);

    const loaded = await store.load(task.id);
    expect(loaded).toEqual(task);

    const listed = await store.list();
    expect(listed.map((t) => t.id)).toContain(task.id);

    await store.delete(task.id);
    expect(await store.load(task.id)).toBeUndefined();
  });

  it('moves a stale RUNNING task back to QUEUED on construction', async () => {
    const stale = createTask('stale work');
    stale.status = TaskStatus.RUNNING;
    await store.save(stale);

    const engine = await TaskEngine.create({ store, registry });
    await engine.ready;

    const loaded = await engine.get(stale.id);
    expect(loaded?.status).toBe(TaskStatus.QUEUED);
    const note = loaded?.errors.find((e) => e.code === 'STALE_STATE');
    expect(note).toBeDefined();
    expect(note?.message).toContain('RUNNING');
    expect(note?.message).toContain('never mid-step');
  });

  it('lists tasks, excluding terminal ones by default', async () => {
    const engine = await TaskEngine.create({ store, registry });
    const a = await engine.createTask('first');
    const b = await engine.createTask('second');
    await engine.setStatus(b.id, TaskStatus.CANCELLED);

    const active = await engine.list();
    expect(active.map((t) => t.id)).toEqual(expect.arrayContaining([a.id]));
    expect(active.map((t) => t.id)).not.toContain(b.id);

    const all = await engine.list({ includeTerminal: true });
    expect(all.map((t) => t.id)).toEqual(expect.arrayContaining([a.id, b.id]));

    const limited = await engine.list({ includeTerminal: true, limit: 1 });
    expect(limited).toHaveLength(1);
  });
});
