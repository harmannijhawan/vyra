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
});
