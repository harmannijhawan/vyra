/**
 * VYRA preload script.
 *
 * Exposes a minimal, allowlisted bridge as `window.vyra`.
 * contextIsolation stays ON; there is no nodeIntegration anywhere —
 * the renderer never touches Node or Electron APIs directly.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { assertEventChannel, assertInvokeChannel } from './bridge.js';

export interface VyraPreloadBridge {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  on: (channel: string, listener: (event: unknown) => void) => () => void;
}

const bridge: VyraPreloadBridge = {
  invoke: (channel: string, payload?: unknown) => {
    assertInvokeChannel(channel);
    return ipcRenderer.invoke(channel, payload);
  },
  on: (channel: string, listener: (event: unknown) => void) => {
    assertEventChannel(channel);
    const wrapped = (_ipcEvent: unknown, data: unknown): void => {
      listener(data);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('vyra', bridge);
