/**
 * @vyra/tools — shared executor helpers.
 *
 * runTool() is the single funnel every tool executor runs through:
 *   validate args -> respect abort -> time the run -> honest ToolResult.
 * ok:true is returned ONLY when the underlying action verifiably succeeded.
 */
import {
  toolFail,
  toolOk,
  validateToolArgs,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '@vyra/shared';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Error thrown inside executors to produce a structured, honest ToolResult
 * with a stable machine-readable code.
 */
export class ToolRuntimeError extends Error {
  readonly code: string;
  readonly recoverable: boolean;
  readonly recoveryHint?: string;

  constructor(
    code: string,
    message: string,
    opts?: { recoverable?: boolean; recoveryHint?: string },
  ) {
    super(message);
    this.name = 'ToolRuntimeError';
    this.code = code;
    this.recoverable = opts?.recoverable ?? true;
    this.recoveryHint = opts?.recoveryHint;
  }
}

/** Human-readable message for anything thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ToolRuntimeError('ABORTED', 'Tool execution was aborted before it started.', {
      recoverable: true,
    });
  }
}

/**
 * Run start() unless signal is already aborted; reject with ABORTED if the
 * signal fires while the promise is pending. The underlying operation itself
 * is NOT cancelled by this helper — callers that can cancel (child processes,
 * fetch) must also observe the signal themselves.
 */
export function withAbort<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new ToolRuntimeError('ABORTED', 'Tool execution was aborted.', { recoverable: true }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    start().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export type ToolBody = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

/**
 * Standard executor wrapper: validates args against the definition, enforces
 * abort, times the run, and converts every failure into an honest ToolResult
 * (never fake success).
 */
export async function runTool(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  ctx: ToolContext,
  body: ToolBody,
): Promise<ToolResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  try {
    const validation = validateToolArgs(definition, args);
    if (!validation.valid) {
      throw new ToolRuntimeError('INVALID_ARGS', validation.errors.join('; '), {
        recoverable: false,
      });
    }
    const normalized = validation.normalized ?? {};
    const data = await withAbort(ctx.signal, () => body(normalized, ctx));
    return toolOk(data, elapsed(), { taskId: ctx.taskId });
  } catch (err) {
    if (err instanceof ToolRuntimeError) {
      return toolFail(err.code, err.message, elapsed(), {
        recoverable: err.recoverable,
        recoveryHint: err.recoveryHint,
        taskId: ctx.taskId,
      });
    }
    const aborted = ctx.signal.aborted;
    return toolFail(
      aborted ? 'ABORTED' : 'EXECUTION_FAILED',
      aborted ? 'Tool execution was aborted.' : errorMessage(err),
      elapsed(),
      { taskId: ctx.taskId },
    );
  }
}

/** Truncate long text for tool results; reports whether truncation happened. */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** Map Node fs error codes to stable tool error codes. */
export function fsErrorCode(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case 'ENOENT':
      return 'FILE_NOT_FOUND';
    case 'EACCES':
    case 'EPERM':
      return 'PERMISSION_DENIED';
    case 'EEXIST':
      return 'FILE_EXISTS';
    case 'EISDIR':
      return 'IS_DIRECTORY';
    case 'ENOTDIR':
      return 'NOT_A_DIRECTORY';
    case 'ENOTEMPTY':
      return 'DIRECTORY_NOT_EMPTY';
    default:
      return 'IO_ERROR';
  }
}

/* ------------------------------------------------------------------ */
/* Child processes                                                     */
/* ------------------------------------------------------------------ */

export interface ProcessResult {
  stdout: string;
  stderr: string;
  /** Null when the process was killed (timeout/abort) instead of exiting. */
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface RunProcessOptions {
  cwd?: string;
  /** Milliseconds before the whole process tree is killed. Default 30000. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Per-stream capture cap in bytes. Default 1 MiB. */
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Best-effort kill of the whole process tree. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.unref();
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* best effort */
    }
  }
}

/**
 * Run a process, capturing stdout/stderr with timeout + abort support.
 * Never throws for a non-zero exit — the exit code is part of the result.
 * Throws ToolRuntimeError only when the process could not be spawned at all.
 */
export function runProcess(
  file: string,
  args: string[],
  opts: RunProcessOptions = {},
): Promise<ProcessResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: opts.windowsHide ?? true,
        // Own process group on POSIX so killTree can signal the whole tree.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      reject(
        new ToolRuntimeError('SPAWN_FAILED', `Could not start "${file}": ${errorMessage(err)}`, {
          recoverable: true,
        }),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let truncated = false;
    let settled = false;

    const decode = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf8');

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish({ stdout: decode(stdoutChunks), stderr: decode(stderrChunks), exitCode: null, timedOut: true, truncated });
    }, timeoutMs);

    const onAbort = () => {
      killTree(child);
      finish({ stdout: decode(stdoutChunks), stderr: decode(stderrChunks), exitCode: null, timedOut: false, truncated });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const pushCapped = (
      chunks: Buffer[],
      counter: { bytes: number },
      data: Buffer,
    ): void => {
      if (counter.bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - counter.bytes;
      chunks.push(data.subarray(0, room));
      counter.bytes += Math.min(room, data.length);
      if (data.length > room) truncated = true;
    };
    const outCounter = { bytes: 0 };
    const errCounter = { bytes: 0 };

    child.stdout?.on('data', (data: Buffer) => pushCapped(stdoutChunks, outCounter, data));
    child.stderr?.on('data', (data: Buffer) => pushCapped(stderrChunks, errCounter, data));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(
        new ToolRuntimeError('SPAWN_FAILED', `Could not start "${file}": ${errorMessage(err)}`, {
          recoverable: true,
        }),
      );
    });

    child.on('close', (code) => {
      finish({
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks),
        exitCode: code,
        timedOut: false,
        truncated,
      });
    });
  });
}
