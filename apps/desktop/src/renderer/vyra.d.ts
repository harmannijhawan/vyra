/**
 * Type declaration for the VYRA preload bridge (window.vyra).
 * Injected by src/preload/preload.ts with contextIsolation on.
 */
export interface VyraBridge {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  on: (channel: string, listener: (event: unknown) => void) => () => void;
}

declare global {
  interface Window {
    vyra?: VyraBridge;
  }
}

export {};
