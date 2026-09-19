/**
 * VYRA — real backend wiring for the Electron main process.
 *
 * createRealServices() assembles the full stack:
 *   providers (registry + env) → computer/browser providers
 *   → ToolRegistry (+ SafetyPolicy gate) → Brain + TaskEngine (persistent)
 *   → VoiceService (STT/TTS/VAD) → SQLiteMemory → JsonlLogger
 *
 * Everything is honest: unavailable capabilities report *why* they are
 * unavailable; nothing is fabricated. This module runs in the main process
 * only — secrets (API keys) never leave it.
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  Brain,
  FileTaskStore,
  TaskEngine,
  ToolRegistry,
} from '@vyra/agent-core';
import {
  NutJsComputerProvider,
  PlaywrightBrowserProvider,
  registerAllTools,
} from '@vyra/tools';
import {
  STTService,
  TTSService,
  VoiceActivityDetector,
  VoiceService,
} from '@vyra/voice';
import { SessionContext, SQLiteMemory } from '@vyra/memory';
import { createDefaultRegistry, loadEnvConfig } from '@vyra/providers';
import { JsonlLogger } from '@vyra/observability';
import { SafetyPolicy } from '@vyra/safety';
import {
  VYRA_PHRASES,
  toolFail,
  type AgentEvent,
  type AIProvider,
  type AIResponse,
  type BrowserProvider,
  type ChatMessage,
  type ComputerProvider,
  type ProviderKind,
  type ToolExecutor,
  type VisionProvider,
} from '@vyra/shared';
import {
  DEFAULT_SETTINGS,
  type ComputerFrame,
  type EmitEvent,
  type MainServices,
  type MemoryEntry,
  type OnboardingState,
  type ProviderStatusInfo,
} from './services.js';

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

const PROVIDER_KINDS: ProviderKind[] = [
  'ai',
  'stt',
  'tts',
  'vision',
  'computer',
  'browser',
  'wakeword',
];

/**
 * API keys live in the main process only. They are persisted in a
 * mode-600 `secrets.json` under the data directory (never in settings.json,
 * never in logs, never sent to the renderer) and loaded back into
 * `process.env` at startup so providers pick them up via readSecret().
 */
const SECRETS_FILE = 'secrets.json';

function secretsPath(dataDir: string): string {
  return path.join(dataDir, SECRETS_FILE);
}

function loadPersistedSecrets(dataDir: string): void {
  try {
    const raw = fs.readFileSync(secretsPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.length > 0 && !process.env[name]) {
        process.env[name] = value;
      }
    }
  } catch {
    // No secrets saved yet — providers will honestly report missing keys.
  }
}

function persistSecret(dataDir: string, name: string, value: string): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(
      fs.readFileSync(secretsPath(dataDir), 'utf8'),
    ) as Record<string, unknown>;
  } catch {
    // No secrets file yet — start fresh.
  }
  existing[name] = value;
  fs.writeFileSync(secretsPath(dataDir), JSON.stringify(existing), {
    mode: 0o600,
  });
}

/**
 * Live-check a Gemini API key against Google's model list. Never throws:
 * returns 'ok' when Google accepts the key, 'invalid' when Google rejects
 * it, and 'unknown' when the check itself could not run (offline, timeout).
 */
async function validateGoogleApiKey(
  key: string,
): Promise<'ok' | 'invalid' | 'unknown'> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { signal: controller.signal },
    );
    if (res.ok) return 'ok';
    if (res.status === 400 || res.status === 401 || res.status === 403)
      return 'invalid';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timeout);
  }
}

/** AIProvider stub used only when no AI provider is registered at all. */
class NoAiProvider implements AIProvider {
  readonly id = 'none';
  readonly displayName = 'No AI provider configured';
  async checkAvailability() {
    return {
      available: false,
      reason:
        'No AI provider is configured. Set VYRA_AI_PROVIDER and the matching API key in your .env file, then restart VYRA.',
    };
  }
  async chat(_messages: ChatMessage[]): Promise<AIResponse> {
    throw new Error(
      '[VYRA] No AI provider is configured — planning is unavailable.',
    );
  }
}

/** File-backed settings store, seeded from DEFAULT_SETTINGS. */
class FileSettingsStore {
  private data: Record<string, Record<string, unknown>>;
  constructor(private readonly filePath: string) {
    let loaded: Record<string, Record<string, unknown>> = {};
    try {
      if (fs.existsSync(filePath)) {
        loaded = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
          string,
          Record<string, unknown>
        >;
      }
    } catch {
      loaded = {};
    }
    this.data = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...loaded };
    for (const [section, values] of Object.entries(DEFAULT_SETTINGS)) {
      this.data[section] = { ...values, ...(loaded[section] ?? {}) };
    }
    this.save();
  }
  getAll(): Record<string, Record<string, unknown>> {
    return JSON.parse(JSON.stringify(this.data));
  }
  getSection(section: string): Record<string, unknown> {
    return { ...(this.data[section] ?? {}) };
  }
  setSection(section: string, values: Record<string, unknown>): void {
    this.data[section] = { ...(this.data[section] ?? {}), ...values };
    this.save();
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}

function asErrorCode(err: unknown): { code: string; message: string } {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = String((err as { code: unknown }).code);
    const message = err instanceof Error ? err.message : code;
    return { code, message };
  }
  return {
    code: 'ENGINE_ERROR',
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Build the real MainServices. Async because the TaskEngine performs
 * stale-task recovery on construction.
 */
export async function createRealServices(emit: EmitEvent): Promise<MainServices> {
  const env = loadEnvConfig();
  const dataDir = env.dataDir || app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });

  // Keys saved during onboarding are loaded before providers are built,
  // so a saved key takes effect on every launch without re-entering it.
  loadPersistedSecrets(dataDir);

  const logger = new JsonlLogger({ dataDir, component: 'vyra-main' });
  const settings = new FileSettingsStore(path.join(dataDir, 'settings.json'));

  const timedEmit: EmitEvent = (event: AgentEvent) => emit(event);
  const untimedEmit = (event: Omit<AgentEvent, 'timestamp'>) =>
    timedEmit({ ...event, timestamp: new Date().toISOString() });

  // --- Providers -----------------------------------------------------------
  const providerSettings = {
    get: (key: string) => {
      const v = settings.getSection('providers')[key];
      return typeof v === 'string' ? v : undefined;
    },
    set: (key: string, value: string) => {
      settings.setSection('providers', { [key]: value });
    },
  };
  const providers = createDefaultRegistry(env, providerSettings);

  const computer =
    providers.get<ComputerProvider>('computer') ??
    new NutJsComputerProvider();
  const browser =
    providers.get<BrowserProvider>('browser') ??
    new PlaywrightBrowserProvider();
  const aiProvider =
    providers.get<AIProvider>('ai') ?? new NoAiProvider();
  const visionProvider = providers.get<VisionProvider>('vision');

  // --- Safety + tool registry ----------------------------------------------
  const toolDefinitions = new Map<string, { risk: string }>();
  const safety = new SafetyPolicy(toolDefinitions, untimedEmit);

  const toolRegistry = new ToolRegistry();
  registerAllTools(
    {
      register(definition, executor: ToolExecutor) {
        toolDefinitions.set(definition.name, { risk: definition.risk });
        const gated: ToolExecutor = async (args, ctx) => {
          const decision = safety.evaluate(definition.name, args);
          if (decision === 'deny') {
            return toolFail(
              'SAFETY_DENIED',
              `VYRA blocked "${definition.name}": this action is not permitted.`,
              0,
              { recoverable: false, taskId: ctx.taskId },
            );
          }
          if (decision === 'confirm') {
            const approved = await safety.requestConfirmation(
              definition.name,
              args,
              `Allow VYRA to ${definition.description.charAt(0).toLowerCase()}${definition.description.slice(1)}?`,
            );
            if (!approved) {
              return toolFail(
                'SAFETY_DECLINED',
                `You declined "${definition.name}". The task cannot continue with this step.`,
                0,
                { recoverable: false, taskId: ctx.taskId },
              );
            }
          }
          return executor(args, ctx);
        };
        toolRegistry.register(definition, gated);
      },
    },
    { computer, browser },
  );

  // --- Brain + task engine ---------------------------------------------------
  const brain = new Brain({
    ai: aiProvider,
    registry: toolRegistry,
    vision: visionProvider ?? undefined,
    computer,
    onEvent: untimedEmit,
  });

  const engine = await TaskEngine.create({
    store: new FileTaskStore(path.join(dataDir, 'tasks')),
    registry: toolRegistry,
    onEvent: (event) => timedEmit(event),
  });

  const runTaskInBackground = async (goal: string, context?: Record<string, unknown>) => {
    const task = await engine.createTask(goal, { context });
    // runTask drives the task to a terminal state; failures are recorded
    // on the task itself and surfaced through engine events.
    void brain.runTask(task, engine).catch((err: unknown) => {
      const { code, message } = asErrorCode(err);
      logger.error('task.run', {
        taskId: task.id,
        result: 'failed',
        error: { code, message },
      });
      untimedEmit({
        type: 'activity',
        taskId: task.id,
        payload: {
          message: 'VYRA could not complete the task.',
          detail: message,
          level: 'error',
        },
      });
    });
    return task;
  };

  // --- Voice -----------------------------------------------------------------
  const sttService = new STTService();
  const ttsService = new TTSService();
  try {
    const sttId = String(settings.getSection('voice').sttProvider ?? '');
    if (sttId && sttId !== 'none') sttService.select(sttId);
  } catch { /* keep default */ }
  try {
    const ttsId = String(settings.getSection('voice').ttsProvider ?? '');
    if (ttsId && ttsId !== 'none') ttsService.select(ttsId);
  } catch { /* keep default */ }

  const voiceService = new VoiceService({
    stt: sttService,
    tts: ttsService,
    vad: new VoiceActivityDetector({ sampleRate: 16000 }),
    emit: (event) => timedEmit(event),
    respond: async (turn) => {
      // A voice utterance becomes a real task; the reply is honest about it.
      await runTaskInBackground(turn.text);
      return VYRA_PHRASES.working;
    },
  });

  // --- Memory ----------------------------------------------------------------
  const memory = new SQLiteMemory(path.join(dataDir, 'vyra-memory.db'), {
    emit: (event) => timedEmit(event),
  });
  const session = new SessionContext();
  void session;

  logger.info('vyra.startup', { result: VYRA_PHRASES.ready });
  untimedEmit({
    type: 'activity',
    payload: { message: VYRA_PHRASES.ready, level: 'success' },
  });

  // --- Computer preview (throttled, real screenshots only) --------------------
  let lastFrame: ComputerFrame | null = null;
  let lastFrameAt = 0;
  const FRAME_THROTTLE_MS = 2000;
  const captureFrame = async (): Promise<ComputerFrame | null> => {
    const now = Date.now();
    if (lastFrame && now - lastFrameAt < FRAME_THROTTLE_MS) return lastFrame;
    try {
      const shot = await computer.screenshot();
      lastFrame = {
        dataUrl: `data:image/png;base64,${shot.png.toString('base64')}`,
        width: shot.width,
        height: shot.height,
        capturedAt: new Date().toISOString(),
      };
      lastFrameAt = now;
      return lastFrame;
    } catch {
      // Honest: no frame when the provider cannot capture (e.g. non-Windows).
      return null;
    }
  };

  // --- Onboarding --------------------------------------------------------------
  const getOnboarding = (): OnboardingState => {
    const stored = settings.getSection('onboarding') as Partial<OnboardingState>;
    return {
      completed: stored.completed ?? false,
      currentStep: stored.currentStep ?? ONBOARDING_STEPS[0],
      completedSteps: stored.completedSteps ?? [],
    };
  };

  const services: MainServices = {
    async startTask(goal, context) {
      const task = await runTaskInBackground(goal, context);
      return { taskId: task.id };
    },
    async cancelTask(taskId) {
      await engine.cancel(taskId);
    },
    async listTasks(limit, includeTerminal) {
      return engine.list({ limit, includeTerminal });
    },
    async getTask(taskId) {
      return (await engine.get(taskId)) ?? null;
    },

    async voiceStart() {
      await voiceService.startUtterance();
    },
    async voiceStop() {
      await voiceService.stopUtterance();
    },
    async pushToTalk(active) {
      if (active) await voiceService.startUtterance();
      else await voiceService.stopUtterance();
    },
    async interruptSpeech() {
      await voiceService.interrupt();
    },

    async memoryRemember(key, value, category) {
      memory.remember(key, value, category);
    },
    async memoryRecall(query, category, limit): Promise<MemoryEntry[]> {
      return memory
        .recall({ query, category, limit: limit ?? 50 })
        .map((r) => ({
          key: r.key,
          value: r.value,
          category: r.category ?? undefined,
          updatedAt: r.updatedAt,
        }));
    },
    async memoryUpdate(key, value) {
      memory.updateMemory(key, value);
    },
    async memoryForget(key) {
      return memory.forgetMemory(key);
    },

    async getSettings() {
      return settings.getAll();
    },
    async setSettings(section, values) {
      settings.setSection(section, values);
      logger.info('settings.set', { result: section });
    },
    async getSettingsSection(section) {
      return settings.getSection(section);
    },

    async providersStatus(): Promise<ProviderStatusInfo[]> {
      const out: ProviderStatusInfo[] = [];
      for (const kind of PROVIDER_KINDS) {
        for (const p of providers.list(kind)) {
          let available = false;
          let reason: string | undefined;
          try {
            const cap = await p.checkAvailability();
            available = cap.available;
            reason = cap.reason;
          } catch (err) {
            reason = err instanceof Error ? err.message : 'Availability check failed.';
          }
          out.push({
            kind,
            id: p.id,
            displayName: p.displayName,
            available,
            reason: available ? undefined : (reason ?? 'Unavailable.'),
            selected: providers.selected(kind) === p.id,
          });
        }
      }
      return out;
    },
    async selectProvider(kind, id) {
      const k = kind as ProviderKind;
      providers.select(k, id);
      if (k === 'stt') {
        try { sttService.select(id); } catch { /* registry is source of truth */ }
      }
      if (k === 'tts') {
        try { ttsService.select(id); } catch { /* registry is source of truth */ }
      }
      logger.info('providers.select', { result: `${kind}:${id}` });
    },

    async latestComputerFrame() {
      return captureFrame();
    },

    async safetyRespond(requestId, approved) {
      safety.handleResponse(requestId, approved);
    },

    async onboardingState() {
      return getOnboarding();
    },
    async completeOnboardingStep(step, values) {
      const state = getOnboarding();
      if (values) {
        const apiKey = values.googleApiKey;
        if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
          const key = apiKey.trim();
          const verdict = await validateGoogleApiKey(key);
          if (verdict === 'invalid') {
            throw Object.assign(
              new Error(
                'Google rejected that API key. Grab a fresh one from Google AI Studio (aistudio.google.com) and try again.',
              ),
              { code: 'INVALID_API_KEY' },
            );
          }
          // The key works (or the check could not run offline) — keep it in
          // the main process only, and make Google VYRA's brain and eyes.
          process.env.GOOGLE_GENERATIVE_AI_KEY = key;
          persistSecret(dataDir, 'GOOGLE_GENERATIVE_AI_KEY', key);
          await services.selectProvider('ai', 'google');
          await services.selectProvider('vision', 'google');
          logger.info('onboarding.google-key', {
            result: `saved (live verification: ${verdict})`,
          });
        }
        for (const [k, v] of Object.entries(values)) {
          if (k === 'sttProvider' || k === 'ttsProvider' || k === 'aiProvider') {
            const kind = k === 'aiProvider' ? 'ai' : k === 'sttProvider' ? 'stt' : 'tts';
            try {
              await services.selectProvider(kind, String(v));
            } catch { /* keep going */ }
          }
        }
      }
      if (!state.completedSteps.includes(step)) state.completedSteps.push(step);
      const next = ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(step) + 1];
      const updated: OnboardingState = next
        ? { ...state, currentStep: next }
        : { ...state, completed: true };
      settings.setSection('onboarding', {
        completed: updated.completed,
        currentStep: updated.currentStep,
        completedSteps: updated.completedSteps,
      });
      return updated;
    },

    async queryLogs(query) {
      return logger.query({
        level: query.level as 'debug' | 'info' | 'warn' | 'error' | undefined,
        taskId: query.taskId,
        limit: query.limit ?? 200,
      });
    },

    async getVersion() {
      return app.getVersion();
    },
    async quitApp() {
      // main.ts performs the actual quit after this resolves.
    },
  };

  return services;
}
