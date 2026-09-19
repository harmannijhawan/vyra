/**
 * @vyra/tools — terminal_run.
 *
 * Executes a command in Windows PowerShell. On any other host the tool fails
 * honestly with UNSUPPORTED_PLATFORM — it never pretends to run.
 */
import type { RegisteredTool, ToolContext, ToolDefinition } from '@vyra/shared';
import { runProcess, runTool, ToolRuntimeError, truncateText } from './util.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 20_000;

const terminalRunDefinition: ToolDefinition = {
  name: 'terminal_run',
  description:
    'Run a command in Windows PowerShell and capture stdout, stderr and the exit code. ' +
    'Windows only — fails honestly on other hosts. ok:true means the command was executed and its ' +
    'output captured; check exitCode to see whether the command itself succeeded.',
  parameters: {
    command: { type: 'string', description: 'The command line to execute.', required: true },
    cwd: { type: 'string', description: 'Working directory for the command.' },
    timeoutMs: {
      type: 'integer',
      description: 'Timeout in milliseconds (default 30000, max 300000). The process tree is killed on timeout.',
      default: DEFAULT_TIMEOUT_MS,
    },
    shell: {
      type: 'string',
      description: 'Shell used to run the command.',
      enum: ['powershell', 'pwsh', 'cmd'],
      default: 'powershell',
    },
  },
  sideEffecting: true,
  risk: 'normal',
};

export const terminalTools: RegisteredTool[] = [
  {
    definition: terminalRunDefinition,
    execute: (args, ctx: ToolContext) =>
      runTool(terminalRunDefinition, args, ctx, async (a) => {
        if (process.platform !== 'win32') {
          throw new ToolRuntimeError(
            'UNSUPPORTED_PLATFORM',
            `terminal_run requires Windows PowerShell; this host is ${process.platform}.`,
            { recoverable: false },
          );
        }
        const command = a.command as string;
        if (command.trim().length === 0) {
          throw new ToolRuntimeError('INVALID_ARGS', 'command must not be empty.', {
            recoverable: false,
          });
        }
        const timeoutMs = a.timeoutMs as number;
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
          throw new ToolRuntimeError('INVALID_ARGS', 'timeoutMs must be a positive integer.', {
            recoverable: false,
          });
        }
        if (timeoutMs > MAX_TIMEOUT_MS) {
          throw new ToolRuntimeError('INVALID_ARGS', `timeoutMs must not exceed ${MAX_TIMEOUT_MS}.`, {
            recoverable: false,
          });
        }
        const shell = a.shell as string;
        const exe = shell === 'cmd' ? 'cmd.exe' : shell === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
        const shellArgs =
          shell === 'cmd'
            ? ['/d', '/s', '/c', command]
            : ['-NoProfile', '-NonInteractive', '-Command', command];

        const result = await runProcess(exe, shellArgs, {
          cwd: a.cwd as string | undefined,
          timeoutMs,
          signal: ctx.signal,
        });

        if (result.timedOut) {
          const partial = truncateText(
            `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
            2000,
          ).text;
          throw new ToolRuntimeError(
            'TIMEOUT',
            `Command timed out after ${timeoutMs} ms and its process tree was killed. Partial output:\n${partial}`,
            { recoverable: true, recoveryHint: 'Retry with a larger timeoutMs or a narrower command.' },
          );
        }

        const stdout = truncateText(result.stdout, MAX_OUTPUT_CHARS);
        const stderr = truncateText(result.stderr, MAX_OUTPUT_CHARS);
        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: result.exitCode,
          truncated: stdout.truncated || stderr.truncated || result.truncated,
        };
      }),
  },
];
