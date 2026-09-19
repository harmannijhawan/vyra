/**
 * Filesystem tool tests: real round-trips in a temp directory.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesystemTools } from '../src/filesystem.js';
import { execTool } from './helpers.js';

describe('filesystem tools (real round-trip)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vyra-fs-'));
  });

  it('write -> read round-trip', async () => {
    const p = join(dir, 'hello.txt');
    const written = await execTool(filesystemTools, 'filesystem_write', {
      path: p,
      content: 'hello',
    });
    expect(written.ok).toBe(true);
    expect(written.data).toMatchObject({ path: p, bytesWritten: 5 });

    const read = await execTool(filesystemTools, 'filesystem_read', { path: p });
    expect(read.ok).toBe(true);
    expect(read.data).toMatchObject({ path: p, content: 'hello', truncated: false });
  });

  it('write refuses to overwrite without overwrite:true', async () => {
    const p = join(dir, 'no-overwrite.txt');
    expect((await execTool(filesystemTools, 'filesystem_write', { path: p, content: 'one' })).ok).toBe(true);
    const again = await execTool(filesystemTools, 'filesystem_write', { path: p, content: 'two' });
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe('FILE_EXISTS');

    const overwrite = await execTool(filesystemTools, 'filesystem_write', {
      path: p,
      content: 'two',
      overwrite: true,
    });
    expect(overwrite.ok).toBe(true);
    const read = await execTool(filesystemTools, 'filesystem_read', { path: p });
    expect(read.data).toMatchObject({ content: 'two' });
  });

  it('write creates parent directories', async () => {
    const p = join(dir, 'nested', 'deep', 'file.txt');
    const res = await execTool(filesystemTools, 'filesystem_write', { path: p, content: 'deep' });
    expect(res.ok).toBe(true);
    const read = await execTool(filesystemTools, 'filesystem_read', { path: p });
    expect(read.data).toMatchObject({ content: 'deep' });
  });

  it('edit replaces text and the change is visible on read', async () => {
    const p = join(dir, 'edit.txt');
    await execTool(filesystemTools, 'filesystem_write', { path: p, content: 'hello world' });
    const edited = await execTool(filesystemTools, 'filesystem_edit', {
      path: p,
      oldText: 'world',
      newText: 'VYRA',
    });
    expect(edited.ok).toBe(true);
    const read = await execTool(filesystemTools, 'filesystem_read', { path: p });
    expect(read.data).toMatchObject({ content: 'hello VYRA' });
  });

  it('edit fails honestly when oldText is not found', async () => {
    const p = join(dir, 'edit-missing.txt');
    await execTool(filesystemTools, 'filesystem_write', { path: p, content: 'some content' });
    const res = await execTool(filesystemTools, 'filesystem_edit', {
      path: p,
      oldText: 'does not exist',
      newText: 'x',
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('TEXT_NOT_FOUND');
    // File untouched.
    const read = await execTool(filesystemTools, 'filesystem_read', { path: p });
    expect(read.data).toMatchObject({ content: 'some content' });
  });

  it('edit fails honestly when oldText matches multiple times', async () => {
    const p = join(dir, 'edit-ambiguous.txt');
    await execTool(filesystemTools, 'filesystem_write', { path: p, content: 'x\ny\nx\n' });
    const res = await execTool(filesystemTools, 'filesystem_edit', {
      path: p,
      oldText: 'x',
      newText: 'z',
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('AMBIGUOUS_MATCH');
    expect(res.error?.message).toMatch(/2 times/);
  });

  it('delete removes the file', async () => {
    const p = join(dir, 'delete-me.txt');
    await execTool(filesystemTools, 'filesystem_write', { path: p, content: 'bye' });
    const deleted = await execTool(filesystemTools, 'filesystem_delete', { path: p });
    expect(deleted.ok).toBe(true);
    expect(deleted.data).toMatchObject({ deleted: true, wasDirectory: false });
    const read = await execTool(filesystemTools, 'filesystem_read', { path: p });
    expect(read.ok).toBe(false);
    expect(read.error?.code).toBe('FILE_NOT_FOUND');
  });

  it('read of a missing file fails with FILE_NOT_FOUND', async () => {
    const res = await execTool(filesystemTools, 'filesystem_read', {
      path: join(dir, 'nope.txt'),
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('FILE_NOT_FOUND');
  });

  it('read of a directory fails honestly', async () => {
    const res = await execTool(filesystemTools, 'filesystem_read', { path: dir });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('IS_DIRECTORY');
  });

  it('read refuses files larger than maxBytes', async () => {
    const p = join(dir, 'big.txt');
    await execTool(filesystemTools, 'filesystem_write', { path: p, content: '0123456789' });
    const res = await execTool(filesystemTools, 'filesystem_read', { path: p, maxBytes: 4 });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('FILE_TOO_LARGE');
  });
});
