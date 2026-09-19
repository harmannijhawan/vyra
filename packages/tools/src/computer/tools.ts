/**
 * @vyra/tools — computer_* tool definitions + executors.
 *
 * Every executor runs through runTool(): args are validated against the
 * definition, ctx.signal is respected, and ok:true is returned ONLY when the
 * injected ComputerProvider verifiably performed the action.
 */
import type {
  ComputerProvider,
  MouseButton,
  RegisteredTool,
  ToolContext,
  ToolDefinition,
} from '@vyra/shared';
import { runTool, ToolRuntimeError, type ToolBody } from '../util.js';

function define(definition: ToolDefinition, body: ToolBody): RegisteredTool {
  return { definition, execute: (args, ctx: ToolContext) => runTool(definition, args, ctx, body) };
}

async function ensureAvailable(provider: ComputerProvider): Promise<void> {
  const cap = await provider.checkAvailability();
  if (!cap.available) {
    throw new ToolRuntimeError('COMPUTER_UNAVAILABLE', cap.reason ?? 'Computer control is not available on this host.', {
      recoverable: true,
      recoveryHint: 'Computer control requires Windows with @nut-tree-fork/nut-js installed.',
    });
  }
}

const BUTTONS = ['left', 'right', 'middle'] as const;

export function createComputerTools(provider: ComputerProvider): RegisteredTool[] {
  return [
    define(
      {
        name: 'computer_screenshot',
        description: 'Capture the current screen as a PNG image. Returns base64-encoded PNG bytes plus dimensions.',
        parameters: {},
        sideEffecting: false,
        risk: 'safe',
      },
      async () => {
        await ensureAvailable(provider);
        const shot = await provider.screenshot();
        return {
          imageBase64: shot.png.toString('base64'),
          mimeType: 'image/png',
          width: shot.width,
          height: shot.height,
          bytes: shot.png.length,
        };
      },
    ),

    define(
      {
        name: 'computer_move',
        description: 'Move the mouse cursor to the given screen coordinates (pixels).',
        parameters: {
          x: { type: 'integer', description: 'Horizontal screen coordinate in pixels.', required: true },
          y: { type: 'integer', description: 'Vertical screen coordinate in pixels.', required: true },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        await ensureAvailable(provider);
        const x = args.x as number;
        const y = args.y as number;
        await provider.move(x, y);
        return { x, y };
      },
    ),

    define(
      {
        name: 'computer_click',
        description: 'Click a mouse button at the current cursor position.',
        parameters: {
          button: {
            type: 'string',
            description: 'Which mouse button to click.',
            enum: [...BUTTONS],
            default: 'left',
          },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        await ensureAvailable(provider);
        const button = args.button as MouseButton;
        await provider.click(button);
        return { button };
      },
    ),

    define(
      {
        name: 'computer_right_click',
        description: 'Right-click at the current cursor position (opens context menus).',
        parameters: {},
        sideEffecting: true,
        risk: 'normal',
      },
      async () => {
        await ensureAvailable(provider);
        await provider.click('right');
        return { button: 'right' };
      },
    ),

    define(
      {
        name: 'computer_double_click',
        description: 'Double-click a mouse button at the current cursor position.',
        parameters: {
          button: {
            type: 'string',
            description: 'Which mouse button to double-click.',
            enum: [...BUTTONS],
            default: 'left',
          },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        await ensureAvailable(provider);
        const button = args.button as MouseButton;
        await provider.doubleClick(button);
        return { button };
      },
    ),

    define(
      {
        name: 'computer_drag',
        description: 'Drag the mouse from one screen coordinate to another (left button held).',
        parameters: {
          fromX: { type: 'integer', description: 'Start horizontal coordinate in pixels.', required: true },
          fromY: { type: 'integer', description: 'Start vertical coordinate in pixels.', required: true },
          toX: { type: 'integer', description: 'End horizontal coordinate in pixels.', required: true },
          toY: { type: 'integer', description: 'End vertical coordinate in pixels.', required: true },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        await ensureAvailable(provider);
        const fromX = args.fromX as number;
        const fromY = args.fromY as number;
        const toX = args.toX as number;
        const toY = args.toY as number;
        await provider.drag(fromX, fromY, toX, toY);
        return { fromX, fromY, toX, toY };
      },
    ),

    define(
      {
        name: 'computer_scroll',
        description: 'Scroll the mouse wheel. Positive dy scrolls down, positive dx scrolls right (wheel steps).',
        parameters: {
          dx: { type: 'integer', description: 'Horizontal wheel steps (positive = right).', default: 0 },
          dy: { type: 'integer', description: 'Vertical wheel steps (positive = down).', default: 0 },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        await ensureAvailable(provider);
        const dx = args.dx as number;
        const dy = args.dy as number;
        await provider.scroll(dx, dy);
        return { dx, dy };
      },
    ),

    define(
      {
        name: 'computer_type',
        description: 'Type text with the system keyboard into the currently focused window.',
        parameters: {
          text: { type: 'string', description: 'Text to type. Must not be empty.', required: true },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        await ensureAvailable(provider);
        const text = args.text as string;
        if (text.length === 0) {
          throw new ToolRuntimeError('INVALID_ARGS', 'text must not be empty.', { recoverable: false });
        }
        await provider.type(text);
        return { chars: text.length };
      },
    ),

    define(
      {
        name: 'computer_key',
        description:
          'Press a key, optionally with modifiers (e.g. key "s" with ["ctrl"] to save). Key names: enter, esc, tab, space, arrows, F1-F24, a-z, 0-9, etc.',
        parameters: {
          key: { type: 'string', description: 'Key to press, e.g. "Enter", "a", "F5", "Escape".', required: true },
          modifiers: {
            type: 'array',
            description: 'Modifier keys held while pressing the key.',
            items: {
              type: 'string',
              description: 'A modifier key.',
              enum: ['ctrl', 'shift', 'alt', 'meta'],
            },
            default: [],
          },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        await ensureAvailable(provider);
        const key = args.key as string;
        const modifiers = args.modifiers as Array<'ctrl' | 'shift' | 'alt' | 'meta'>;
        await provider.key(key, modifiers);
        return { key, modifiers };
      },
    ),

    define(
      {
        name: 'computer_hotkey',
        description: 'Press a key combination, e.g. ["ctrl", "shift", "s"]. Keys are pressed in order and released in reverse.',
        parameters: {
          keys: {
            type: 'array',
            description: 'Keys to press as a chord, in order.',
            items: { type: 'string', description: 'A key name, e.g. "ctrl", "alt", "Delete".' },
            required: true,
          },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        await ensureAvailable(provider);
        const keys = args.keys as string[];
        if (keys.length === 0) {
          throw new ToolRuntimeError('INVALID_ARGS', 'keys must contain at least one key.', { recoverable: false });
        }
        await provider.hotkey(keys);
        return { keys };
      },
    ),

    define(
      {
        name: 'computer_launch',
        description: 'Launch an application by name (e.g. "notepad") or full path. Resolves once the process is running.',
        parameters: {
          app: { type: 'string', description: 'Application name or executable path.', required: true },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        await ensureAvailable(provider);
        const app = args.app as string;
        await provider.launchApp(app);
        return { app, launched: true };
      },
    ),

    define(
      {
        name: 'computer_windows',
        description: 'List visible windows: title, owning app, focus state and bounds.',
        parameters: {},
        sideEffecting: false,
        risk: 'safe',
      },
      async () => {
        await ensureAvailable(provider);
        const windows = await provider.listWindows();
        return { windows, count: windows.length };
      },
    ),

    define(
      {
        name: 'computer_processes',
        description: 'List running processes (pid and name).',
        parameters: {},
        sideEffecting: false,
        risk: 'safe',
      },
      async () => {
        await ensureAvailable(provider);
        const processes = await provider.listProcesses();
        return { processes, count: processes.length };
      },
    ),
  ];
}
