/**
 * Handler wiring tests — registerIpcHandlers() with a stub ipcMain and
 * stub services. Verifies the validate-then-handle pattern for a sample
 * of channels and the { ok:false, error:{code,message} } envelope.
 */
import { describe, expect, it } from 'vitest';
import { INVOKE_CHANNELS } from '@vyra/shared';
import { registerIpcHandlers, type IpcResult } from '../src/main/ipc';
import type { MainServices } from '../src/main/services';

type Handler = (event: unknown, payload?: unknown) => Promise<IpcResult>;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    handle(channel: string, fn: Handler): void {
      handlers.set(channel, fn);
    },
  };
}

function stubServices(overrides: Partial<MainServices> = {}): MainServices {
  const notWired = (): Promise<never> =>
    Promise.reject(Object.assign(new Error('not wired'), { code: 'ENGINE_NOT_WIRED' }));
  const base: MainServices = {
    startTask: async (goal: string) => ({ taskId: `task_${goal.length}` }),
    cancelTask: async () => {},
    listTasks: async () => [],
    getTask: async () => null,
    voiceStart: async () => {},
    voiceStop: async () => {},
    pushToTalk: async () => {},
    interruptSpeech: async () => {},
    memoryRemember: async () => {},
    memoryRecall: async () => [],
    memoryUpdate: async () => {},
    memoryForget: async () => true,
    getSettings: async () => ({}),
    setSettings: async () => {},
    getSettingsSection: async () => ({}),
    providersStatus: async () => [],
    selectProvider: async () => {},
    latestComputerFrame: async () => null,
    safetyRespond: async () => {},
    onboardingState: async () => ({ completed: false, currentStep: 'welcome', completedSteps: [] }),
    completeOnboardingStep: async (step: string) => ({
      completed: false,
      currentStep: step,
      completedSteps: [step],
    }),
    queryLogs: async () => [],
    getVersion: async () => '0.1.0',
    quitApp: async () => {},
  };
  void notWired;
  return { ...base, ...overrides };
}

function setup(overrides: Partial<MainServices> = {}) {
  const ipcMain = fakeIpcMain();
  const hooks: string[] = [];
  registerIpcHandlers(ipcMain as never, stubServices(overrides), {
    onSettingsChanged: (section) => hooks.push(section),
  });
  return { ipcMain, hooks };
}

async function call(
  ipcMain: ReturnType<typeof fakeIpcMain>,
  channel: string,
  payload?: unknown,
): Promise<IpcResult> {
  const fn = ipcMain.handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({}, payload);
}

describe('registerIpcHandlers', () => {
  it('registers exactly the INVOKE_CHANNELS — unknown channels are never handled', () => {
    const { ipcMain } = setup();
    expect([...ipcMain.handlers.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it('validates then delegates: task:start with a good payload', async () => {
    const { ipcMain } = setup();
    const res = await call(ipcMain, 'vyra:task:start', { goal: 'hello' });
    expect(res).toEqual({ ok: true, data: { taskId: 'task_5' } });
  });

  it('rejects invalid payloads with INVALID_PAYLOAD', async () => {
    const { ipcMain } = setup();
    const res = await call(ipcMain, 'vyra:task:start', { goal: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects non-empty payloads on payload-less channels', async () => {
    const { ipcMain } = setup();
    const res = await call(ipcMain, 'vyra:voice:stop', { surprise: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INVALID_PAYLOAD');
  });

  it('accepts empty payloads on payload-less channels', async () => {
    const { ipcMain } = setup();
    expect((await call(ipcMain, 'vyra:voice:stop', undefined)).ok).toBe(true);
    expect((await call(ipcMain, 'vyra:voice:stop', null)).ok).toBe(true);
  });

  it('never throws across IPC: service errors become { ok:false }', async () => {
    const { ipcMain } = setup({
      voiceStart: async () => {
        throw new Error('microphone exploded');
      },
    });
    const res = await call(ipcMain, 'vyra:voice:start-listening', undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('UNKNOWN');
      expect(res.error.message).toBe('microphone exploded');
    }
  });

  it('preserves custom error codes from services', async () => {
    const { ipcMain } = setup({
      startTask: async () => {
        throw Object.assign(new Error('engine missing'), { code: 'ENGINE_NOT_WIRED' });
      },
    });
    const res = await call(ipcMain, 'vyra:task:start', { goal: 'x' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('ENGINE_NOT_WIRED');
  });

  it('fires onSettingsChanged after settings:set', async () => {
    const { ipcMain, hooks } = setup();
    const res = await call(ipcMain, 'vyra:settings:set', {
      section: 'voice',
      values: { wakeWord: 'hey vyra' },
    });
    expect(res.ok).toBe(true);
    expect(hooks).toEqual(['voice']);
  });

  it('validates safety responses strictly', async () => {
    const { ipcMain } = setup();
    const bad = await call(ipcMain, 'vyra:safety:respond', {
      requestId: 'r1',
      approved: 'yes',
    });
    expect(bad.ok).toBe(false);
    const good = await call(ipcMain, 'vyra:safety:respond', {
      requestId: 'r1',
      approved: true,
    });
    expect(good).toEqual({ ok: true, data: { requestId: 'r1', approved: true } });
  });
});
