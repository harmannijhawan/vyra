/**
 * NutJsComputerProvider — real Win32 computer control via @nut-tree-fork/nut-js.
 *
 * The nut-js module is lazy-loaded inside try/catch: importing this file must
 * NEVER throw, on any host. On non-Windows hosts the availability probe
 * reports { available: false } with an honest reason, and every method throws
 * a clear Error instead of faking success.
 */
import type {
  ComputerProvider,
  MouseButton,
  ProcessInfo,
  ProviderCapability,
  Screenshot,
  WindowInfo,
} from '@vyra/shared';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorMessage, runProcess } from '../util.js';

type NutJs = typeof import('@nut-tree-fork/nut-js');

const notWindows = (host: string): string =>
  `Computer control requires Windows (Win32); this host is ${host}.`;

/** Numeric button ids, matching the nut-js Button enum (LEFT=0, MIDDLE=1, RIGHT=2). */
const BUTTON_IDS: Record<MouseButton, number> = { left: 0, middle: 1, right: 2 };

let cachedNut: NutJs | null = null;

/** Load nut-js on Windows; throw a clear Error anywhere else. */
async function loadNutJs(): Promise<NutJs> {
  if (process.platform !== 'win32') {
    throw new Error(notWindows(process.platform));
  }
  if (cachedNut) return cachedNut;
  try {
    cachedNut = await import('@nut-tree-fork/nut-js');
  } catch (err) {
    throw new Error(
      `@nut-tree-fork/nut-js could not be loaded: ${errorMessage(err)}. ` +
        'Computer control needs this package installed on Windows.',
    );
  }
  return cachedNut;
}

/** Friendly key names ("enter", "ctrl", "a", "F5") -> nut-js Key enum member. */
const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  return: 'Return',
  enter: 'Enter',
  del: 'Delete',
  delete: 'Delete',
  ins: 'Insert',
  insert: 'Insert',
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  capslock: 'CapsLock',
  numlock: 'NumLock',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  printscreen: 'Print',
  print: 'Print',
  menu: 'Menu',
  shift: 'LeftShift',
  ctrl: 'LeftControl',
  control: 'LeftControl',
  alt: 'LeftAlt',
  meta: 'LeftSuper',
  super: 'LeftSuper',
  win: 'LeftWin',
  windows: 'LeftWin',
  cmd: 'LeftCmd',
  command: 'LeftCmd',
  grave: 'Grave',
  '`': 'Grave',
  minus: 'Minus',
  '-': 'Minus',
  equal: 'Equal',
  '=': 'Equal',
  leftbracket: 'LeftBracket',
  '[': 'LeftBracket',
  rightbracket: 'RightBracket',
  ']': 'RightBracket',
  backslash: 'Backslash',
  '\\': 'Backslash',
  semicolon: 'Semicolon',
  ';': 'Semicolon',
  quote: 'Quote',
  "'": 'Quote',
  comma: 'Comma',
  ',': 'Comma',
  period: 'Period',
  '.': 'Period',
  slash: 'Slash',
  '/': 'Slash',
  divide: 'Divide',
  multiply: 'Multiply',
  subtract: 'Subtract',
  add: 'Add',
  decimal: 'Decimal',
};

function resolveNutKey(name: string, nut: NutJs): number {
  const raw = name.trim();
  const lower = raw.toLowerCase();
  let candidate: string;
  if (/^[a-z]$/.test(lower)) {
    candidate = lower.toUpperCase();
  } else if (/^[0-9]$/.test(lower)) {
    candidate = `Num${lower}`;
  } else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
    candidate = lower.toUpperCase();
  } else if (/^numpad[0-9]$/.test(lower)) {
    candidate = `NumPad${lower.slice('numpad'.length)}`;
  } else {
    candidate = KEY_ALIASES[lower] ?? raw;
  }
  const value = (nut.Key as unknown as Record<string, number>)[candidate];
  if (typeof value !== 'number') {
    throw new Error(`Unknown key: "${name}".`);
  }
  return value;
}

export class NutJsComputerProvider implements ComputerProvider {
  readonly id = 'nutjs-computer';
  readonly displayName = 'nut-js computer control';

  async checkAvailability(): Promise<ProviderCapability> {
    if (process.platform !== 'win32') {
      return { available: false, reason: notWindows(process.platform) };
    }
    let nut: NutJs;
    try {
      nut = await loadNutJs();
    } catch (err) {
      return { available: false, reason: errorMessage(err) };
    }
    try {
      // Real probe: ask the OS for the cursor position through the native module.
      await nut.mouse.getPosition();
      return { available: true };
    } catch (err) {
      return {
        available: false,
        reason: `nut-js probe failed on this Windows host: ${errorMessage(err)}`,
      };
    }
  }

  async screenshot(): Promise<Screenshot> {
    const nut = await loadNutJs();
    // nut-js writes real PNG bytes via screen.capture(); we read them back.
    const dir = await mkdtemp(join(tmpdir(), 'vyra-screenshot-'));
    try {
      const filePath = await nut.screen.capture(`vyra-${Date.now()}`, nut.FileType.PNG, dir);
      const png = await readFile(filePath);
      if (png.length === 0) {
        throw new Error('nut-js wrote an empty screenshot file.');
      }
      const width = await nut.screen.width();
      const height = await nut.screen.height();
      return { png, width, height };
    } catch (err) {
      throw new Error(`screenshot failed: ${errorMessage(err)}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async getCursorPosition(): Promise<{ x: number; y: number }> {
    const nut = await loadNutJs();
    try {
      const p = await nut.mouse.getPosition();
      return { x: Math.round(p.x), y: Math.round(p.y) };
    } catch (err) {
      throw new Error(`getCursorPosition failed: ${errorMessage(err)}`);
    }
  }

  async move(x: number, y: number): Promise<void> {
    const nut = await loadNutJs();
    try {
      await nut.mouse.setPosition({ x: Math.round(x), y: Math.round(y) });
    } catch (err) {
      throw new Error(`move(${x}, ${y}) failed: ${errorMessage(err)}`);
    }
  }

  async click(button: MouseButton = 'left'): Promise<void> {
    const nut = await loadNutJs();
    try {
      await nut.mouse.click(BUTTON_IDS[button]);
    } catch (err) {
      throw new Error(`click(${button}) failed: ${errorMessage(err)}`);
    }
  }

  async doubleClick(button: MouseButton = 'left'): Promise<void> {
    const nut = await loadNutJs();
    try {
      await nut.mouse.doubleClick(BUTTON_IDS[button]);
    } catch (err) {
      throw new Error(`doubleClick(${button}) failed: ${errorMessage(err)}`);
    }
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    const nut = await loadNutJs();
    try {
      const from = { x: Math.round(fromX), y: Math.round(fromY) };
      const to = { x: Math.round(toX), y: Math.round(toY) };
      await nut.mouse.setPosition(from);
      // nut-js drag() presses the left button, follows the path, then releases.
      await nut.mouse.drag([from, to]);
    } catch (err) {
      throw new Error(`drag failed: ${errorMessage(err)}`);
    }
  }

  async scroll(dx: number, dy: number): Promise<void> {
    const nut = await loadNutJs();
    try {
      const stepsX = Math.trunc(dx);
      const stepsY = Math.trunc(dy);
      if (stepsX > 0) await nut.mouse.scrollRight(stepsX);
      else if (stepsX < 0) await nut.mouse.scrollLeft(-stepsX);
      if (stepsY > 0) await nut.mouse.scrollDown(stepsY);
      else if (stepsY < 0) await nut.mouse.scrollUp(-stepsY);
    } catch (err) {
      throw new Error(`scroll failed: ${errorMessage(err)}`);
    }
  }

  async type(text: string): Promise<void> {
    const nut = await loadNutJs();
    try {
      await nut.keyboard.type(text);
    } catch (err) {
      throw new Error(`type failed: ${errorMessage(err)}`);
    }
  }

  async key(key: string, modifiers: Array<'ctrl' | 'shift' | 'alt' | 'meta'> = []): Promise<void> {
    const nut = await loadNutJs();
    try {
      const main = resolveNutKey(key, nut);
      const mods = modifiers.map((m) => resolveNutKey(m, nut));
      await nut.keyboard.pressKey(...mods, main);
      try {
        // Brief hold so the OS registers the chord.
        await new Promise((r) => setTimeout(r, 30));
      } finally {
        await nut.keyboard.releaseKey(main, ...[...mods].reverse());
      }
    } catch (err) {
      throw new Error(`key("${key}") failed: ${errorMessage(err)}`);
    }
  }

  async hotkey(keys: string[]): Promise<void> {
    const nut = await loadNutJs();
    if (keys.length === 0) {
      throw new Error('hotkey requires at least one key.');
    }
    try {
      const resolved = keys.map((k) => resolveNutKey(k, nut));
      await nut.keyboard.pressKey(...resolved);
      try {
        await new Promise((r) => setTimeout(r, 30));
      } finally {
        await nut.keyboard.releaseKey(...[...resolved].reverse());
      }
    } catch (err) {
      throw new Error(`hotkey(${keys.join('+')}) failed: ${errorMessage(err)}`);
    }
  }

  async launchApp(app: string): Promise<void> {
    // Platform gate first: honest failure on non-Windows instead of a fake launch.
    await loadNutJs();
    const target = app.trim();
    if (!target) {
      throw new Error('launchApp: app name or path must not be empty.');
    }
    const candidates = target.toLowerCase().endsWith('.exe') ? [target] : [target, `${target}.exe`];
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        await spawnDetached(candidate);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`launchApp: could not launch "${app}": ${errorMessage(lastError)}`);
  }

  async listWindows(): Promise<WindowInfo[]> {
    const nut = await loadNutJs();
    // Best effort via PowerShell: real titles, app names and focus state.
    try {
      return await this.listWindowsViaPowerShell();
    } catch (err) {
      // Fall back to nut-js window enumeration (titles + bounds only).
      try {
        const windows = await nut.getWindows();
        const infos: WindowInfo[] = [];
        for (const w of windows) {
          const title = await w.getTitle().catch(() => '');
          const region = await w.getRegion().catch(() => null);
          infos.push({
            id: title || 'unknown',
            title,
            appName: 'unknown',
            focused: false,
            bounds: region
              ? { x: region.left, y: region.top, width: region.width, height: region.height }
              : undefined,
          });
        }
        return infos;
      } catch (fallbackErr) {
        throw new Error(
          `listWindows failed (PowerShell: ${errorMessage(err)}; nut-js fallback: ${errorMessage(fallbackErr)})`,
        );
      }
    }
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    await loadNutJs();
    const script = 'Get-Process | Select-Object Id, ProcessName | ConvertTo-Json -Compress';
    const result = await runProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeoutMs: 15_000 },
    );
    if (result.timedOut) {
      throw new Error('listProcesses timed out.');
    }
    if (result.exitCode !== 0) {
      throw new Error(`listProcesses failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    return parseJsonArray(result.stdout).map((p) => ({
      pid: Number(p.Id),
      name: String(p.ProcessName ?? ''),
    }));
  }

  private async listWindowsViaPowerShell(): Promise<WindowInfo[]> {
    const script = [
      `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class VyraWin32 { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'`,
      '$fg = ([VyraWin32]::GetForegroundWindow()).ToInt64()',
      'Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { [pscustomobject]@{ Id = $_.Id; ProcessName = $_.ProcessName; MainWindowTitle = $_.MainWindowTitle; Focused = ($_.MainWindowHandle.ToInt64() -eq $fg) } } | ConvertTo-Json -Compress',
    ].join('; ');
    const result = await runProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeoutMs: 15_000 },
    );
    if (result.timedOut) {
      throw new Error('PowerShell window enumeration timed out.');
    }
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `powershell exited with code ${result.exitCode}`);
    }
    return parseJsonArray(result.stdout).map((w) => ({
      id: Number(w.Id),
      title: String(w.MainWindowTitle ?? ''),
      appName: String(w.ProcessName ?? ''),
      focused: Boolean(w.Focused),
    }));
  }
}

/** Launch detached; resolve only once the process is actually running. */
function spawnDetached(cmd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, [], { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    const proc = child;
    proc.once('error', reject);
    proc.unref();
    // Surface apps that fail immediately instead of reporting fake success.
    setTimeout(() => {
      if (proc.exitCode !== null && proc.exitCode !== 0) {
        reject(new Error(`process exited immediately with code ${proc.exitCode}`));
      } else {
        resolve();
      }
    }, 400);
  });
}

function parseJsonArray(stdout: string): Array<Record<string, unknown>> {
  const text = stdout.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`could not parse PowerShell JSON output: ${errorMessage(err)}`);
  }
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  if (parsed && typeof parsed === 'object') return [parsed as Record<string, unknown>];
  return [];
}
