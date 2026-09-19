/**
 * Git tool tests: real round-trip against the real git binary in a temp repo.
 * Skipped gracefully when git is not installed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitTools } from '../src/git.js';
import { execTool } from './helpers.js';

const execFileAsync = promisify(execFile);

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = await gitAvailable();

describe.runIf(HAS_GIT)('git tools (real git round-trip)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vyra-git-'));
    await execFileAsync('git', ['init'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'vyra-test@example.com'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'vyra test'], { cwd: dir });
  });

  it('status on a fresh repo is clean', async () => {
    const res = await execTool(gitTools, 'git_status', { cwd: dir });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ clean: true, detached: false });
    expect(typeof (res.data as { branch: string }).branch).toBe('string');
  });

  it('status shows an untracked file', async () => {
    await writeFile(join(dir, 'hello.txt'), 'Hello\n', 'utf8');
    const res = await execTool(gitTools, 'git_status', { cwd: dir });
    expect(res.ok).toBe(true);
    const data = res.data as { untracked: string[]; clean: boolean };
    expect(data.untracked).toContain('hello.txt');
    expect(data.clean).toBe(false);
  });

  it('commit stages given files and returns a sha', async () => {
    const res = await execTool(gitTools, 'git_commit', {
      cwd: dir,
      message: 'initial commit',
      files: ['hello.txt'],
    });
    expect(res.ok).toBe(true);
    expect((res.data as { sha: string }).sha).toMatch(/^[0-9a-f]{40}$/);

    const status = await execTool(gitTools, 'git_status', { cwd: dir });
    expect((status.data as { clean: boolean }).clean).toBe(true);
  });

  it('commit refuses honestly when there is nothing to commit', async () => {
    const res = await execTool(gitTools, 'git_commit', { cwd: dir, message: 'empty' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('NOTHING_TO_COMMIT');
  });

  it('diff shows modified content, then commit clears it', async () => {
    await writeFile(join(dir, 'hello.txt'), 'Hello VYRA\n', 'utf8');
    const diff = await execTool(gitTools, 'git_diff', { cwd: dir });
    expect(diff.ok).toBe(true);
    expect((diff.data as { diff: string }).diff).toMatch(/VYRA/);

    const commit = await execTool(gitTools, 'git_commit', {
      cwd: dir,
      message: 'update greeting',
      files: ['hello.txt'],
    });
    expect(commit.ok).toBe(true);

    const diffAfter = await execTool(gitTools, 'git_diff', { cwd: dir });
    expect(diffAfter.ok).toBe(true);
    expect((diffAfter.data as { diff: string }).diff).toBe('');
  });

  it('branch create / list / checkout round-trip', async () => {
    const listBefore = await execTool(gitTools, 'git_branch', { cwd: dir, action: 'list' });
    const current = (listBefore.data as { current: string }).current;

    const created = await execTool(gitTools, 'git_branch', {
      cwd: dir,
      action: 'create',
      name: 'feature/x',
    });
    expect(created.ok).toBe(true);

    const list = await execTool(gitTools, 'git_branch', { cwd: dir, action: 'list' });
    expect((list.data as { branches: string[] }).branches).toContain('feature/x');

    const checkout = await execTool(gitTools, 'git_branch', {
      cwd: dir,
      action: 'checkout',
      name: 'feature/x',
    });
    expect(checkout.ok).toBe(true);

    const back = await execTool(gitTools, 'git_branch', {
      cwd: dir,
      action: 'checkout',
      name: current,
    });
    expect(back.ok).toBe(true);
  });

  it('push fails honestly without a remote', async () => {
    const res = await execTool(gitTools, 'git_push', { cwd: dir });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('GIT_ERROR');
    expect(res.error?.message).toMatch(/origin/);
  });
});

describe.runIf(!HAS_GIT)('git tools', () => {
  it('skips: git binary not found on this host', () => {
    expect(HAS_GIT).toBe(false);
  });
});
