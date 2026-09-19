/**
 * Tool contracts — the single source of truth for every tool in VYRA.
 *
 * A Tool has a static definition (name, description, parameter schema) and
 * an executor. Every execution returns a structured ToolResult.
 * Tools NEVER display success when the underlying action failed.
 */
import type { AgentEvent } from './events.js';

/** JSON-schema-flavoured parameter declaration for a tool. */
export interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  default?: unknown;
  enum?: Array<string | number>;
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
}

export interface ToolDefinition {
  /** Unique snake_case name, e.g. "computer_click". */
  name: string;
  /** Human/agent-readable description of what the tool does. */
  description: string;
  /** Declared parameters. Executors MUST validate against this. */
  parameters: Record<string, ToolParameter>;
  /** True when the tool can change state outside VYRA (safety-relevant). */
  sideEffecting: boolean;
  /**
   * Safety classification consumed by the safety policy engine:
   * - "safe": read-only or trivially reversible (screenshot, read file)
   * - "normal": state-changing but low risk (move cursor, type into a field)
   * - "destructive": may lose data / be hard to reverse
   *   (delete files, destructive git ops, shutdown, publishing)
   */
  risk: 'safe' | 'normal' | 'destructive';
}

export interface ToolError {
  /** Stable machine-readable code, e.g. "ELEMENT_NOT_FOUND". */
  code: string;
  /** Honest human-readable message. */
  message: string;
  /** Whether an alternative strategy could plausibly succeed. */
  recoverable: boolean;
}

/**
 * The structured result every tool execution MUST return.
 * `ok` is true ONLY when the underlying action verifiably succeeded.
 */
export interface ToolResult<TData = unknown> {
  ok: boolean;
  data?: TData;
  error?: ToolError;
  /** Wall-clock duration of the execution. */
  durationMs: number;
  /** ISO-8601 timestamp of completion. */
  timestamp: string;
  taskId?: string;
  /** Optional hint for the recovery engine, e.g. "re-observe then retry". */
  recoveryHint?: string;
}

/** Context handed to every tool execution. */
export interface ToolContext {
  taskId?: string;
  /** Aborted when the task is cancelled. Tools must respect it. */
  signal: AbortSignal;
  /** Emit activity/log events into the live feed. */
  emit: (event: Omit<AgentEvent, 'timestamp'>) => void;
  /** Milliseconds budget remaining for this call (best effort). */
  timeoutMs: number;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

/** A registered tool: definition + implementation. */
export interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}

/** Result of validating raw args against a ToolDefinition. */
export interface ArgsValidation {
  valid: boolean;
  errors: string[];
  /** Args with defaults applied and unknown keys stripped. */
  normalized?: Record<string, unknown>;
}

/**
 * Validate raw arguments against a tool definition.
 * Shared helper used by the registry, the Brain and the unit tests.
 */
export function validateToolArgs(
  definition: ToolDefinition,
  raw: Record<string, unknown>,
): ArgsValidation {
  const errors: string[] = [];
  const normalized: Record<string, unknown> = {};

  for (const [key, param] of Object.entries(definition.parameters)) {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (param.required) errors.push(`Missing required parameter: ${key}`);
      else if (param.default !== undefined) normalized[key] = param.default;
      continue;
    }
    const actual = Array.isArray(value) ? 'array' : typeof value;
    const expected = param.type === 'integer' ? 'number' : param.type;
    if (actual !== expected) {
      errors.push(
        `Parameter "${key}" expected ${param.type} but got ${actual}`,
      );
      continue;
    }
    if (param.type === 'integer' && !Number.isInteger(value)) {
      errors.push(`Parameter "${key}" expected an integer`);
      continue;
    }
    if (param.enum && !(param.enum as unknown[]).includes(value as never)) {
      errors.push(
        `Parameter "${key}" must be one of: ${param.enum.join(', ')}`,
      );
      continue;
    }
    normalized[key] = value;
  }
  for (const key of Object.keys(raw)) {
    if (!(key in definition.parameters)) {
      errors.push(`Unknown parameter: ${key}`);
    }
  }
  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true, errors: [], normalized };
}

/** Convenience: build a successful ToolResult. */
export function toolOk<TData>(
  data: TData,
  durationMs: number,
  extra?: Partial<ToolResult<TData>>,
): ToolResult<TData> {
  return {
    ok: true,
    data,
    durationMs,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

/** Convenience: build a failed ToolResult. Never report success on failure. */
export function toolFail(
  code: string,
  message: string,
  durationMs: number,
  opts?: { recoverable?: boolean; recoveryHint?: string; taskId?: string },
): ToolResult {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: opts?.recoverable ?? true,
    },
    durationMs,
    timestamp: new Date().toISOString(),
    recoveryHint: opts?.recoveryHint,
    taskId: opts?.taskId,
  };
}
