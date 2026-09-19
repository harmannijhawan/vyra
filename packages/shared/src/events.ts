/**
 * Event + observability contracts.
 *
 * The live activity feed, the terminal/log panel and the developer log
 * view all consume these. Events originate from the real Task Engine and
 * tool executions — never from hardcoded sequences.
 */
import type { TaskStatus, TaskStep } from './tasks.js';
import type { VoiceState } from './voice.js';

export type AgentEventType =
  | 'voice.state'
  | 'task.created'
  | 'task.status'
  | 'task.step.start'
  | 'task.step.end'
  | 'tool.call'
  | 'tool.result'
  | 'activity'
  | 'log'
  | 'computer.frame'
  | 'safety.confirm.request'
  | 'safety.confirm.response'
  | 'memory.event'
  | 'provider.status';

export interface AgentEvent<TPayload = unknown> {
  type: AgentEventType;
  /** ISO-8601 timestamp. */
  timestamp: string;
  taskId?: string;
  payload: TPayload;
}

/** One line in the live activity feed. Always generated from real events. */
export interface ActivityPayload {
  /** Display text, e.g. "VYRA is analyzing the screen." */
  message: string;
  /** Optional detail line. */
  detail?: string;
  level: 'info' | 'success' | 'warning' | 'error';
}

export interface TaskStatusPayload {
  from: TaskStatus;
  to: TaskStatus;
}

export interface TaskStepPayload {
  step: TaskStep;
}

export interface ToolCallPayload {
  tool: string;
  args: Record<string, unknown>;
  stepId?: string;
}

export interface ToolResultPayload {
  tool: string;
  ok: boolean;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface VoiceStatePayload {
  from: VoiceState;
  to: VoiceState;
}

export interface ComputerFramePayload {
  /** Data-URL (image/png) of the latest real screenshot, throttled. */
  dataUrl: string;
  width: number;
  height: number;
}

export interface SafetyConfirmRequestPayload {
  /** Stable id the UI answers with. */
  requestId: string;
  /** e.g. "Delete 14 files in C:\\Projects\\demo?" */
  question: string;
  tool: string;
  args: Record<string, unknown>;
  risk: 'destructive';
}

export interface SafetyConfirmResponsePayload {
  requestId: string;
  approved: boolean;
}

/**
 * Structured log record. The observability layer writes these as JSONL.
 * Secrets must be redacted before a record is created (see observability).
 */
export interface StructuredLog {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  taskId?: string;
  tool?: string;
  action: string;
  /** Short outcome summary — never raw secrets or file contents. */
  result?: string;
  durationMs?: number;
  error?: { code: string; message: string };
  component: string;
}

export function activity(
  message: string,
  level: ActivityPayload['level'] = 'info',
  detail?: string,
  taskId?: string,
): AgentEvent<ActivityPayload> {
  return {
    type: 'activity',
    timestamp: new Date().toISOString(),
    taskId,
    payload: { message, level, detail },
  };
}
