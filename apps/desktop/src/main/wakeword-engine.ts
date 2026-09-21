/**
 * OpenWakeWordEngine — a real WakeWordDetector for VYRA's main process.
 *
 * Detection itself runs in a small Python helper
 * (python/vyra_wakeword.py, shipped with the app) that samples the
 * microphone and runs an on-device openWakeWord model — fully offline, no
 * API key, no signup, no cloud. This class spawns that helper, watches its
 * JSON event lines on stdout, and translates them into detector callbacks.
 *
 * Honest failure modes (never silent):
 *  - no trained model file for the phrase  -> start() throws, naming the
 *    expected path and pointing at the wake-word setup guide
 *  - Python 3 missing                   -> start() throws, saying how to
 *    install it
 *  - helper exits unexpectedly          -> onEngineError with the helper's
 *    stderr tail
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { WakeWordDetector } from '@vyra/voice';

export interface WakeWordEngineCallbacks {
  /** A command was transcribed right after the wake word ('' when empty). */
  onCommand?: (text: string) => void;
  /** The listener failed; the message is safe to show the user. */
  onEngineError?: (message: string) => void;
}

export interface OpenWakeWordEngineOptions extends WakeWordEngineCallbacks {
  /** Directory holding "<phrase-slug>.onnx" model files. */
  modelsDir: string;
  /** Wake phrase the model was trained on. Default 'vira'. */
  phrase?: string;
  /** Detection threshold 0..1. Default 0.5. */
  threshold?: number;
  /**
   * Full path to a Python interpreter that has openwakeword installed
   * (e.g. a venv's python.exe). When set, it is used directly instead of
   * searching for a system Python.
   */
  pythonPath?: string;
  /** Test seams (not for production use). */
  spawnImpl?: typeof spawn;
  scriptPathOverride?: string;
  packagedOverride?: boolean;
}

/** "Vira" -> "vira"; "Hey Vyra" -> "hey-vyra". Throws on empty input. */
export function slugForPhrase(phrase: string): string {
  const slug = phrase
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new Error('[VYRA wake-word] Wake word must not be empty.');
  }
  return slug;
}

/** Where the trained model for a phrase must live. */
export function modelPathForPhrase(modelsDir: string, phrase: string): string {
  return path.join(modelsDir, `${slugForPhrase(phrase)}.onnx`);
}

function defaultScriptPath(packaged: boolean): string {
  if (packaged) {
    return path.join(process.resourcesPath, 'vyra-python', 'vyra_wakeword.py');
  }
  // Dev: apps/desktop/dist/main/<this file> -> apps/desktop/python/...
  return path.join(__dirname, '..', '..', 'python', 'vyra_wakeword.py');
}

const MAX_STDERR_TAIL = 4096;

export class OpenWakeWordEngine implements WakeWordDetector {
  readonly name = 'openwakeword';

  private readonly modelsDir: string;
  private threshold: number;
  private readonly spawnImpl: typeof spawn;
  private readonly scriptPath: string;
  private readonly callbacks: WakeWordEngineCallbacks;
  private pythonPath: string | undefined;

  private phrase: string;
  private child: ChildProcess | null = null;
  private onDetect: (() => void) | null = null;
  private stdoutBuffer = '';
  private stderrTail = '';
  private stopping = false;

  constructor(options: OpenWakeWordEngineOptions) {
    this.modelsDir = options.modelsDir;
    this.phrase = (options.phrase ?? 'vira').trim().toLowerCase() || 'vira';
    this.threshold = options.threshold ?? 0.5;
    this.pythonPath = options.pythonPath?.trim() || undefined;
    this.spawnImpl = options.spawnImpl ?? spawn;
    const packaged = options.packagedOverride ?? app.isPackaged;
    this.scriptPath =
      options.scriptPathOverride ?? defaultScriptPath(packaged);
    this.callbacks = {
      onCommand: options.onCommand,
      onEngineError: options.onEngineError,
    };
  }

  getPhrase(): string {
    return this.phrase;
  }

  setPhrase(phrase: string): void {
    const normalized = phrase.trim().toLowerCase();
    if (!normalized) {
      throw new Error('[VYRA wake-word] Wake word must not be empty.');
    }
    this.phrase = normalized;
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  /** Point the engine at a different Python interpreter (settings change). */
  setPythonPath(pythonPath: string | undefined): void {
    this.pythonPath = pythonPath?.trim() || undefined;
  }

  /** Detection threshold 0..1 (settings change; applies to the next start). */
  setThreshold(threshold: number): void {
    if (Number.isFinite(threshold) && threshold > 0 && threshold <= 1) {
      this.threshold = threshold;
    }
  }

  getThreshold(): number {
    return this.threshold;
  }

  async start(onDetect: () => void): Promise<void> {
    if (this.child) return; // idempotent

    const modelPath = modelPathForPhrase(this.modelsDir, this.phrase);
    if (!fs.existsSync(modelPath)) {
      throw new Error(
        `[VYRA wake-word] No trained model for "${this.phrase}" yet ` +
          `(expected ${modelPath}). Train your wake word first — ` +
          'see the VYRA wake-word setup guide.',
      );
    }
    if (!fs.existsSync(this.scriptPath)) {
      throw new Error(
        `[VYRA wake-word] Listener script missing at ${this.scriptPath}. ` +
          'Reinstall VYRA.',
      );
    }

    this.onDetect = onDetect;
    this.stopping = false;
    this.stdoutBuffer = '';
    this.stderrTail = '';

    const args = [
      this.scriptPath,
      'listen',
      '--model',
      modelPath,
      '--phrase',
      this.phrase,
      '--threshold',
      String(this.threshold),
    ];
    const child = await this.spawnPython(args);
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-MAX_STDERR_TAIL);
    });
    child.on('error', (err) => {
      if (!this.stopping) {
        this.callbacks.onEngineError?.(
          `[VYRA wake-word] Listener failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    child.on('exit', (code) => {
      this.child = null;
      if (!this.stopping && code !== 0) {
        const tail = this.stderrTail.trim();
        this.callbacks.onEngineError?.(
          `[VYRA wake-word] Listener stopped unexpectedly (exit ${code}).` +
            (tail ? ` Last output: ${tail.slice(-500)}` : ''),
        );
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    this.onDetect = null;
    if (child) {
      try {
        child.kill();
      } catch {
        // Best-effort: the process is going away anyway.
      }
    }
  }

  /** Try the configured interpreter, else `py -3` then `python` (Windows) or `python3` then `python`. */
  private spawnPython(scriptArgs: string[]): Promise<ChildProcess> {
    const candidates: Array<{ cmd: string; args: string[] }> = this.pythonPath
      ? [{ cmd: this.pythonPath, args: scriptArgs }]
      : process.platform === 'win32'
        ? [
            { cmd: 'py', args: ['-3', ...scriptArgs] },
            { cmd: 'python', args: scriptArgs },
          ]
        : [
            { cmd: 'python3', args: scriptArgs },
            { cmd: 'python', args: scriptArgs },
          ];
    return new Promise((resolve, reject) => {
      const tryNext = (index: number): void => {
        if (index >= candidates.length) {
          reject(
            new Error(
              '[VYRA wake-word] Python 3 was not found. Install it from ' +
                'python.org or with: winget install Python.Python.3.11',
            ),
          );
          return;
        }
        const { cmd, args } = candidates[index];
        let child: ChildProcess;
        try {
          child = this.spawnImpl(cmd, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (err) {
          tryNext(index + 1);
          return;
        }
        child.once('error', (err: unknown) => {
          if (
            err &&
            typeof err === 'object' &&
            (err as NodeJS.ErrnoException).code === 'ENOENT'
          ) {
            tryNext(index + 1);
          } else {
            reject(
              err instanceof Error ? err : new Error(String(err)),
            );
          }
        });
        child.once('spawn', () => resolve(child));
      };
      tryNext(0);
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8');
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: { event?: string; text?: string; message?: string };
      try {
        event = JSON.parse(trimmed) as typeof event;
      } catch {
        continue; // never let a stray line break detection
      }
      switch (event.event) {
        case 'wake':
          try {
            this.onDetect?.();
          } catch {
            // A throwing handler must not kill the listener.
          }
          break;
        case 'command':
          this.callbacks.onCommand?.(String(event.text ?? ''));
          break;
        case 'command-empty':
          this.callbacks.onCommand?.('');
          break;
        case 'error':
          this.callbacks.onEngineError?.(
            String(event.message ?? 'Wake-word listener reported an error.'),
          );
          break;
        default:
          break; // 'ready', 'mic-*', etc. are informational
      }
    }
  }
}
