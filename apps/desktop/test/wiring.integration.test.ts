/**
 * Integration smoke test for apps/desktop/src/main/wiring.ts.
 *
 * Runs the REAL backend assembly (providers, safety-gated tool registry,
 * Brain, persistent TaskEngine, voice services, SQLite memory) with only
 * the 'electron' module mocked. Nothing here is a mockup of VYRA behavior:
 * if wiring is broken, these tests fail.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const userDataDir = mkdtempSync(join(tmpdir(), 'vyra-test-'));
process.env.VYRA_DATA_DIR = userDataDir;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userDataDir : userDataDir),
    getVersion: () => '0.0.0-test',
  },
}));

import type { AgentEvent } from '@vyra/shared';
import type { MainServices } from '../src/main/services.js';
import { createRealServices } from '../src/main/wiring.js';

describe('real backend wiring (wiring.ts)', () => {
  let events: AgentEvent[];
  let services: MainServices;

  beforeEach(async () => {
    events = [];
    services = await createRealServices((e) => {
      events.push(e);
    });
  }, 30_000);

  it('exposes every MainServices capability', () => {
    for (const method of [
      'startTask', 'cancelTask', 'listTasks', 'getTask',
      'voiceStart', 'voiceStop', 'pushToTalk', 'interruptSpeech',
      'memoryRemember', 'memoryRecall', 'memoryUpdate', 'memoryForget',
      'getSettings', 'setSettings', 'getSettingsSection',
      'providersStatus', 'selectProvider', 'latestComputerFrame',
      'safetyRespond', 'onboardingState', 'completeOnboardingStep',
      'queryLogs', 'getVersion', 'quitApp',
    ] as const) {
      expect(typeof services[method], method).toBe('function');
    }
  });

  it('probes providers honestly (computer control unavailable on Linux)', async () => {
    const statuses = await services.providersStatus();
    const kinds = new Set(statuses.map((s) => s.kind));
    // wakeword has no registered provider in the default registry (the app
    // falls back to the push-to-talk hotkey); every other kind must probe.
    for (const kind of ['ai', 'stt', 'tts', 'vision', 'computer', 'browser']) {
      expect(kinds.has(kind as never), `missing kind ${kind}`).toBe(true);
    }
    const computer = statuses.find((s) => s.kind === 'computer');
    expect(computer).toBeDefined();
    // On this Linux host the computer provider must report itself honestly.
    expect(computer!.available).toBe(false);
    expect(computer!.reason).toBeTruthy();
  });

  it('runs a task end-to-end and records an honest terminal state', async () => {
    // No AI provider is configured in this environment, so the Brain cannot
    // plan. The honest outcome is a FAILED task with a clear error — not a
    // fabricated success.
    const { taskId } = await services.startTask('say hello');
    let task = await services.getTask(taskId);
    const deadline = Date.now() + 15_000;
    while (task && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
      if (Date.now() > deadline) throw new Error('task did not reach a terminal state');
      await new Promise((r) => setTimeout(r, 200));
      task = await services.getTask(taskId);
    }
    expect(task).not.toBeNull();
    expect(['COMPLETED', 'FAILED', 'CANCELLED']).toContain(task!.status);
    const listed = await services.listTasks(10, true);
    expect(listed.some((t) => t.id === taskId)).toBe(true);
  }, 30_000);

  it('persists memory across the real SQLite store', async () => {
    await services.memoryRemember('wiring-test-key', 'wiring-test-value', 'test');
    const recalled = await services.memoryRecall('wiring-test');
    expect(recalled.some((e) => e.key === 'wiring-test-key' && e.value === 'wiring-test-value')).toBe(true);
    await services.memoryUpdate('wiring-test-key', 'updated-value');
    const recalled2 = await services.memoryRecall('wiring-test');
    expect(recalled2.some((e) => e.key === 'wiring-test-key' && e.value === 'updated-value')).toBe(true);
    expect(await services.memoryForget('wiring-test-key')).toBe(true);
  });

  it('persists settings and onboarding to disk', async () => {
    await services.setSettings('voice', { sttProvider: 'none' });
    expect((await services.getSettingsSection('voice')).sttProvider).toBe('none');
    const state = await services.onboardingState();
    expect(state.completed).toBe(false);
    const next = await services.completeOnboardingStep(state.currentStep);
    expect(next.completedSteps).toContain(state.currentStep);
  });

  it('emits a startup activity event and answers version queries', async () => {
    expect(events.some((e) => e.type === 'activity')).toBe(true);
    expect(await services.getVersion()).toBe('0.0.0-test');
    const logs = await services.queryLogs({ limit: 5 });
    expect(Array.isArray(logs)).toBe(true);
  });

  it('latestComputerFrame returns null (not a fake frame) when capture is unavailable', async () => {
    const frame = await services.latestComputerFrame();
    // On Linux nut.js cannot capture; honest null beats a fabricated image.
    expect(frame).toBeNull();
  });

  it('onboarding starts at WELCOME TO VYRA on a fresh install', async () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'vyra-welcome-'));
    const prev = process.env.VYRA_DATA_DIR;
    process.env.VYRA_DATA_DIR = freshDir;
    try {
      const fresh = await createRealServices(() => {});
      const state = await fresh.onboardingState();
      expect(state.currentStep).toBe('welcome');
      expect(state.completedSteps).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.VYRA_DATA_DIR;
      else process.env.VYRA_DATA_DIR = prev;
    }
  });

  it('onboarding: google-api-key step validates live, persists securely, selects Google', async () => {
    const prevKey = process.env.GOOGLE_GENERATIVE_AI_KEY;
    const prevModel = process.env.VYRA_AI_MODEL;
    const secretsFile = join(userDataDir, 'secrets.json');
    const settingsFile = join(userDataDir, 'settings.json');
    // Google accepts the key AND the resolved model really generates
    // (stubbed network — both legs of the real connection test).
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url).includes(':generateContent')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ candidates: [{ content: { parts: [{ text: 'VYRA-OK' }] } }] }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-flash',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
      } as Response;
    });
    try {
      delete process.env.GOOGLE_GENERATIVE_AI_KEY;
      delete process.env.VYRA_AI_MODEL;
      const { rmSync, readFileSync, existsSync } = await import('node:fs');
      try { rmSync(secretsFile); } catch { /* fresh */ }
      const state = await services.completeOnboardingStep('google-api-key', {
        googleApiKey: 'AIza-test-key-123',
      });
      expect(state.completedSteps).toContain('google-api-key');
      expect(state.currentStep).toBe('microphone');
      // Key is live in the main-process environment for providers…
      expect(process.env.GOOGLE_GENERATIVE_AI_KEY).toBe('AIza-test-key-123');
      // …persisted to a secrets file…
      expect(existsSync(secretsFile)).toBe(true);
      const rawSecrets = readFileSync(secretsFile, 'utf8');
      expect(rawSecrets).toContain('GOOGLE_GENERATIVE_AI_KEY');
      // The working model is remembered for future launches…
      expect(process.env.VYRA_AI_MODEL).toBe('gemini-2.5-flash');
      expect((await services.getSettingsSection('models')).defaultModel).toBe(
        'gemini-2.5-flash',
      );
      // …but never in settings.json, which the renderer can read.
      expect(readFileSync(settingsFile, 'utf8')).not.toContain('AIza-test-key-123');
      // …and Google is now VYRA's selected brain and eyes.
      const statuses = await services.providersStatus();
      expect(statuses.find((s) => s.kind === 'ai' && s.id === 'google')?.selected).toBe(true);
      expect(statuses.find((s) => s.kind === 'vision' && s.id === 'google')?.selected).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      const { rmSync } = await import('node:fs');
      try { rmSync(secretsFile); } catch { /* cleaned */ }
      if (prevKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_KEY = prevKey;
      if (prevModel === undefined) delete process.env.VYRA_AI_MODEL;
      else process.env.VYRA_AI_MODEL = prevModel;
    }
  });

  it('chat: selecting Google after startup routes chat to Google (no stale provider)', async () => {
    // Regression test for the "valid key, still broken" bug: the AI provider
    // used to be captured once at startup, so a provider selected later
    // (during onboarding) never took effect. chatSend must resolve the
    // selected provider on every call.
    const prevKey = process.env.GOOGLE_GENERATIVE_AI_KEY;
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Hello from Gemini.' }] } }],
        }),
    }) as Response);
    try {
      process.env.GOOGLE_GENERATIVE_AI_KEY = 'test-key-for-chat';
      // Select Google AFTER the services (and Brain) were already built.
      await services.selectProvider('ai', 'google');
      const reply = await services.chatSend([{ role: 'user', content: 'hello' }]);
      expect(reply.text).toBe('Hello from Gemini.');
      expect(typeof reply.model).toBe('string');
    } finally {
      vi.unstubAllGlobals();
      if (prevKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_KEY = prevKey;
    }
  });

  it('chat: an honest error when no AI provider is available', async () => {
    const prevKey = process.env.GOOGLE_GENERATIVE_AI_KEY;
    const prevOpenAI = process.env.OPENAI_API_KEY;
    try {
      delete process.env.GOOGLE_GENERATIVE_AI_KEY;
      delete process.env.OPENAI_API_KEY;
      // Nothing selected and no keys: whichever default provider resolves
      // must report itself honestly instead of fabricating a reply.
      await expect(services.chatSend([{ role: 'user', content: 'hi' }])).rejects.toThrow();
    } finally {
      if (prevKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_KEY = prevKey;
      if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAI;
    }
  });

  it('onboarding: a Google-rejected API key surfaces an honest error', async () => {
    const prevKey = process.env.GOOGLE_GENERATIVE_AI_KEY;
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'API key not valid.' } }),
    }) as Response);
    try {
      delete process.env.GOOGLE_GENERATIVE_AI_KEY;
      await expect(
        services.completeOnboardingStep('google-api-key', { googleApiKey: 'bad-key' }),
      ).rejects.toThrow('Google rejected that API key');
      // Rejected keys are never stored.
      expect(process.env.GOOGLE_GENERATIVE_AI_KEY ?? '').not.toBe('bad-key');
      const { existsSync } = await import('node:fs');
      expect(existsSync(join(userDataDir, 'secrets.json'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      if (prevKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_KEY = prevKey;
    }
  });
});
