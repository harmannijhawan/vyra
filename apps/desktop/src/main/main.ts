/**
 * VYRA — Electron main process.
 *
 * Creates the application window, wires the IPC handlers to the real backend
 * services (agent-core, tools, voice, memory, providers, observability,
 * safety via wiring.ts), and owns the push-to-talk global shortcut. If the
 * real wiring fails, main.ts falls back to the in-memory implementation and
 * says so openly in the activity feed — never silently.
 */
import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from './ipc.js';
import { createInMemoryServices, type EmitEvent } from './services.js';
import { createRealServices } from './wiring.js';
import type { AgentEvent } from '@vyra/shared';

const WINDOW_WIDTH = 1200;
const WINDOW_HEIGHT = 800;
const BACKGROUND_COLOR = '#0a0e14';
const DEV_SERVER_URL = 'http://localhost:5173';

let mainWindow: BrowserWindow | null = null;

/** Forward one AgentEvent to every renderer window (single multiplexed channel). */
function broadcast(event: AgentEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('vyra:event', event);
    }
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: BACKGROUND_COLOR,
    title: 'VYRA',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.setMenu(null);

  // Dev: prefer the Vite dev server when it is up; otherwise (packaged or
  // dev server not started) fall back to the bundled renderer.
  const loadRenderer = async (): Promise<void> => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    if (!app.isPackaged) {
      try {
        await mainWindow.loadURL(DEV_SERVER_URL);
        return;
      } catch {
        // Dev server isn't running — fall through to the bundled file.
      }
    }
    await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  };

  void loadRenderer();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * (Re)register the push-to-talk global shortcut from settings.
 * Failures are reported honestly and never crash the app.
 */
function registerPushToTalk(
  accelerator: string,
  enabled: boolean,
  onPress: () => void,
): void {
  globalShortcut.unregisterAll();
  if (!enabled || !accelerator) return;
  try {
    const registered = globalShortcut.register(accelerator, () => {
      // globalShortcut only fires on key-down (no key-up), so a press
      // toggles listening rather than true hold-to-talk.
      onPress();
    });
    if (!registered) {
      console.warn(`[vyra] Could not register push-to-talk shortcut "${accelerator}".`);
    }
  } catch (err) {
    console.warn(
      `[vyra] Failed to register push-to-talk shortcut "${accelerator}":`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const emit: EmitEvent = (event) => broadcast(event);

  // Real backend wiring (agent-core, tools, voice, memory, providers,
  // observability, safety). If it fails, the app still opens with the
  // honest in-memory implementation and reports the failure loudly —
  // it never pretends the backend is connected.
  let services;
  try {
    services = await createRealServices(emit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[vyra] Backend wiring failed, using in-memory fallback:', message);
    services = createInMemoryServices(emit);
    const at = new Date().toISOString();
    broadcast({
      type: 'activity',
      timestamp: at,
      payload: {
        message: 'VYRA started with limited capabilities.',
        detail: `Backend wiring failed: ${message}`,
        level: 'warning',
      },
    });
  }

  /** What the push-to-talk hotkey does: start listening via the voice service. */
  const onPushToTalkPress = (): void => {
    const at = new Date().toISOString();
    broadcast({
      type: 'log',
      timestamp: at,
      payload: {
        timestamp: at,
        level: 'info',
        action: 'hotkey.push-to-talk',
        result: 'pressed',
        component: 'vyra-desktop',
      },
    });
    void services.voiceStart().catch((err: unknown) => {
      console.warn('[vyra] push-to-talk failed:', err instanceof Error ? err.message : err);
    });
  };

  const applyVoiceHotkey = async (): Promise<void> => {
    try {
      const voice = await services.getSettingsSection('voice');
      registerPushToTalk(
        String(voice.pushToTalkHotkey ?? 'CommandOrControl+Shift+V'),
        voice.pushToTalkEnabled !== false,
        onPushToTalkPress,
      );
    } catch (err) {
      console.warn('[vyra] Could not read voice settings for hotkey registration:', err);
    }
  };

  registerIpcHandlers(ipcMain, services, {
    onSettingsChanged: (section) => {
      if (section === 'voice') {
        void applyVoiceHotkey();
      }
    },
    onQuitRequested: () => {
      app.quit();
    },
  });

  // Initial hotkey registration from stored settings.
  await applyVoiceHotkey();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

void bootstrap();

// Windows: quit when all windows are closed. (macOS keeps running.)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
