/**
 * Typed wrapper around the window.vyra preload bridge.
 *
 * All renderer→main calls go through invoke(); all main→renderer events
 * through onEvent(). Nothing here touches Node or Electron directly.
 */
import type {
  AgentEvent,
  InvokeChannel,
  Task,
} from '@vyra/shared';
import type {
  ComputerFrame,
  MemoryEntry,
  OnboardingState,
  ProviderStatusInfo,
} from '../main/services.js';
import { stopPuterSpeech } from './lib/puterTts.js';

export interface IpcError {
  code: string;
  message: string;
}

interface RawIpcResponse {
  ok: boolean;
  data?: unknown;
  error?: IpcError;
}

export class VyraError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VyraError';
    this.code = code;
  }
}

function bridge(): NonNullable<Window['vyra']> {
  if (typeof window === 'undefined' || !window.vyra) {
    throw new VyraError(
      'NO_BRIDGE',
      'The VYRA bridge is not available. This UI must run inside the VYRA desktop app.',
    );
  }
  return window.vyra;
}

/** Invoke a main-process channel; throws VyraError when the call fails. */
export async function invoke<T>(channel: InvokeChannel, payload?: unknown): Promise<T> {
  const raw = (await bridge().invoke(channel, payload)) as RawIpcResponse;
  if (!raw || raw.ok !== true) {
    throw new VyraError(
      raw?.error?.code ?? 'IPC_ERROR',
      raw?.error?.message ?? `IPC call to ${channel} failed.`,
    );
  }
  return raw.data as T;
}

/** Subscribe to the multiplexed main→renderer event channel. Returns unsubscribe. */
export function onEvent(listener: (event: AgentEvent) => void): () => void {
  return bridge().on('vyra:event', (data: unknown) => {
    listener(data as AgentEvent);
  });
}

/* ------------------------------------------------------------------ */
/* Convenience wrappers                                                */
/* ------------------------------------------------------------------ */

export async function startTask(goal: string): Promise<{ taskId: string }> {
  return invoke('vyra:task:start', { goal });
}

export async function cancelTask(taskId: string): Promise<void> {
  await invoke('vyra:task:cancel', { taskId });
}

export async function listTasks(limit = 50, includeTerminal = true): Promise<Task[]> {
  return invoke('vyra:task:list', { limit, includeTerminal });
}

export async function getTask(taskId: string): Promise<Task | null> {
  return invoke('vyra:task:get', { taskId });
}

export async function voiceStart(): Promise<void> {
  await invoke('vyra:voice:start-listening');
}

export async function voiceStop(): Promise<void> {
  await invoke('vyra:voice:stop');
}

export async function pushToTalk(active: boolean): Promise<void> {
  await invoke('vyra:voice:push-to-talk', { active });
}

export async function interruptSpeech(): Promise<void> {
  // Stop renderer-side Puter speech first — the main-process interrupt only
  // knows about main-process providers. Both are best-effort.
  stopPuterSpeech();
  await invoke('vyra:voice:interrupt');
}

export async function rememberMemory(key: string, value: string, category?: string): Promise<void> {
  await invoke('vyra:memory:remember', { key, value, category });
}

export async function recallMemory(
  query?: string,
  category?: string,
  limit?: number,
): Promise<MemoryEntry[]> {
  return invoke('vyra:memory:recall', { query, category, limit });
}

export async function updateMemory(key: string, value: string): Promise<void> {
  await invoke('vyra:memory:update', { key, value });
}

export async function forgetMemory(key: string): Promise<{ forgotten: boolean }> {
  return invoke('vyra:memory:forget', { key });
}

export async function getSettings(): Promise<Record<string, Record<string, unknown>>> {
  return invoke('vyra:settings:get');
}

export async function setSettings(section: string, values: Record<string, unknown>): Promise<void> {
  await invoke('vyra:settings:set', { section, values });
}

export async function getSettingsSection(section: string): Promise<Record<string, unknown>> {
  return invoke('vyra:settings:get-section', { section });
}

export async function getProvidersStatus(): Promise<ProviderStatusInfo[]> {
  return invoke('vyra:providers:status');
}

export async function selectProvider(kind: string, id: string): Promise<void> {
  await invoke('vyra:providers:select', { kind, id });
}

export async function latestComputerFrame(): Promise<ComputerFrame | null> {
  return invoke('vyra:computer:latest-frame');
}

export async function respondSafety(requestId: string, approved: boolean): Promise<void> {
  await invoke('vyra:safety:respond', { requestId, approved });
}

export async function getOnboardingState(): Promise<OnboardingState> {
  return invoke('vyra:onboarding:get-state');
}

export async function completeOnboardingStep(
  step: string,
  values?: Record<string, unknown>,
): Promise<OnboardingState> {
  return invoke('vyra:onboarding:complete-step', { step, values });
}

export async function getAppVersion(): Promise<string> {
  const res = await invoke<{ version: string }>('vyra:app:version');
  return res.version;
}

export async function quitApp(): Promise<void> {
  await invoke('vyra:app:quit');
}
