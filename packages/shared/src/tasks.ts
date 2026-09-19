/**
 * Task model contracts. The Task Engine persists these and the UI renders
 * them directly — statuses here are the only legal task states.
 */
import type { ToolResult } from './tools.js';

export enum TaskStatus {
  QUEUED = 'QUEUED',
  PLANNING = 'PLANNING',
  RUNNING = 'RUNNING',
  WAITING = 'WAITING',
  VERIFYING = 'VERIFYING',
  RECOVERING = 'RECOVERING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/** Terminal statuses — the engine never transitions out of these. */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
]);

/**
 * Legal transitions. The engine MUST reject anything not in this map.
 * WAITING = paused for user confirmation / input.
 * RECOVERING = a step failed and the recovery engine is trying alternatives.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  [TaskStatus.QUEUED]: new Set([TaskStatus.PLANNING, TaskStatus.CANCELLED]),
  [TaskStatus.PLANNING]: new Set([
    TaskStatus.RUNNING,
    TaskStatus.WAITING,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ]),
  [TaskStatus.RUNNING]: new Set([
    TaskStatus.VERIFYING,
    TaskStatus.WAITING,
    TaskStatus.RECOVERING,
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ]),
  [TaskStatus.VERIFYING]: new Set([
    TaskStatus.RUNNING,
    TaskStatus.RECOVERING,
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ]),
  [TaskStatus.RECOVERING]: new Set([
    TaskStatus.RUNNING,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ]),
  [TaskStatus.WAITING]: new Set([
    TaskStatus.RUNNING,
    TaskStatus.CANCELLED,
    TaskStatus.FAILED,
  ]),
  [TaskStatus.COMPLETED]: new Set(),
  [TaskStatus.FAILED]: new Set(),
  [TaskStatus.CANCELLED]: new Set(),
};

export type StepStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'VERIFYING'
  | 'DONE'
  | 'FAILED'
  | 'SKIPPED';

export interface TaskStep {
  id: string;
  /** Short label shown in the UI, e.g. "Open Chrome". */
  label: string;
  /** Tool to invoke, e.g. "computer_hotkey". Omitted for pure-reasoning steps. */
  tool?: string;
  args?: Record<string, unknown>;
  status: StepStatus;
  /** How this step's success is verified (description for the Brain). */
  verify?: string;
  attempts: number;
  maxAttempts: number;
  lastResult?: ToolResult;
  startedAt?: string;
  finishedAt?: string;
}

export interface TaskError {
  timestamp: string;
  stepId?: string;
  code: string;
  message: string;
  recoveryAttempted: boolean;
}

export interface Task {
  id: string;
  /** The user's original goal in their own words. */
  goal: string;
  status: TaskStatus;
  steps: TaskStep[];
  currentStepIndex: number;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  errors: TaskError[];
  /** Engine-level retries (distinct from per-step attempts). */
  retries: number;
  maxRetries: number;
  /** Set when the task is WAITING: what the engine needs from the user. */
  waitingFor?: string;
  /** Optional free-form context the Brain attached (never secrets). */
  context?: Record<string, unknown>;
}

/** Create a new task in QUEUED status. The engine assigns persistence. */
export function createTask(
  goal: string,
  opts?: { id?: string; maxRetries?: number; context?: Record<string, unknown> },
): Task {
  const now = new Date().toISOString();
  return {
    id: opts?.id ?? `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    goal,
    status: TaskStatus.QUEUED,
    steps: [],
    currentStepIndex: 0,
    createdAt: now,
    updatedAt: now,
    errors: [],
    retries: 0,
    maxRetries: opts?.maxRetries ?? 3,
    context: opts?.context,
  };
}

/** True when `to` is a legal transition from `from`. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.has(to) ?? false;
}
