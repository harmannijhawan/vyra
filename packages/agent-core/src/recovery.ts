/**
 * RecoveryEngine — what VYRA does when a step fails.
 *
 * Strategy, in order:
 *  1. Never retry what cannot recover (permission/auth errors, invalid
 *     arguments, unknown tools, or the tool's own recoverable === false).
 *  2. Re-observe (screenshot + vision) when the failure is
 *     ELEMENT_NOT_FOUND, so the next attempt works from fresh state.
 *  3. Retry with exponential backoff (base 500ms, factor 2, max 3 attempts
 *     per step by default).
 *  4. Never blindly repeat the identical failing call more than twice —
 *     after that, try an alternative tool from the mapping table, or
 *     escalate to FAILED with an honest error.
 *
 * Respects AbortSignal throughout (cancellation during backoff sleeps
 * ends recovery immediately).
 */
import {
  VYRA_PHRASES,
  activity,
  validateToolArgs,
  type AgentEvent,
  type Task,
  type TaskStep,
  type ToolResult,
} from '@vyra/shared';
import type { ToolRegistry } from './tool-registry.js';

export interface Observation {
  ok: boolean;
  description?: string;
  screenState?: string;
  reason?: string;
}

export interface RecoveryContext {
  signal: AbortSignal;
  execute: (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

export type RecoveryOutcome =
  | { outcome: 'recovered'; note: string }
  | { outcome: 'give_up'; reason: string };

/** Structural contract the TaskEngine depends on (keeps the import light). */
export interface RecoveryEngineLike {
  onStepFailure(
    task: Task,
    step: TaskStep,
    result: ToolResult,
    ctx: RecoveryContext,
  ): Promise<RecoveryOutcome>;
}

export interface RecoveryEngineOptions {
  registry: ToolRegistry;
  /** Re-observe the screen (screenshot + vision). The Brain wires this. */
  observe?: () => Promise<Observation | null>;
  onEvent?: (event: Omit<AgentEvent, 'timestamp'>) => void;
  backoffBaseMs?: number;
  backoffFactor?: number;
  maxAttemptsPerStep?: number;
}

/** Error codes that no amount of retrying will fix. */
const NON_RECOVERABLE_CODES = new Set([
  'PERMISSION_DENIED',
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'UNSUPPORTED',
  'INVALID_ARGUMENTS',
  'VALIDATION_FAILED',
  'UNKNOWN_TOOL',
  'NO_TOOL',
]);

/** The identical failing call is never repeated more than this many times. */
const MAX_IDENTICAL_REPEATS = 2;

/**
 * Fallback tool suggestions when the identical call keeps failing.
 * The first candidate that is registered and accepts the step's args wins.
 */
const ALTERNATIVE_TOOLS: Record<string, string[]> = {
  computer_click: ['computer_hotkey', 'computer_move'],
  computer_double_click: ['computer_click', 'computer_hotkey'],
  computer_type: ['computer_hotkey'],
  computer_drag: ['computer_move', 'computer_hotkey'],
  browser_click: ['computer_click', 'browser_press_key'],
  browser_type: ['computer_type', 'computer_hotkey'],
};

type FailureKind = 'element-not-found' | 'timeout' | 'auth' | 'other';

function classifyFailure(code: string | undefined): FailureKind {
  if (!code) return 'other';
  if (code === 'ELEMENT_NOT_FOUND') return 'element-not-found';
  if (code === 'TIMEOUT' || code === 'TIMED_OUT') return 'timeout';
  if (code === 'PERMISSION_DENIED' || code === 'AUTH_REQUIRED' || code === 'FORBIDDEN') {
    return 'auth';
  }
  return 'other';
}

class RecoveryAbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'RecoveryAbortedError';
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RecoveryAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new RecoveryAbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class RecoveryEngine implements RecoveryEngineLike {
  constructor(private readonly opts: RecoveryEngineOptions) {}

  private emit(event: Omit<AgentEvent, 'timestamp'>): void {
    this.opts.onEvent?.(event);
  }

  async onStepFailure(
    task: Task,
    step: TaskStep,
    result: ToolResult,
    ctx: RecoveryContext,
  ): Promise<RecoveryOutcome> {
    const code = result.error?.code ?? 'UNKNOWN';
    const kind = classifyFailure(result.error?.code);

    this.emit(
      activity(
        VYRA_PHRASES.recovering,
        'warning',
        `Step "${step.label}" failed (${code}): ${result.error?.message ?? 'no message'}`,
        task.id,
      ),
    );

    // 1. Never retry what cannot recover.
    if (
      result.error &&
      (NON_RECOVERABLE_CODES.has(code) || result.error.recoverable === false)
    ) {
      return {
        outcome: 'give_up',
        reason:
          `Not recoverable (${code}): ${result.error.message}. ` +
          `VYRA will not retry this step.`,
      };
    }

    // 2. Re-observe when the target element was not found, so any retry
    //    works from a fresh view of the screen.
    let observationNote = '';
    if (kind === 'element-not-found' && this.opts.observe) {
      try {
        const obs = await this.opts.observe();
        observationNote = obs?.ok
          ? ` Re-observation: ${obs.description ?? 'screen captured'} (screen state: ${obs.screenState ?? 'unknown'}).`
          : ` Re-observation unavailable: ${obs?.reason ?? 'no observer'}.`;
      } catch {
        observationNote = ' Re-observation failed.';
      }
    }
    const hint = result.recoveryHint ? ` Hint: ${result.recoveryHint}.` : '';

    // 3. Retry with exponential backoff.
    const base = this.opts.backoffBaseMs ?? 500;
    const factor = this.opts.backoffFactor ?? 2;
    const maxAttempts = Math.max(1, this.opts.maxAttemptsPerStep ?? 3);

    // The original failure counts as the first identical call.
    let identicalRepeats = 1;
    let lastResult = result;

    for (let attempt = 2; attempt <= maxAttempts; attempt++) {
      if (ctx.signal.aborted) {
        return { outcome: 'give_up', reason: 'Recovery aborted (task cancelled).' };
      }
      const delayMs = base * Math.pow(factor, attempt - 2);
      try {
        await sleep(delayMs, ctx.signal);
      } catch {
        return { outcome: 'give_up', reason: 'Recovery aborted (task cancelled).' };
      }

      // 4. After two identical failures, try an alternative tool instead
      //    of blindly repeating the same call a third time.
      if (identicalRepeats >= MAX_IDENTICAL_REPEATS) {
        const alternative = this.pickAlternative(step);
        if (!alternative) {
          return {
            outcome: 'give_up',
            reason:
              `The identical call failed twice and no alternative tool is available for "${step.tool}".${observationNote}${hint}`,
          };
        }
        const altResult = await ctx.execute(alternative.tool, alternative.args);
        if (altResult.ok) {
          return {
            outcome: 'recovered',
            note:
              `Recovered by switching from "${step.tool}" to "${alternative.tool}".${observationNote}`,
          };
        }
        return {
          outcome: 'give_up',
          reason:
            `Alternative tool "${alternative.tool}" also failed ` +
            `(${altResult.error?.code ?? 'UNKNOWN'}): ${altResult.error?.message ?? 'no message'}.${observationNote}`,
        };
      }

      const retryResult = await ctx.execute(step.tool ?? '', step.args ?? {});
      identicalRepeats += 1;
      if (retryResult.ok) {
        return {
          outcome: 'recovered',
          note: `Recovered on retry after ${delayMs}ms backoff.${observationNote}`,
        };
      }
      lastResult = retryResult;
      if (
        retryResult.error &&
        (NON_RECOVERABLE_CODES.has(retryResult.error.code) ||
          retryResult.error.recoverable === false)
      ) {
        return {
          outcome: 'give_up',
          reason:
            `Retry surfaced a non-recoverable error (${retryResult.error.code}): ` +
            `${retryResult.error.message}. VYRA will not retry further.`,
        };
      }
    }

    return {
      outcome: 'give_up',
      reason:
        `Still failing after ${maxAttempts} attempt(s) ` +
        `(last: ${lastResult.error?.code ?? 'UNKNOWN'}: ${lastResult.error?.message ?? 'no message'}).${observationNote}${hint}`,
    };
  }

  private pickAlternative(step: TaskStep): { tool: string; args: Record<string, unknown> } | undefined {
    const candidates = ALTERNATIVE_TOOLS[step.tool ?? ''] ?? [];
    for (const name of candidates) {
      if (name === step.tool) continue;
      const registered = this.opts.registry.get(name);
      if (!registered) continue;
      const validation = validateToolArgs(registered.definition, step.args ?? {});
      if (!validation.valid) continue;
      return { tool: name, args: validation.normalized ?? {} };
    }
    return undefined;
  }
}
