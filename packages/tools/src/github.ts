/**
 * @vyra/tools — github_repository / github_issue / github_pull_request.
 *
 * Real calls to https://api.github.com via fetch(). The token is read ONLY
 * from the GITHUB_TOKEN environment variable — it is never accepted as a
 * tool argument and never logged.
 */
import type { RegisteredTool, ToolContext, ToolDefinition } from '@vyra/shared';
import { errorMessage, runTool, ToolRuntimeError, truncateText, type ToolBody } from './util.js';

const API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 30_000;

function define(definition: ToolDefinition, body: ToolBody): RegisteredTool {
  return { definition, execute: (args, ctx: ToolContext) => runTool(definition, args, ctx, body) };
}

/** Read the token from the environment. Never from tool args, never logged. */
function githubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new ToolRuntimeError(
      'NO_GITHUB_TOKEN',
      'GITHUB_TOKEN is not set. Set the GITHUB_TOKEN environment variable to use GitHub tools.',
      { recoverable: false },
    );
  }
  return token;
}

interface GhRequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function gh(path: string, opts: GhRequestOptions = {}): Promise<unknown> {
  const token = githubToken();
  const method = opts.method ?? 'GET';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      data = { raw: text.slice(0, 2000) };
    }
    if (!res.ok) {
      const message =
        (data as { message?: string } | null)?.message ?? res.statusText ?? 'request failed';
      const code =
        res.status === 401 || res.status === 403
          ? 'GITHUB_AUTH_ERROR'
          : res.status === 404
            ? 'GITHUB_NOT_FOUND'
            : res.status === 422
              ? 'GITHUB_VALIDATION_ERROR'
              : 'GITHUB_API_ERROR';
      throw new ToolRuntimeError(code, `GitHub API ${method} ${path} failed: ${res.status} ${message}`, {
        recoverable: res.status === 429 || res.status >= 500,
        recoveryHint:
          res.status === 401 || res.status === 403
            ? 'Check that GITHUB_TOKEN is valid and has the required scopes.'
            : undefined,
      });
    }
    return data;
  } catch (err) {
    if (err instanceof ToolRuntimeError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ToolRuntimeError('TIMEOUT', `GitHub API request to ${path} timed out.`, {
        recoverable: true,
      });
    }
    throw new ToolRuntimeError('GITHUB_REQUEST_FAILED', `GitHub API request failed: ${errorMessage(err)}`, {
      recoverable: true,
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }
}

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolRuntimeError('INVALID_ARGS', `${name} must be a non-empty string.`, {
      recoverable: false,
    });
  }
  return value;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- GitHub JSON payloads */
function pickRepo(r: any): Record<string, unknown> {
  return {
    fullName: r.full_name,
    description: r.description ?? null,
    htmlUrl: r.html_url,
    private: r.private,
    defaultBranch: r.default_branch,
    stars: r.stargazers_count ?? 0,
    openIssues: r.open_issues_count ?? 0,
  };
}

function pickIssue(i: any): Record<string, unknown> {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    htmlUrl: i.html_url,
    author: i.user?.login ?? null,
    labels: Array.isArray(i.labels) ? i.labels.map((l: any) => l?.name ?? l) : [],
    comments: i.comments ?? 0,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    body: truncateText(String(i.body ?? ''), 5000).text,
  };
}

function pickPull(p: any): Record<string, unknown> {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    htmlUrl: p.html_url,
    author: p.user?.login ?? null,
    head: p.head?.ref ?? null,
    base: p.base?.ref ?? null,
    merged: p.merged ?? false,
    draft: p.draft ?? false,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    body: truncateText(String(p.body ?? ''), 5000).text,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const STATE_ENUM = ['open', 'closed', 'all'] as const;

export const githubTools: RegisteredTool[] = [
  define(
    {
      name: 'github_repository',
      description: 'Get info about a GitHub repository, or create a new one under the authenticated user.',
      parameters: {
        action: {
          type: 'string',
          description: 'Get an existing repository or create a new one.',
          enum: ['get', 'create'],
          default: 'get',
        },
        owner: { type: 'string', description: 'Repository owner (required for get).' },
        repo: { type: 'string', description: 'Repository name (required for get).' },
        name: { type: 'string', description: 'New repository name (required for create).' },
        description: { type: 'string', description: 'New repository description.' },
        private: { type: 'boolean', description: 'Whether the new repository is private.', default: true },
      },
      sideEffecting: true,
      risk: 'normal',
    },
    async (args, ctx) => {
      const action = args.action as string;
      if (action === 'get') {
        const owner = nonEmpty(args.owner, 'owner');
        const repo = nonEmpty(args.repo, 'repo');
        const data = await gh(repoPath(owner, repo), { signal: ctx.signal });
        return { repository: pickRepo(data) };
      }
      const name = nonEmpty(args.name, 'name');
      const data = await gh('/user/repos', {
        method: 'POST',
        body: {
          name,
          description: (args.description as string | undefined) ?? undefined,
          private: args.private as boolean,
        },
        signal: ctx.signal,
      });
      return { repository: pickRepo(data), created: true };
    },
  ),

  define(
    {
      name: 'github_issue',
      description: 'Get, create or list GitHub issues for a repository.',
      parameters: {
        action: {
          type: 'string',
          description: 'Issue operation.',
          enum: ['get', 'create', 'list'],
          default: 'list',
        },
        owner: { type: 'string', description: 'Repository owner.', required: true },
        repo: { type: 'string', description: 'Repository name.', required: true },
        number: { type: 'integer', description: 'Issue number (required for get).' },
        title: { type: 'string', description: 'Issue title (required for create).' },
        body: { type: 'string', description: 'Issue body (markdown).' },
        state: {
          type: 'string',
          description: 'Filter by state when listing.',
          enum: [...STATE_ENUM],
          default: 'open',
        },
        perPage: { type: 'integer', description: 'Results per page (1-100).', default: 30 },
      },
      sideEffecting: true,
      risk: 'normal',
    },
    async (args, ctx) => {
      const action = args.action as string;
      const owner = nonEmpty(args.owner, 'owner');
      const repo = nonEmpty(args.repo, 'repo');
      const base = repoPath(owner, repo);

      if (action === 'get') {
        const number = args.number as number | undefined;
        if (!Number.isInteger(number)) {
          throw new ToolRuntimeError('INVALID_ARGS', 'number is required for action "get".', {
            recoverable: false,
          });
        }
        const data = await gh(`${base}/issues/${number}`, { signal: ctx.signal });
        return { issue: pickIssue(data) };
      }
      if (action === 'create') {
        const title = nonEmpty(args.title, 'title');
        const data = await gh(`${base}/issues`, {
          method: 'POST',
          body: { title, body: (args.body as string | undefined) ?? undefined },
          signal: ctx.signal,
        });
        return { issue: pickIssue(data), created: true };
      }
      const perPage = args.perPage as number;
      if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
        throw new ToolRuntimeError('INVALID_ARGS', 'perPage must be an integer between 1 and 100.', {
          recoverable: false,
        });
      }
      const state = args.state as string;
      const data = (await gh(`${base}/issues?state=${state}&per_page=${perPage}`, {
        signal: ctx.signal,
      })) as unknown[];
      return { issues: data.map(pickIssue), count: data.length, state };
    },
  ),

  define(
    {
      name: 'github_pull_request',
      description: 'Get, create or list GitHub pull requests for a repository.',
      parameters: {
        action: {
          type: 'string',
          description: 'Pull request operation.',
          enum: ['get', 'create', 'list'],
          default: 'list',
        },
        owner: { type: 'string', description: 'Repository owner.', required: true },
        repo: { type: 'string', description: 'Repository name.', required: true },
        number: { type: 'integer', description: 'Pull request number (required for get).' },
        title: { type: 'string', description: 'PR title (required for create).' },
        head: { type: 'string', description: 'Source branch (required for create).' },
        base: { type: 'string', description: 'Target branch (required for create).' },
        body: { type: 'string', description: 'PR body (markdown).' },
        state: {
          type: 'string',
          description: 'Filter by state when listing.',
          enum: [...STATE_ENUM],
          default: 'open',
        },
        perPage: { type: 'integer', description: 'Results per page (1-100).', default: 30 },
      },
      sideEffecting: true,
      risk: 'normal',
    },
    async (args, ctx) => {
      const action = args.action as string;
      const owner = nonEmpty(args.owner, 'owner');
      const repo = nonEmpty(args.repo, 'repo');
      const base = repoPath(owner, repo);

      if (action === 'get') {
        const number = args.number as number | undefined;
        if (!Number.isInteger(number)) {
          throw new ToolRuntimeError('INVALID_ARGS', 'number is required for action "get".', {
            recoverable: false,
          });
        }
        const data = await gh(`${base}/pulls/${number}`, { signal: ctx.signal });
        return { pullRequest: pickPull(data) };
      }
      if (action === 'create') {
        const title = nonEmpty(args.title, 'title');
        const head = nonEmpty(args.head, 'head');
        const baseBranch = nonEmpty(args.base, 'base');
        const data = await gh(`${base}/pulls`, {
          method: 'POST',
          body: { title, head, base: baseBranch, body: (args.body as string | undefined) ?? undefined },
          signal: ctx.signal,
        });
        return { pullRequest: pickPull(data), created: true };
      }
      const perPage = args.perPage as number;
      if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
        throw new ToolRuntimeError('INVALID_ARGS', 'perPage must be an integer between 1 and 100.', {
          recoverable: false,
        });
      }
      const state = args.state as string;
      const data = (await gh(`${base}/pulls?state=${state}&per_page=${perPage}`, {
        signal: ctx.signal,
      })) as unknown[];
      return { pullRequests: data.map(pickPull), count: data.length, state };
    },
  ),
];
