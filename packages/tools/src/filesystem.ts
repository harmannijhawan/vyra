/**
 * @vyra/tools — filesystem_read / filesystem_write / filesystem_edit / filesystem_delete.
 *
 * Structured file operations with honest errors (FILE_NOT_FOUND,
 * PERMISSION_DENIED, FILE_EXISTS, TEXT_NOT_FOUND, AMBIGUOUS_MATCH, ...).
 * filesystem_delete is classified "destructive"; the safety policy layer that
 * decides whether to ask the user lives elsewhere — this executor performs
 * the operation and reports the outcome truthfully.
 */
import type { RegisteredTool, ToolContext, ToolDefinition } from '@vyra/shared';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { errorMessage, fsErrorCode, runTool, ToolRuntimeError, type ToolBody } from './util.js';

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

function define(definition: ToolDefinition, body: ToolBody): RegisteredTool {
  return { definition, execute: (args, ctx: ToolContext) => runTool(definition, args, ctx, body) };
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolRuntimeError('INVALID_ARGS', `${name} must be a non-empty string.`, {
      recoverable: false,
    });
  }
  return value;
}

/** Run an fs body, mapping Node errors to stable tool error codes. */
async function withFsErrors<T>(path: string, op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ToolRuntimeError) throw err;
    throw new ToolRuntimeError(
      fsErrorCode(err),
      `Cannot ${op} "${path}": ${errorMessage(err)}`,
      { recoverable: true },
    );
  }
}

export const filesystemTools: RegisteredTool[] = [
  define(
    {
      name: 'filesystem_read',
      description: 'Read a text file as UTF-8. Refuses files larger than maxBytes instead of truncating silently.',
      parameters: {
        path: { type: 'string', description: 'File path to read.', required: true },
        maxBytes: {
          type: 'integer',
          description: 'Maximum file size in bytes to read (default 1048576).',
          default: DEFAULT_MAX_BYTES,
        },
      },
      sideEffecting: false,
      risk: 'safe',
    },
    async (args) => {
      const abs = resolve(nonEmpty(args.path, 'path'));
      const maxBytes = args.maxBytes as number;
      return withFsErrors(abs, 'read', async () => {
        const info = await stat(abs);
        if (info.isDirectory()) {
          throw new ToolRuntimeError('IS_DIRECTORY', `"${abs}" is a directory, not a file.`, {
            recoverable: false,
          });
        }
        if (info.size > maxBytes) {
          throw new ToolRuntimeError(
            'FILE_TOO_LARGE',
            `File is ${info.size} bytes, larger than maxBytes=${maxBytes}. Raise maxBytes or read a smaller file.`,
            { recoverable: true },
          );
        }
        const content = await readFile(abs, 'utf8');
        return { path: abs, content, bytes: info.size, truncated: false };
      });
    },
  ),

  define(
    {
      name: 'filesystem_write',
      description:
        'Write a text file (UTF-8), creating parent directories. Refuses to overwrite an existing file unless overwrite:true.',
      parameters: {
        path: { type: 'string', description: 'File path to write.', required: true },
        content: { type: 'string', description: 'File content.', required: true },
        overwrite: {
          type: 'boolean',
          description: 'Allow overwriting an existing file.',
          default: false,
        },
      },
      sideEffecting: true,
      risk: 'normal',
    },
    async (args) => {
      const abs = resolve(nonEmpty(args.path, 'path'));
      const content = args.content as string;
      const overwrite = args.overwrite as boolean;
      return withFsErrors(abs, 'write', async () => {
        await mkdir(dirname(abs), { recursive: true });
        // 'wx' fails atomically with EEXIST when the file exists and overwrite is false.
        await writeFile(abs, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
        return { path: abs, bytesWritten: Buffer.byteLength(content, 'utf8'), overwritten: overwrite };
      });
    },
  ),

  define(
    {
      name: 'filesystem_edit',
      description:
        'Replace the first exact occurrence of oldText with newText in a UTF-8 text file. ' +
        'Fails honestly when oldText is not found or matches more than once.',
      parameters: {
        path: { type: 'string', description: 'File path to edit.', required: true },
        oldText: { type: 'string', description: 'Exact text to replace (must occur exactly once).', required: true },
        newText: { type: 'string', description: 'Replacement text.', required: true },
      },
      sideEffecting: true,
      risk: 'normal',
    },
    async (args) => {
      const abs = resolve(nonEmpty(args.path, 'path'));
      const oldText = nonEmpty(args.oldText, 'oldText');
      const newText = args.newText as string;
      return withFsErrors(abs, 'edit', async () => {
        const content = await readFile(abs, 'utf8');
        const occurrences = content.split(oldText).length - 1;
        if (occurrences === 0) {
          throw new ToolRuntimeError('TEXT_NOT_FOUND', `oldText was not found in "${abs}".`, {
            recoverable: true,
            recoveryHint: 'Read the file first and copy oldText exactly.',
          });
        }
        if (occurrences > 1) {
          throw new ToolRuntimeError(
            'AMBIGUOUS_MATCH',
            `oldText matched ${occurrences} times in "${abs}". Provide more surrounding context to make it unique.`,
            { recoverable: true },
          );
        }
        await writeFile(abs, content.replace(oldText, newText), 'utf8');
        return { path: abs, replaced: true };
      });
    },
  ),

  define(
    {
      name: 'filesystem_delete',
      description:
        'Delete a file or directory (directories are removed recursively). Destructive and irreversible — the safety policy decides whether to confirm first.',
      parameters: {
        path: { type: 'string', description: 'File or directory path to delete.', required: true },
      },
      sideEffecting: true,
      risk: 'destructive',
    },
    async (args) => {
      const abs = resolve(nonEmpty(args.path, 'path'));
      return withFsErrors(abs, 'delete', async () => {
        const info = await stat(abs);
        await rm(abs, { recursive: true, force: false });
        return { path: abs, deleted: true, wasDirectory: info.isDirectory() };
      });
    },
  ),
];
