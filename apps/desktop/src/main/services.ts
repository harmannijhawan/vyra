/**
 * MainServices — the seam between the Electron main process and VYRA's
 * backend capabilities (Task Engine, voice, memory, providers, …).
 *
 * The real implementations live in @vyra/agent-core, @vyra/voice,
 * @vyra/memory, @vyra/providers, @vyra/observability and @vyra/safety.
 * Wiring those in is a later integration step; main.ts currently injects
 * the in-memory implementation below, which returns honest empty states
 * (never fabricated activity) so the UI can be developed and smoke-tested.
 */
import type {
  AgentEvent,
  StructuredLog,
  Task,
} from '@vyra/shared';
import type { GeminiConnectionResult } from '@vyra/providers';

/** One remembered fact, as returned by memoryRecall(). */
export interface MemoryEntry {
  key: string;
  value: string;
  category?: string;
  updatedAt: string;
}

/** One message in a conversational chat (system prompts stay server-side). */
export interface ChatMessageInput {
  role: 'user' | 'assistant';
  content: string;
}

/** VYRA's reply to a chat message. */
export interface ChatReply {
  text: string;
  model: string;
}

/** Honest provider availability report for the Settings UI. */
export interface ProviderStatusInfo {
  kind: string;
  id: string;
  displayName: string;
  available: boolean;
  /** Required when available === false. Shown verbatim in Settings. */
  reason?: string;
  selected: boolean;
}

/** Latest real screenshot frame, or null when none was captured yet. */
export interface ComputerFrame {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: string;
}

/** First-run onboarding progress. */
export interface OnboardingState {
  completed: boolean;
  currentStep: string;
  completedSteps: string[];
}

export type EmitEvent = (event: AgentEvent) => void;

export interface MainServices {
  // Tasks
  startTask(goal: string, context?: Record<string, unknown>): Promise<{ taskId: string }>;
  cancelTask(taskId: string): Promise<void>;
  listTasks(limit?: number, includeTerminal?: boolean): Promise<Task[]>;
  getTask(taskId: string): Promise<Task | null>;
  // Voice
  voiceStart(): Promise<void>;
  voiceStop(): Promise<void>;
  pushToTalk(active: boolean): Promise<void>;
  interruptSpeech(): Promise<void>;
  // Memory
  memoryRemember(key: string, value: string, category?: string): Promise<void>;
  memoryRecall(query?: string, category?: string, limit?: number): Promise<MemoryEntry[]>;
  memoryUpdate(key: string, value: string): Promise<void>;
  memoryForget(key: string): Promise<boolean>;
  // Settings
  getSettings(): Promise<Record<string, Record<string, unknown>>>;
  setSettings(section: string, values: Record<string, unknown>): Promise<void>;
  getSettingsSection(section: string): Promise<Record<string, unknown>>;
  // Providers
  providersStatus(): Promise<ProviderStatusInfo[]>;
  selectProvider(kind: string, id: string): Promise<void>;
  // Computer preview
  latestComputerFrame(): Promise<ComputerFrame | null>;
  // Safety
  safetyRespond(requestId: string, approved: boolean): Promise<void>;
  // Onboarding
  onboardingState(): Promise<OnboardingState>;
  completeOnboardingStep(step: string, values?: Record<string, unknown>): Promise<OnboardingState>;
  /** Dry-run Gemini connection test — validates without saving anything. */
  testGoogleConnection(apiKey: string, model?: string): Promise<GeminiConnectionResult>;
  /** Conversational chat — a real AI reply, not a task plan. */
  chatSend(messages: ChatMessageInput[]): Promise<ChatReply>;
  // Logs
  queryLogs(query: { level?: string; taskId?: string; limit?: number }): Promise<StructuredLog[]>;
  // App
  getVersion(): Promise<string>;
  quitApp(): Promise<void>;
}

/** Default settings shipped before the user changes anything. */
export const DEFAULT_SETTINGS: Record<string, Record<string, unknown>> = {
  general: {
    launchOnStartup: false,
    minimizeToTray: true,
    theme: 'dark',
  },
  voice: {
    sttProvider: 'none',
    ttsProvider: 'puter',
    speakReplies: true,
    pushToTalkEnabled: true,
    pushToTalkHotkey: 'CommandOrControl+Shift+V',
    wakeWordEnabled: false,
    wakeWord: 'hey vyra',
    interruptibleSpeech: true,
    speechRate: 1.0,
  },
  models: {
    defaultModel: '',
    temperature: 0.2,
    maxTokens: 4000,
  },
  computer: {
    enabled: true,
    screenshotIntervalMs: 2000,
    requireConfirmation: true,
  },
  browser: {
    enabled: true,
    headless: false,
  },
  memory: {
    enabled: true,
    retentionDays: 365,
  },
  security: {
    confirmDestructiveActions: true,
    allowRemoteAccess: false,
  },
  appearance: {
    accentColor: '#6d5cff',
    reduceMotion: false,
  },
  logs: {
    level: 'info',
    persistToDisk: true,
  },
};

const ONBOARDING_STEPS = [
  'welcome',
  'google-api-key',
  'microphone',
  'voice',
  'computer-permissions',
  'browser',
  'memory',
  'shortcuts',
];

/**
 * In-memory MainServices for development. Holds real user-supplied state
 * for this session (settings edits, remembered facts, onboarding progress)
 * but fabricates nothing: no tasks exist until the engine is wired in,
 * no frames until the computer provider captures one, and every provider
 * honestly reports why it is unavailable.
 */
export function createInMemoryServices(emit: EmitEvent): MainServices {
  const settings: Record<string, Record<string, unknown>> = JSON.parse(
    JSON.stringify(DEFAULT_SETTINGS),
  );
  const memory = new Map<string, MemoryEntry>();
  const logs: StructuredLog[] = [];
  const onboarding: OnboardingState = {
    completed: false,
    currentStep: ONBOARDING_STEPS[0],
    completedSteps: [],
  };
  const selectedProviders = new Map<string, string>();

  function log(action: string, result?: string, level: StructuredLog['level'] = 'info') {
    const record: StructuredLog = {
      timestamp: new Date().toISOString(),
      level,
      action,
      result,
      component: 'vyra-desktop',
    };
    logs.push(record);
    if (logs.length > 2000) logs.splice(0, logs.length - 2000);
    emit({ type: 'log', timestamp: record.timestamp, payload: record });
  }

  return {
    async startTask(goal) {
      // The Task Engine is wired in during integration; until then we
      // refuse honestly instead of inventing a fake task.
      log('task.start', `rejected: engine not wired (goal: ${goal.slice(0, 80)})`, 'warn');
      throw Object.assign(new Error('The task engine is not connected yet.'), {
        code: 'ENGINE_NOT_WIRED',
      });
    },
    async cancelTask() {
      throw Object.assign(new Error('The task engine is not connected yet.'), {
        code: 'ENGINE_NOT_WIRED',
      });
    },
    async listTasks() {
      return [];
    },
    async getTask() {
      return null;
    },

    async voiceStart() {
      log('voice.start', 'voice engine not wired — no-op', 'warn');
    },
    async voiceStop() {
      log('voice.stop');
    },
    async pushToTalk() {
      log('voice.push-to-talk', 'voice engine not wired — no-op', 'warn');
    },
    async interruptSpeech() {
      log('voice.interrupt');
    },

    async memoryRemember(key, value, category) {
      memory.set(key, { key, value, category, updatedAt: new Date().toISOString() });
      log('memory.remember', key);
      emit({
        type: 'memory.event',
        timestamp: new Date().toISOString(),
        payload: { action: 'remember', key },
      });
    },
    async memoryRecall(query, category, limit) {
      const q = (query ?? '').toLowerCase();
      const entries = [...memory.values()].filter(
        (e) =>
          (!category || e.category === category) &&
          (!q || e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)),
      );
      return entries.slice(0, limit ?? 50);
    },
    async memoryUpdate(key, value) {
      const existing = memory.get(key);
      if (!existing) {
        throw Object.assign(new Error(`No memory with key "${key}".`), { code: 'NOT_FOUND' });
      }
      memory.set(key, { ...existing, value, updatedAt: new Date().toISOString() });
      log('memory.update', key);
    },
    async memoryForget(key) {
      const deleted = memory.delete(key);
      if (deleted) log('memory.forget', key);
      return deleted;
    },

    async getSettings() {
      return JSON.parse(JSON.stringify(settings));
    },
    async setSettings(section, values) {
      settings[section] = { ...(settings[section] ?? {}), ...values };
      log('settings.set', section);
    },
    async getSettingsSection(section) {
      return { ...(settings[section] ?? {}) };
    },

    async providersStatus() {
      // Honest: nothing is configured in this dev wiring yet.
      const kinds: Array<{ kind: string; id: string; displayName: string }> = [
        { kind: 'ai', id: 'none', displayName: 'No AI provider configured' },
        { kind: 'stt', id: 'none', displayName: 'No speech-to-text provider configured' },
        { kind: 'tts', id: 'none', displayName: 'No text-to-speech provider configured' },
        { kind: 'vision', id: 'none', displayName: 'No vision provider configured' },
        { kind: 'computer', id: 'none', displayName: 'No computer-control provider configured' },
        { kind: 'browser', id: 'none', displayName: 'No browser provider configured' },
        { kind: 'wakeword', id: 'none', displayName: 'No wake-word provider configured' },
      ];
      return kinds.map((k) => ({
        ...k,
        available: false,
        reason: 'Not configured yet — connect a provider to enable this capability.',
        selected: (selectedProviders.get(k.kind) ?? 'none') === k.id,
      }));
    },
    async selectProvider(kind, id) {
      selectedProviders.set(kind, id);
      log('providers.select', `${kind}:${id}`);
    },

    async latestComputerFrame() {
      return null;
    },

    async safetyRespond(requestId, approved) {
      log('safety.respond', `${requestId}: ${approved ? 'approved' : 'denied'}`);
      emit({
        type: 'safety.confirm.response',
        timestamp: new Date().toISOString(),
        payload: { requestId, approved },
      });
    },

    async testGoogleConnection(_apiKey: string): Promise<GeminiConnectionResult> {
      // The in-memory fallback has no real backend: say so honestly instead
      // of pretending to test.
      return {
        ok: false,
        code: 'unknown',
        message:
          'VYRA started with limited capabilities, so the connection cannot be tested right now. Restart the app and try again.',
      };
    },

    async chatSend(): Promise<ChatReply> {
      throw new Error(
        'VYRA started with limited capabilities, so chat is unavailable right now. Restart the app and try again.',
      );
    },

    async onboardingState() {
      return { ...onboarding, completedSteps: [...onboarding.completedSteps] };
    },
    async completeOnboardingStep(step, values) {
      if (values && Object.keys(values).length > 0) {
        // Persist any choices the step collected (e.g. provider ids) —
        // but never secret values: API keys must not land in settings.
        for (const [k, v] of Object.entries(values)) {
          if (/key/i.test(k)) continue;
          settings.general[k] = v;
        }
      }
      if (!onboarding.completedSteps.includes(step)) onboarding.completedSteps.push(step);
      const next = ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(step) + 1];
      if (next) {
        onboarding.currentStep = next;
      } else {
        onboarding.completed = true;
      }
      log('onboarding.complete-step', step);
      return this.onboardingState();
    },

    async queryLogs(query) {
      let out = logs;
      if (query.level) out = out.filter((l) => l.level === query.level);
      if (query.taskId) out = out.filter((l) => l.taskId === query.taskId);
      return out.slice(-(query.limit ?? 200));
    },

    async getVersion() {
      return '0.1.0';
    },
    async quitApp() {
      // main.ts performs the actual quit after this resolves.
    },
  };
}
