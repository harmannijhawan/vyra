/**
 * @vyra/tools — git_status / git_diff / git_commit / git_branch / git_push.
 *
 * Thin, honest wrappers around the real git binary via child_process. Real
 * exit codes are surfaced; nothing is simulated. Destructive git operations
 * (reset --hard, clean -fd, ...) are deliberately NOT exposed as tools.
 */
import type { RegisteredTool, ToolContext, ToolDefinition } from '@vyra/shared';
import { resolve } from 'node:path';
import {
  runProcess,
  runTool,
  ToolRuntimeError,
  truncateText,
  type ProcessResult,
  type ToolBody,
} from './util.js';

const DIFF_MAX_CHARS = 20_000;

function define(definition: ToolDefinition, body: ToolBody): RegisteredTool {
  return { definition, execute: (args, ctx: ToolContext) => runTool(definition, args, ctx, body) };
}

function cwdOf(args: Record<string, unknown>): string {
  return resolve((args.cwd as string | undefined) ?? process.cwd());
}

/** Never let git hang on a credential prompt — fail fast and honestly instead. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
}

async function git(
  cwd: string,
  gitArgs: string[],
  ctx: ToolContext,
  timeoutMs = 60_000,
): Promise<ProcessResult> {
  try {
    return await runProcess('git', gitArgs, { cwd, timeoutMs, signal: ctx.signal, env: gitEnv() });
  } catch (err) {
    if (err instanceof ToolRuntimeError && err.code === 'SPAWN_FAILED') {
      throw new ToolRuntimeError('GIT_NOT_FOUND', `git executable not found: ${err.message}`, {
        recoverable: false,
      });
    }
    throw err;
  }
}

/** Throw a structured error for a failed git invocation; return stdout on success. */
function ensureGitOk(result: ProcessResult, action: string): string {
  if (result.timedOut) {
    throw new ToolRuntimeError('TIMEOUT', `git ${action} timed out and was killed.`, {
      recoverable: true,
    });
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    if (/not a git repository/i.test(detail)) {
      throw new ToolRuntimeError('GIT_NOT_A_REPO', `Not a git repository: ${detail}`, {
        recoverable: false,
      });
    }
    throw new ToolRuntimeError(
      'GIT_ERROR',
      `git ${action} failed (exit ${result.exitCode}): ${truncateText(detail, 2000).text}`,
      { recoverable: true },
    );
  }
  return result.stdout;
}

interface StatusInfo {
  repoRoot: string;
  branch: string;
  detached: boolean;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}

async function readStatus(cwd: string, ctx: ToolContext): Promise<StatusInfo> {
  const root = ensureGitOk(await git(cwd, ['rev-parse', '--show-toplevel'], ctx), 'rev-parse').trim();
  const porcelain = ensureGitOk(await git(root, ['status', '--porcelain=v1', '-b'], ctx), 'status');

  let branch = '';
  let detached = false;
  let ahead = 0;
  let behind = 0;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of porcelain.split('\n')) {
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      const m = head.match(/^(?:No commits yet on )?([^\s.]+)/);
      if (/^HEAD \(no branch/.test(head)) {
        branch = 'HEAD';
        detached = true;
      } else if (m) {
        branch = m[1];
      }
      const ab = head.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
      if (ab) {
        ahead = Number(ab[1] ?? 0);
        behind = Number(ab[2] ?? ab[3] ?? 0);
      }
      continue;
    }
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    const path = line.slice(3).replace(/^"(.+)"$/, '$1');
    if (x === '?' && y === '?') {
      untracked.push(path);
    } else {
      if (x !== ' ' && x !== '?') staged.push(path);
      if (y !== ' ' && y !== '?') unstaged.push(path);
    }
  }

  return {
    repoRoot: root,
    branch,
    detached,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
  };
}

export const gitTools: RegisteredTool[] = [
  define(
    {
      name: 'git_status',
      description: 'Show git working-tree status: branch, staged/unstaged/untracked files.',
      parameters: {
        cwd: { type: 'string', description: 'Repository directory (default: current working directory).' },
      },
      sideEffecting: false,
      risk: 'safe',
    },
    async (args, ctx) => readStatus(cwdOf(args), ctx),
  ),

  define(
    {
      name: 'git_diff',
      description: 'Show the diff of unstaged (or staged, with staged:true) changes, truncated to 20000 chars.',
      parameters: {
        cwd: { type: 'string', description: 'Repository directory (default: current working directory).' },
        staged: { type: 'boolean', description: 'Show staged changes (git diff --cached).', default: false },
        path: { type: 'string', description: 'Limit the diff to a single path.' },
      },
      sideEffecting: false,
      risk: 'safe',
    },
    async (args, ctx) => {
      const cwd = cwdOf(args);
      const staged = args.staged as boolean;
      const gitArgs = ['diff', '--no-color'];
      if (staged) gitArgs.push('--cached');
      gitArgs.push('--');
      if (args.path !== undefined) gitArgs.push(args.path as string);
      const out = ensureGitOk(await git(cwd, gitArgs, ctx), 'diff');
      const { text, truncated } = truncateText(out, DIFF_MAX_CHARS);
      return { diff: text, truncated, staged };
    },
  ),

  define(
    {
      name: 'git_commit',
      description:
        'Commit changes with a message. Optionally stages the given files first (git add). ' +
        'Refuses honestly when there is nothing to commit.',
      parameters: {
        cwd: { type: 'string', description: 'Repository directory (default: current working directory).' },
        message: { type: 'string', description: 'Commit message. Must not be empty.', required: true },
        files: {
          type: 'array',
          description: 'Files to stage before committing.',
          items: { type: 'string', description: 'A file path.' },
        },
        amend: { type: 'boolean', description: 'Amend the previous commit instead of creating a new one.', default: false },
      },
      sideEffecting: true,
      risk: 'normal',
    },
    async (args, ctx) => {
      const cwd = cwdOf(args);
      const message = args.message as string;
      if (message.trim().length === 0) {
        throw new ToolRuntimeError('INVALID_ARGS', 'message must not be empty.', { recoverable: false });
      }
      const amend = args.amend as boolean;
      const files = args.files as string[] | undefined;

      if (files && files.length > 0) {
        ensureGitOk(await git(cwd, ['add', '--', ...files], ctx), 'add');
      }

      const porcelain = ensureGitOk(await git(cwd, ['status', '--porcelain=v1'], ctx), 'status');
      if (porcelain.trim().length === 0 && !amend) {
        throw new ToolRuntimeError('NOTHING_TO_COMMIT', 'Nothing to commit — the working tree is clean.', {
          recoverable: true,
          recoveryHint: 'Make changes first, or pass files to stage them.',
        });
      }

      const commitArgs = ['commit', '-m', message];
      if (amend) commitArgs.push('--amend');
      ensureGitOk(await git(cwd, commitArgs, ctx), 'commit');
      const sha = ensureGitOk(await git(cwd, ['rev-parse', 'HEAD'], ctx), 'rev-parse').trim();
      return { sha, message, amended: amend };
    },
  ),

  define(
    {
      name: 'git_branch',
      description: 'List, create or checkout git branches.',
      parameters: {
        cwd: { type: 'string', description: 'Repository directory (default: current working directory).' },
        action: {
          type: 'string',
          description: 'Branch operation.',
          enum: ['list', 'create', 'checkout'],
          default: 'list',
        },
        name: { type: 'string', description: 'Branch name (required for create/checkout).' },
      },
      sideEffecting: true,
      risk: 'normal',
    },
    async (args, ctx) => {
      const cwd = cwdOf(args);
      const action = args.action as string;
      if (action === 'list') {
        const current =
          ensureGitOk(await git(cwd, ['branch', '--show-current'], ctx), 'branch').trim() || '(detached)';
        const out = ensureGitOk(await git(cwd, ['branch', '--format=%(refname:short)'], ctx), 'branch');
        const branches = out.split('\n').map((b) => b.trim()).filter(Boolean);
        return { branches, current };
      }
      const name = args.name as string | undefined;
      if (!name || name.trim().length === 0) {
        throw new ToolRuntimeError('INVALID_ARGS', `name is required for action "${action}".`, {
          recoverable: false,
        });
      }
      if (action === 'create') {
        ensureGitOk(await git(cwd, ['branch', name], ctx), 'branch');
        return { created: name };
      }
      // checkout
      ensureGitOk(await git(cwd, ['checkout', name], ctx), 'checkout');
      return { checkedOut: name };
    },
  ),

  define(
    {
      name: 'git_push',
      description: 'Push the current branch to a remote. Fails honestly when there is no remote or no upstream.',
      parameters: {
        cwd: { type: 'string', description: 'Repository directory (default: current working directory).' },
        remote: { type: 'string', description: 'Remote name.', default: 'origin' },
        branch: { type: 'string', description: 'Branch to push (default: current branch).' },
      },
      sideEffecting: true,
      risk: 'normal',
    },
    async (args, ctx) => {
      const cwd = cwdOf(args);
      const remote = args.remote as string;
      let branch = args.branch as string | undefined;
      if (!branch) {
        branch = ensureGitOk(await git(cwd, ['branch', '--show-current'], ctx), 'branch').trim();
        if (!branch) {
          throw new ToolRuntimeError(
            'INVALID_ARGS',
            'Cannot push: HEAD is detached and no branch was given.',
            { recoverable: false },
          );
        }
      }
      const out = ensureGitOk(await git(cwd, ['push', remote, branch], ctx, 120_000), 'push');
      return { pushed: true, remote, branch, output: truncateText(out.trim(), 2000).text };
    },
  ),
];
