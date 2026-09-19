/**
 * TaskEngine — owns the lifecycle of VYRA tasks.
 *
 * Responsibilities:
 *  - create / get / list / cancel tasks, persisted through a TaskStore,
 *  - enforce status transitions ONLY via canTransition() from @vyra/shared,
 *  - run the execution loop: plan → run steps → verify → recover → complete,
 *  - on construction, move any task found in a mid-flight status
 *    (RUNNING / PLANNING / VERIFYING / RECOVERING) back to QUEUED with an
 *    honest error note — never silently resumed mid-step,
 *  - emit task.created / task.status / task.step.start / task.step.end and
 *    product-language activity events through a subscribe/emit bus.
 *
 * The engine never invents plans or verification outcomes: planning and
 * step verification are injectable hooks (the Brain wires them up).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  TERMINAL_STATUSES,
  TaskStatus,
  activity,
  canTransition,
  createTask as newTask,
  toolFail,
  VYRA_PHRASES,
  type AgentEvent,
  type Task,
  type TaskStep,
  type ToolContext,
  type ToolResult,
} from '@vyra/shared';
import type { ToolRegistry } from './tool-registry.js';
import type {
  RecoveryContext,
  RecoveryEngineLike,
  RecoveryOutcome,
} from './recovery.js';

/* ------------------------------------------------------------------ */
/* TaskStore                                                            */
/* ------------------------------------------------------------------ */

/** Persistence boundary. The engine only talks to this interface. */
export interface TaskStore {
  save(task: Task): Promise<void>;
  load(id: string): Promise<Task | undefined>;
  list(): Promise<Task[]>;
  delete(id: string): Promise<void>;
}

/** Task ids become file names — only safe characters are allowed. */
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * JSON-file TaskStore. One file per task: <dataDir>/<taskId>.json.
 * The data dir is injected so tests can point it at a tmp directory.
 */
export class FileTaskStore implements TaskStore {
  constructor(private readonly dataDir: string) {}

  private pathFor(id: string): string {
    if (!TASK_ID_PATTERN.test(id)) {
      throw new Error(`FileTaskStore: refusing unsafe task id "${id}"`);
    }
    return path.join(this.dataDir, `${id}.json`);
  }

  async save(task: Task): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.pathFor(task.id), JSON.stringify(task, null, 2), 'utf8');
  }

  async load(id: string): Promise<Task | undefined> {
    try {
      const raw = await fs.readFile(this.pathFor(id), 'utf8');
      return JSON.parse(raw) as Task;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<Task[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dataDir);
    } catch {
      return [];
    }
    const tasks: Task[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(this.dataDir, entry), 'utf8');
        tasks.push(JSON.parse(raw) as Task);
      } catch {
        // Skip corrupt task files rather than failing the whole listing.
      }
    }
    tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return tasks;
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.pathFor(id), { force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Engine                                                               */
/* ------------------------------------------------------------------ */

export type TaskEventHandler = (event: AgentEvent) => void;

/** Produces the steps for a task. The Brain supplies this. */
export type TaskPlanner = (task: Task) => Promise<TaskStep[]>;

/** Decides whether a step's result satisfies its verify criterion. */
export type VerifyStepFn = (step: TaskStep, result: ToolResult) => Promise<boolean>;

export interface TaskEngineOptions {
  store: TaskStore;
  registry: ToolRegistry;
  planner?: TaskPlanner;
  verifyStep?: VerifyStepFn;
  recovery?: RecoveryEngineLike;
  onEvent?: TaskEventHandler;
  /** Best-effort per-tool-call budget handed to executors. */
  defaultTimeoutMs?: number;
}

export class TaskTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`Illegal task transition: ${from} → ${to}`);
    this.name = 'TaskTransitionError';
  }
}

export class TaskCancelledError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} was cancelled`);
    this.name = 'TaskCancelledError';
  }
}

export class UnknownTaskError extends Error {
  constructor(readonly taskId: string) {
    super(`Unknown task: "${taskId}"`);
    this.name = 'UnknownTaskError';
  }
}

/** Mid-flight statuses are never resumed — they go back to QUEUED. */
const STALE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.RUNNING,
  TaskStatus.PLANNING,
  TaskStatus.VERIFYING,
  TaskStatus.RECOVERING,
]);

export class TaskEngine {
  private readonly handlers = new Set<TaskEventHandler>();
  private readonly controllers = new Map<string, AbortController>();
  private planner?: TaskPlanner;
  private verifyStepFn: VerifyStepFn;
  private recovery?: RecoveryEngineLike;
  private readonly defaultTimeoutMs: number;

  /**
   * Resolves once stale-task recovery has finished. Prefer
   * TaskEngine.create(), which awaits it for you.
   */
  readonly ready: Promise<void>;

  constructor(private readonly opts: TaskEngineOptions) {
    this.planner = opts.planner;
    this.verifyStepFn = opts.verifyStep ?? (async () => true);
    this.recovery = opts.recovery;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    if (opts.onEvent) this.handlers.add(opts.onEvent);
    this.ready = this.recoverStaleTasks().catch(() => {
      // Recovery must never break construction; the store stays as-is.
    });
  }

  /** Construct + await stale-task recovery. */
  static async create(opts: TaskEngineOptions): Promise<TaskEngine> {
    const engine = new TaskEngine(opts);
    await engine.ready;
    return engine;
  }

  /* ---------------- event bus ---------------- */

  /** Subscribe to engine events. Returns an unsubscribe function. */
  on(handler: TaskEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Emit an event to all subscribers (timestamp added here, once). */
  emit(event: Omit<AgentEvent, 'timestamp'>): void {
    const full: AgentEvent = { ...event, timestamp: new Date().toISOString() };
    for (const handler of this.handlers) {
      try {
        handler(full);
      } catch {
        // A throwing listener must never break the engine.
      }
    }
  }

  private emitActivity(
    message: string,
    level: 'info' | 'success' | 'warning' | 'error' = 'info',
    detail?: string,
    taskId?: string,
  ): void {
    this.emit(activity(message, level, detail, taskId));
  }

  /* ---------------- hook wiring ---------------- */

  setPlanner(planner: TaskPlanner | undefined): void {
    this.planner = planner;
  }

  setVerifyStep(verifyStep: VerifyStepFn): void {
    this.verifyStepFn = verifyStep;
  }

  setRecovery(recovery: RecoveryEngineLike | undefined): void {
    this.recovery = recovery;
  }

  /* ---------------- CRUD ---------------- */

  async createTask(
    goal: string,
    opts?: { maxRetries?: number; context?: Record<string, unknown> },
  ): Promise<Task> {
    if (!goal || !goal.trim()) {
      throw new Error('TaskEngine.createTask: a non-empty goal is required');
    }
    // NOTE: `context` is free-form and may be persisted on the task.
    // Callers MUST NOT put secrets (passwords, API keys, tokens) in it.
    const task = newTask(goal, opts);
    await this.persist(task);
    this.emit({ type: 'task.created', taskId: task.id, payload: { task } });
    return task;
  }

  async get(taskId: string): Promise<Task | undefined> {
    return this.opts.store.load(taskId);
  }

  async list(opts?: { limit?: number; includeTerminal?: boolean }): Promise<Task[]> {
    let tasks = await this.opts.store.list();
    if (!opts?.includeTerminal) {
      tasks = tasks.filter((t) => !TERMINAL_STATUSES.has(t.status));
    }
    if (opts?.limit !== undefined) {
      tasks = tasks.slice(0, Math.max(0, opts.limit));
    }
    return tasks;
  }

  /**
   * Move a task to a new status. The transition MUST be legal per
   * canTransition() — anything else throws TaskTransitionError.
   */
  async setStatus(taskId: string, to: TaskStatus): Promise<Task> {
    const task = await this.requireTask(taskId);
    await this.transition(task, to);
    return task;
  }

  /** Cancel a task: aborts in-flight tool calls and moves to CANCELLED. */
  async cancel(taskId: string): Promise<Task> {
    const task = await this.requireTask(taskId);
    if (TERMINAL_STATUSES.has(task.status)) {
      throw new TaskTransitionError(task.status, TaskStatus.CANCELLED);
    }
    this.controllers.get(taskId)?.abort();
    await this.transition(task, TaskStatus.CANCELLED);
    this.emitActivity(VYRA_PHRASES.interrupted, 'warning', undefined, taskId);
    return task;
  }

  /* ---------------- execution ---------------- */

  /**
   * Run a QUEUED task through plan → execute → verify → complete.
   * Resolves with the terminal task. Rejects on illegal start state or
   * unknown task id.
   */
  async start(taskId: string): Promise<Task> {
    const task = await this.requireTask(taskId);
    if (task.status !== TaskStatus.QUEUED) {
      throw new TaskTransitionError(task.status, TaskStatus.RUNNING);
    }
    if (this.controllers.has(taskId)) {
      throw new Error(`Task "${taskId}" is already running`);
    }
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    try {
      return await this.run(task, controller.signal);
    } finally {
      this.controllers.delete(taskId);
    }
  }

  private async run(task: Task, signal: AbortSignal): Promise<Task> {
    const taskId = task.id;
    const toolCtx = (): ToolContext => ({
      taskId,
      signal,
      emit: (event) => this.emit(event),
      timeoutMs: this.defaultTimeoutMs,
    });

    try {
      // ---- planning ----
      await this.transition(task, TaskStatus.PLANNING);
      if (task.steps.length === 0) {
        this.emitActivity(VYRA_PHRASES.planning, 'info', undefined, taskId);
        if (!this.planner) {
          return await this.fail(
            task,
            'NO_PLANNER',
            'No plan available: the task has no steps and no planner is configured. VYRA did not fabricate a plan.',
          );
        }
        let steps: TaskStep[];
        try {
          steps = await this.planner(task);
        } catch (err) {
          return await this.fail(
            task,
            'PLANNER_FAILED',
            `Planning failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this.throwIfCancelled(signal, taskId);
        if (!steps || steps.length === 0) {
          return await this.fail(task, 'EMPTY_PLAN', 'The planner returned no steps.');
        }
        task.steps = steps;
        task.currentStepIndex = 0;
        await this.persist(task);
      }

      // ---- execution ----
      this.throwIfCancelled(signal, taskId);
      await this.transition(task, TaskStatus.RUNNING);
      this.emitActivity(VYRA_PHRASES.working, 'info', undefined, taskId);

      for (let i = task.currentStepIndex; i < task.steps.length; i++) {
        task.currentStepIndex = i;
        const step = task.steps[i];
        if (!step) continue;
        const stepOk = await this.runStep(task, step, signal, toolCtx());
        if (!stepOk) {
          return task; // runStep already moved the task to FAILED
        }
      }

      await this.transition(task, TaskStatus.COMPLETED);
      this.emitActivity(VYRA_PHRASES.completed, 'success', undefined, taskId);
      await this.persist(task);
      return task;
    } catch (err) {
      if (err instanceof TaskCancelledError || signal.aborted) {
        const fresh = await this.requireTask(taskId);
        if (!TERMINAL_STATUSES.has(fresh.status)) {
          await this.transition(fresh, TaskStatus.CANCELLED);
          this.emitActivity(VYRA_PHRASES.interrupted, 'warning', undefined, taskId);
        }
        return fresh;
      }
      throw err;
    }
  }

  private async runStep(
    task: Task,
    step: TaskStep,
    signal: AbortSignal,
    ctx: ToolContext,
  ): Promise<boolean> {
    const taskId = task.id;

    if (!step.tool) {
      await this.fail(
        task,
        'NO_TOOL',
        `Step "${step.label}" names no tool. The engine cannot execute pure-reasoning steps, so the task cannot continue.`,
        step.id,
      );
      return false;
    }

    step.status = 'RUNNING';
    step.startedAt = new Date().toISOString();
    step.attempts = 0;
    await this.persist(task);
    this.emit({ type: 'task.step.start', taskId, payload: { step: { ...step } } });

    const maxAttempts = Math.max(1, step.maxAttempts || 1);
    let lastResult: ToolResult | undefined;
    let verified = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.throwIfCancelled(signal, taskId);
      step.attempts = attempt;
      lastResult = await this.opts.registry.execute(step.tool, step.args ?? {}, ctx);
      step.lastResult = lastResult;
      await this.persist(task);

      if (!lastResult.ok) {
        // Non-recoverable, or plain attempts exhausted → recovery decides.
        if (lastResult.error?.recoverable === false || attempt >= maxAttempts) break;
        continue;
      }

      if (step.verify) {
        await this.transition(task, TaskStatus.VERIFYING);
        this.emitActivity(VYRA_PHRASES.verifying, 'info', step.label, taskId);
        try {
          verified = await this.verifyStepFn(step, lastResult);
        } catch (err) {
          verified = false;
          task.errors.push({
            timestamp: new Date().toISOString(),
            stepId: step.id,
            code: 'VERIFY_ERROR',
            message: `Verification threw: ${err instanceof Error ? err.message : String(err)}`,
            recoveryAttempted: false,
          });
        }
        await this.transition(task, TaskStatus.RUNNING);
        if (verified) break;
        lastResult = toolFail(
          'VERIFY_FAILED',
          `Verification failed for step "${step.label}": ${step.verify}`,
          lastResult.durationMs,
          { taskId },
        );
        step.lastResult = lastResult;
        if (attempt >= maxAttempts) break;
        continue;
      }

      verified = true;
      break;
    }

    this.throwIfCancelled(signal, taskId);

    const succeeded = Boolean(lastResult?.ok) && (!step.verify || verified);
    if (succeeded) {
      return await this.finishStep(task, step, 'DONE');
    }

    // ---- recovery ----
    await this.transition(task, TaskStatus.RECOVERING);
    this.emitActivity(VYRA_PHRASES.recovering, 'warning', step.label, taskId);

    const recoveryCtx: RecoveryContext = {
      signal,
      execute: (tool, args) => this.opts.registry.execute(tool, args, ctx),
    };
    let outcome: RecoveryOutcome = {
      outcome: 'give_up',
      reason: 'No recovery engine is configured.',
    };
    if (this.recovery) {
      try {
        outcome = await this.recovery.onStepFailure(task, step, lastResult!, recoveryCtx);
      } catch (err) {
        outcome = {
          outcome: 'give_up',
          reason: `The recovery engine threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    this.throwIfCancelled(signal, taskId);

    if (outcome.outcome === 'recovered') {
      task.errors.push({
        timestamp: new Date().toISOString(),
        stepId: step.id,
        code: 'RECOVERED',
        message: outcome.note,
        recoveryAttempted: true,
      });
      await this.transition(task, TaskStatus.RUNNING);
      return await this.finishStep(task, step, 'DONE');
    }

    step.status = 'FAILED';
    step.finishedAt = new Date().toISOString();
    task.errors.push({
      timestamp: new Date().toISOString(),
      stepId: step.id,
      code: lastResult?.error?.code ?? 'STEP_FAILED',
      message: `Step "${step.label}" failed: ${outcome.reason}`,
      recoveryAttempted: true,
    });
    await this.transition(task, TaskStatus.FAILED);
    await this.persist(task);
    this.emit({ type: 'task.step.end', taskId, payload: { step: { ...step } } });
    this.emitActivity(
      'VYRA could not complete the task.',
      'error',
      outcome.reason,
      taskId,
    );
    return false;
  }

  private async finishStep(
    task: Task,
    step: TaskStep,
    status: 'DONE' | 'SKIPPED',
  ): Promise<boolean> {
    step.status = status;
    step.finishedAt = new Date().toISOString();
    await this.persist(task);
    this.emit({ type: 'task.step.end', taskId: task.id, payload: { step: { ...step } } });
    return true;
  }

  private async fail(task: Task, code: string, message: string, stepId?: string): Promise<Task> {
    task.errors.push({
      timestamp: new Date().toISOString(),
      stepId,
      code,
      message,
      recoveryAttempted: false,
    });
    await this.transition(task, TaskStatus.FAILED);
    await this.persist(task);
    this.emitActivity('VYRA could not complete the task.', 'error', message, task.id);
    return task;
  }

  /* ---------------- internals ---------------- */

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.opts.store.load(taskId);
    if (!task) throw new UnknownTaskError(taskId);
    return task;
  }

  private async persist(task: Task): Promise<void> {
    task.updatedAt = new Date().toISOString();
    await this.opts.store.save(task);
  }

  private async transition(task: Task, to: TaskStatus): Promise<void> {
    const from = task.status;
    if (from === to) return;
    if (!canTransition(from, to)) {
      throw new TaskTransitionError(from, to);
    }
    task.status = to;
    await this.persist(task);
    this.emit({ type: 'task.status', taskId: task.id, payload: { from, to } });
  }

  private throwIfCancelled(signal: AbortSignal, taskId: string): void {
    if (signal.aborted) throw new TaskCancelledError(taskId);
  }

  /**
   * Stale-task recovery: anything found mid-flight goes back to QUEUED
   * with an honest error note. Steps keep their PENDING/DONE state, so a
   * restarted task resumes from the next pending step — never mid-step.
   */
  private async recoverStaleTasks(): Promise<void> {
    const tasks = await this.opts.store.list();
    for (const task of tasks) {
      if (!STALE_STATUSES.has(task.status)) continue;
      const from = task.status;
      task.status = TaskStatus.QUEUED;
      task.errors.push({
        timestamp: new Date().toISOString(),
        code: 'STALE_STATE',
        message:
          `Task was ${from} when VYRA restarted. Moved back to QUEUED; ` +
          `it will resume from the next pending step, never mid-step.`,
        recoveryAttempted: false,
      });
      await this.persist(task);
      this.emit({
        type: 'task.status',
        taskId: task.id,
        payload: { from, to: TaskStatus.QUEUED },
      });
    }
  }
}
