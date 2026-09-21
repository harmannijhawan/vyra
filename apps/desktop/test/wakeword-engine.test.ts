/**
 * Unit tests for apps/desktop/src/main/wakeword-engine.ts.
 *
 * The Python helper is never executed here: spawn() is faked and the
 * helper's stdout lines are fed in by hand. What IS real: model-file
 * resolution, the spawn fallback chain, JSON event parsing, and the
 * start/stop lifecycle.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

import {
  OpenWakeWordEngine,
  modelPathForPhrase,
  slugForPhrase,
} from '../src/main/wakeword-engine.js';

/** Fake ChildProcess: stdout/stderr are EventEmitters we drive by hand. */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => process.nextTick(resolve));
}

describe('wake-word engine (wakeword-engine.ts)', () => {
  let dir: string;
  let modelPath: string;
  let scriptPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyra-wake-test-'));
    modelPath = join(dir, 'vira.onnx');
    writeFileSync(modelPath, 'fake-model');
    scriptPath = join(dir, 'vyra_wakeword.py');
    writeFileSync(scriptPath, '# fake helper');
  });

  it('slugs phrases to model file names', () => {
    expect(slugForPhrase('Vira')).toBe('vira');
    expect(slugForPhrase('Hey Vyra')).toBe('hey-vyra');
    expect(modelPathForPhrase(dir, 'Vira')).toBe(modelPath);
    expect(() => slugForPhrase('   ')).toThrow(/must not be empty/);
  });

  it('refuses to start without a trained model — honestly naming the path', async () => {
    const missingDir = join(dir, 'does-not-exist');
    const engine = new OpenWakeWordEngine({
      modelsDir: missingDir,
      phrase: 'vira',
      scriptPathOverride: scriptPath,
      spawnImpl: (() => {
        throw new Error('should never spawn');
      }) as never,
    });
    await expect(engine.start(() => {})).rejects.toThrow(
      /No trained model for "vira" yet/,
    );
    await expect(engine.start(() => {})).rejects.toThrow(
      join(missingDir, 'vira.onnx'),
    );
  });

  it('fires onDetect on a wake line and onCommand on a command line', async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => {
      process.nextTick(() => child.emit('spawn'));
      return child;
    });
    const onDetect = vi.fn();
    const onCommand = vi.fn();
    const onEngineError = vi.fn();
    const engine = new OpenWakeWordEngine({
      modelsDir: dir,
      phrase: 'vira',
      scriptPathOverride: scriptPath,
      spawnImpl: spawnImpl as never,
      onCommand,
      onEngineError,
    });

    await engine.start(onDetect);
    expect(engine.isRunning()).toBe(true);
    expect(spawnImpl).toHaveBeenCalledTimes(1);

    child.stdout.emit(
      'data',
      Buffer.from(
        '{"event": "ready", "phrase": "vira"}\n' +
          'not json at all\n' +
          '{"event": "wake", "phrase": "vira", "score": 0.87}\n' +
          '{"event": "command", "text": "open google"}\n' +
          '{"event": "command-empty"}\n' +
          '{"event": "error", "message": "mic busy"}\n',
      ),
    );
    await nextTick();

    expect(onDetect).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenNthCalledWith(1, 'open google');
    expect(onCommand).toHaveBeenNthCalledWith(2, '');
    expect(onEngineError).toHaveBeenCalledWith('mic busy');

    // Idempotent: a second start() does not spawn again.
    await engine.start(onDetect);
    expect(spawnImpl).toHaveBeenCalledTimes(1);

    await engine.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(engine.isRunning()).toBe(false);
  });

  it('uses a configured Python interpreter directly (venv path)', async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
      process.nextTick(() => child.emit('spawn'));
      return child;
    });
    const engine = new OpenWakeWordEngine({
      modelsDir: dir,
      phrase: 'vira',
      scriptPathOverride: scriptPath,
      spawnImpl: spawnImpl as never,
      pythonPath: 'C:\\vyra-wakeword\\.venv\\Scripts\\python.exe',
    });
    await engine.start(() => {});
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl.mock.calls[0][0]).toBe(
      'C:\\vyra-wakeword\\.venv\\Scripts\\python.exe',
    );
    await engine.stop();
    expect(engine.isRunning()).toBe(false);
  });

  it('reports Python missing honestly after trying every candidate', async () => {
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild();
      process.nextTick(() => {
        const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        child.emit('error', err);
      });
      return child;
    });
    const engine = new OpenWakeWordEngine({
      modelsDir: dir,
      phrase: 'vira',
      scriptPathOverride: scriptPath,
      spawnImpl: spawnImpl as never,
    });
    await expect(engine.start(() => {})).rejects.toThrow(/Python 3 was not found/);
    // Windows tries `py -3` then `python`; elsewhere `python3` then `python`.
    expect(spawnImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces an unexpected helper exit with its stderr tail', async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => {
      process.nextTick(() => child.emit('spawn'));
      return child;
    });
    const onEngineError = vi.fn();
    const engine = new OpenWakeWordEngine({
      modelsDir: dir,
      phrase: 'vira',
      scriptPathOverride: scriptPath,
      spawnImpl: spawnImpl as never,
      onEngineError,
    });
    await engine.start(() => {});
    child.stderr.emit('data', Buffer.from('traceback: boom'));
    child.emit('exit', 1);
    await nextTick();
    expect(onEngineError).toHaveBeenCalledTimes(1);
    expect(onEngineError.mock.calls[0][0]).toMatch(/stopped unexpectedly.*boom/);
    expect(engine.isRunning()).toBe(false);
  });
});
