/**
 * GitHub tool tests. The token must come from GITHUB_TOKEN only: without it,
 * every tool fails honestly with NO_GITHUB_TOKEN. Env is restored after each
 * test so the suite never leaks state.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { githubTools } from '../src/github.js';
import { execTool, makeCtx, getTool } from './helpers.js';

describe('github tools without GITHUB_TOKEN', () => {
  const saved = process.env.GITHUB_TOKEN;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = saved;
    }
  });

  it('github_issue create fails with NO_GITHUB_TOKEN', async () => {
    delete process.env.GITHUB_TOKEN;
    const res = await execTool(githubTools, 'github_issue', {
      action: 'create',
      owner: 'octocat',
      repo: 'hello-world',
      title: 'Test issue',
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('NO_GITHUB_TOKEN');
    expect(res.error?.message).toMatch(/GITHUB_TOKEN/);
  });

  it('github_repository create fails with NO_GITHUB_TOKEN', async () => {
    delete process.env.GITHUB_TOKEN;
    const res = await execTool(githubTools, 'github_repository', {
      action: 'create',
      name: 'vyra-test-repo',
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('NO_GITHUB_TOKEN');
  });

  it('github_pull_request list fails with NO_GITHUB_TOKEN', async () => {
    delete process.env.GITHUB_TOKEN;
    const res = await execTool(githubTools, 'github_pull_request', {
      action: 'list',
      owner: 'octocat',
      repo: 'hello-world',
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('NO_GITHUB_TOKEN');
  });

  it('an empty GITHUB_TOKEN is treated as missing', async () => {
    process.env.GITHUB_TOKEN = '';
    const res = await execTool(githubTools, 'github_issue', {
      action: 'list',
      owner: 'octocat',
      repo: 'hello-world',
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('NO_GITHUB_TOKEN');
  });

  it('never accepts a token as a tool argument', async () => {
    delete process.env.GITHUB_TOKEN;
    const tool = getTool(githubTools, 'github_issue');
    const res = await tool.execute(
      { action: 'list', owner: 'octocat', repo: 'hello-world', token: 'ghp_fake' },
      makeCtx(),
    );
    expect(res.ok).toBe(false);
    // Unknown parameter rejected by schema validation — no token is consumed.
    expect(res.error?.code).toBe('INVALID_ARGS');
  });
});
