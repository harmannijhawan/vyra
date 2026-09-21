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
  WakeWordService,
} from '@vyra/voice';
import { SessionContext, createMemory } from '@vyra/memory';
import { createDefaultRegistry, loadEnvConfig, testGeminiConnection, type GeminiConnectionResult } from '@vyra/providers';
import { JsonlLogger } from '@vyra/observability';
import { SafetyPolicy } from '@vyra/safety';
import {
  VYRA_PHRASES,
  VoiceState,
  activity,
  toolFail,
  type AgentEvent,
  type AIProvider,
  type AIResponse,
  type BrowserProvider,
  type ChatMessage,
  type ComputerProvider,
  type ProviderCapability,
  type ProviderKind,
  type ProviderRegistry,
  type ToolExecutor,
  type VisionProvider,
} from '@vyra/shared';
import {
  DEFAULT_SETTINGS,
  type ChatMessageInput,
  type ChatReply,
  type ComputerFrame,
  type EmitEvent,
  type MainServices,
  type MemoryEntry,
  type OnboardingState,
  type ProviderStatusInfo,
} from './services.js';
import { electronEncryptor, SecretStore } from './secrets.js';
import { OpenWakeWordEngine } from './wakeword-engine.js';

/**
 * Secrets live in the main process only, encrypted with Electron safeStorage
 * (DPAPI on Windows) whenever encryption is available. See secrets.ts.
 */

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

/** What VYRA says about itself in conversational chat. */
const VYRA_CHAT_SYSTEM_PROMPT =
  "You are VYRA, the user's personal AI running on their own PC. " +
  'Be warm, concise, and direct — no fluff, no filler openers. ' +
  'Answer questions, explain things, write and debug code, and help with anything they ask. ' +
  'If they ask you to operate their computer (open apps, click, type, automate tasks), ' +
  'briefly say what you would do: real computer actions run as Tasks, started with the Task toggle.';

/**
 * Resolves the selected AI provider on EVERY call instead of capturing it
 * once at startup. Capturing it once was the "valid Gemini key, still
 * broken" bug: onboarding selected Google after the Brain was already
 * built around the startup default.
 */
class LazyVisionProvider implements VisionProvider {
  readonly id = 'selected-vision';
  readonly displayName = 'Selected vision provider';

  constructor(private readonly registry: ProviderRegistry) {}

  private current(): VisionProvider | undefined {
    return this.registry.get<VisionProvider>('vision');
  }

  async checkAvailability(): Promise<ProviderCapability> {
    const current = this.current();
    if (!current) {
      return {
        available: false,
        reason: 'No vision provider is configured.',
      };
    }
    return current.checkAvailability();
  }

  analyzeScreenshot(
    png: Buffer | Uint8Array,
  ): ReturnType<VisionProvider['analyzeScreenshot']> {
    const current = this.current();
    if (!current) {
      return Promise.reject(new Error('No vision provider is configured.'));
    }
    return current.analyzeScreenshot(png);
  }
}

class LazyAIProvider implements AIProvider {
  readonly id = 'selected-ai';
  readonly displayName = 'Selected AI provider';

  constructor(private readonly registry: ProviderRegistry) {}

  private current(): AIProvider {
    return this.registry.get<AIProvider>('ai') ?? new NoAiProvider();
  }

  checkAvailability(): Promise<ProviderCapability> {
    return this.current().checkAvailability();
  }

  chat(
    messages: ChatMessage[],
    opts?: Parameters<AIProvider['chat']>[1],
  ): Promise<AIResponse> {
    return this.current().chat(messages, opts);
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

  // Secrets are encrypted at rest (Electron safeStorage / DPAPI on Windows).
  // Keys saved during onboarding are loaded before providers are built,
  // so a saved key takes effect on every launch without re-entering it.
  const secretStore = new SecretStore(dataDir, electronEncryptor());
  secretStore.applyToEnv();

  const logger = new JsonlLogger({ dataDir, component: 'vyra-main' });
  const settings = new FileSettingsStore(path.join(dataDir, 'settings.json'));

  // A model resolved by a previous successful connection test wins over the
  // built-in default (an explicit VYRA_AI_MODEL env var still wins overall).
  // GoogleProvider reads this lazily per request, so order doesn't matter.
  const savedModel = settings.getSection('models').defaultModel;
  if (typeof savedModel === 'string' && savedModel.length > 0 && !process.env.VYRA_AI_MODEL) {
    process.env.VYRA_AI_MODEL = savedModel;
  }

  const timedEmit: EmitEvent = (event: AgentEvent) => emit(event);
  const untimedEmit = (event: Omit<AgentEvent, 'timestamp'>) =>
    timedEmit({ ...event, timestamp: new Date().toISOString() });

  // Wake-word task tracking: command transcripts heard after "Vira" become
  // real tasks; when a watched task reaches a terminal state the orb goes
  // back to idle. Filled in by the wake-word section further below.
  const wakeWatchedTasks = new Set<string>();
  const WAKE_TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
  const watchWakeTask = (event: AgentEvent): void => {
    if (event.type !== 'task.status') return;
    const taskId = (event as { taskId?: string }).taskId;
    if (!taskId || !wakeWatchedTasks.has(taskId)) return;
    const to = (event.payload as { to?: string } | undefined)?.to;
    if (!to || !WAKE_TERMINAL_STATES.has(to)) return;
    wakeWatchedTasks.delete(taskId);
    untimedEmit({
      type: 'voice.state',
      payload: { from: VoiceState.THINKING, to: VoiceState.IDLE },
    });
    untimedEmit(
      activity(
        to === 'COMPLETED' ? 'Done.' : 'That task did not finish.',
        to === 'COMPLETED' ? 'success' : 'warning',
      ),
    );
  };
  /** Every internal event flows through here so wake tasks can be watched. */
  const busEmit = (event: AgentEvent | Omit<AgentEvent, 'timestamp'>): void => {
    const timed = (
      'timestamp' in event && typeof event.timestamp === 'string'
        ? event
        : { ...event, timestamp: new Date().toISOString() }
    ) as AgentEvent;
    watchWakeTask(timed);
    emit(timed);
  };

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
  const aiProvider = new LazyAIProvider(providers);
  const visionProvider = new LazyVisionProvider(providers);

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
  // Long-term memory lives here; the Brain gets the user's identity facts
  // so it knows who it serves (e.g. their name) without being told twice.
  // If the SQLite native module cannot load, memory degrades to session
  // storage LOUDLY — it never takes the whole backend down with it.
  const memory = createMemory(path.join(dataDir, 'vyra-memory.db'), {
    emit: (event) => timedEmit(event),
    onDegraded: (err) => {
      logger.error('memory.degraded', {
        result: 'persistent memory unavailable; using session memory',
        error: { code: 'MEMORY_DEGRADED', message: err.message },
      });
      untimedEmit(
        activity(
          'Persistent memory is unavailable — using session memory instead. ' +
            'Tasks, voice, and the wake word still work; memories will not survive a restart.',
          'warning',
          err.message,
        ),
      );
    },
  });
  // Seed the user's identity once — never overwrites a name the user set
  // themselves through Memory tools.
  try {
    const hasName = memory
      .recall({ query: 'user.name', limit: 5 })
      .some((r) => r.key === 'user.name');
    if (!hasName) {
      memory.remember('user.name', 'Harman Nijhawan', 'identity');
    }
  } catch {
    // Memory is a convenience, never a startup blocker.
  }
  const userFacts = memory
    .recall({ category: 'identity', limit: 20 })
    .map((r) => `- ${r.key}: ${r.value}`)
    .join('\n');

  const brain = new Brain({
    ai: aiProvider,
    registry: toolRegistry,
    vision: visionProvider ?? undefined,
    computer,
    userFacts,
    onEvent: busEmit,
  });

  const engine = await TaskEngine.create({
    store: new FileTaskStore(path.join(dataDir, 'tasks')),
    registry: toolRegistry,
    onEvent: busEmit,
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
    // 'puter' is renderer-side (Puter.js runs in the app window); the
    // main-process TTS registry only holds key-based providers. Unknown ids
    // are left alone instead of crashing wiring.
    if (ttsId && ttsId !== 'none') {
      try {
        ttsService.select(ttsId);
      } catch {
        /* renderer-side provider — selection happens in the UI layer */
      }
    }
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

  // --- Wake word ---------------------------------------------------------------
  // "Vira" detection runs fully offline in a Python helper (openWakeWord);
  // the transcript of the command spoken right after becomes a real task.
  // Nothing is uploaded anywhere.
  const wakeModelsDir = path.join(dataDir, 'wakeword');
  fs.mkdirSync(wakeModelsDir, { recursive: true });

  const readWakePhrase = (): string => {
    const raw = String(settings.getSection('voice').wakeWord ?? 'vira');
    return raw.trim().toLowerCase() || 'vira';
  };

  /** The wake word was heard: visible event + orb goes to listening. */
  const handleWake = (): void => {
    const phrase = wakeEngine.getPhrase();
    logger.info('wakeword.detect', { result: `heard "${phrase}"` });
    untimedEmit({
      type: 'voice.state',
      payload: { from: VoiceState.IDLE, to: VoiceState.LISTENING },
    });
    untimedEmit(
      activity(`Heard "${phrase}" — listening for your command.`, 'info'),
    );
  };

  /** A command spoken after the wake word: run it as a real task. */
  const handleWakeCommand = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) {
      untimedEmit(
        activity("Didn't catch that — say the wake word and try again.", 'info'),
      );
      untimedEmit({
        type: 'voice.state',
        payload: { from: VoiceState.LISTENING, to: VoiceState.IDLE },
      });
      return;
    }
    const shown =
      trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
    logger.info('wakeword.command', { result: shown });
    untimedEmit(activity(`Heard: "${shown}"`, 'info'));
    untimedEmit({
      type: 'voice.state',
      payload: { from: VoiceState.LISTENING, to: VoiceState.THINKING },
    });
    try {
      const task = await runTaskInBackground(trimmed);
      wakeWatchedTasks.add(task.id);
    } catch (err) {
      const { message } = asErrorCode(err);
      logger.error('wakeword.task', {
        result: 'failed to start',
        error: { code: 'WAKEWORD_TASK_FAILED', message },
      });
      untimedEmit(activity('VYRA could not start that task.', 'error', message));
      untimedEmit({
        type: 'voice.state',
        payload: { from: VoiceState.THINKING, to: VoiceState.IDLE },
      });
    }
  };

  const handleWakeEngineError = (message: string): void => {
    logger.error('wakeword.error', {
      result: 'listener error',
      error: { code: 'WAKEWORD_ERROR', message },
    });
    untimedEmit(activity('Wake word ran into a problem.', 'error', message));
    untimedEmit({
      type: 'voice.state',
      payload: { from: VoiceState.LISTENING, to: VoiceState.IDLE },
    });
  };

  const wakeEngine = new OpenWakeWordEngine({
    modelsDir: wakeModelsDir,
    phrase: readWakePhrase(),
    onCommand: (text) => {
      void handleWakeCommand(text);
    },
    onEngineError: handleWakeEngineError,
  });
  const wakeWordService = new WakeWordService({
    detector: wakeEngine,
    wakeWord: readWakePhrase(),
    enabled: settings.getSection('voice').wakeWordEnabled === true,
  });
  providers.register('wakeword', wakeWordService);

  /**
   * (Re)apply the voice settings to the wake-word listener. Safe to call
   * repeatedly: keeps a healthy listener running, restarts it when the
   * phrase changed, stops it when disabled. Failures are reported in the
   * activity feed and the log — never thrown, never silent.
   */
  const reapplyWakeWord = async (): Promise<void> => {
    const enabled = settings.getSection('voice').wakeWordEnabled === true;
    const phrase = readWakePhrase();
    const phraseChanged = wakeEngine.getPhrase() !== phrase;
    wakeWordService.setWakeWord(phrase);
    wakeWordService.setEnabled(enabled);
    wakeEngine.setPhrase(phrase);
    wakeEngine.setPythonPath(
      String(settings.getSection('voice').wakeWordPython ?? '').trim() || undefined,
    );
    const rawThreshold = Number(settings.getSection('voice').wakeWordThreshold);
    const thresholdChanged =
      Number.isFinite(rawThreshold) &&
      rawThreshold > 0 &&
      rawThreshold <= 1 &&
      wakeEngine.getThreshold() !== rawThreshold;
    if (thresholdChanged) wakeEngine.setThreshold(rawThreshold);
    if (!enabled) {
      await wakeWordService.stopListening().catch(() => {
        // Best-effort: disabling must never throw.
      });
      return;
    }
    if (wakeEngine.isRunning() && !phraseChanged && !thresholdChanged) return;
    if (wakeEngine.isRunning()) {
      await wakeWordService.stopListening().catch(() => {});
    }
    try {
      await wakeWordService.startListening(handleWake);
      logger.info('wakeword.start', { result: `listening for "${phrase}"` });
      untimedEmit(
        activity(`Wake word on — say "${phrase}" any time.`, 'info'),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('wakeword.start', {
        result: 'failed',
        error: { code: 'WAKEWORD_START_FAILED', message },
      });
      untimedEmit(
        activity('Wake word could not start.', 'warning', message),
      );
    }
  };

  // --- Memory ----------------------------------------------------------------
  // (created above so the Brain can read identity facts at startup)
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

    async wakeWordStart() {
      await reapplyWakeWord();
    },
    async wakeWordStop() {
      await wakeWordService.stopListening().catch(() => {
        // Best-effort: stopping must never throw.
      });
    },
    async wakeWordStatus() {
      const capability = await wakeWordService
        .checkAvailability()
        .catch(() => ({ available: false as const, reason: 'Unknown error.' }));
      return {
        enabled: wakeWordService.isEnabled(),
        listening: wakeWordService.isListening(),
        phrase: wakeWordService.getWakeWord(),
        engine: wakeWordService.getDetectorName(),
        available: capability.available,
        ...(!capability.available && capability.reason
          ? { reason: capability.reason }
          : {}),
      };
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

    async testGoogleConnection(apiKey: string, model?: string): Promise<GeminiConnectionResult> {
      // Dry-run only: validates the key + model against Google's live API
      // without saving anything. Powers the "Test Connection" button.
      // An explicit model overrides the automatic pick.
      return testGeminiConnection(apiKey.trim(), model ? { model } : undefined);
    },

    async chatSend(messages: ChatMessageInput[]): Promise<ChatReply> {
      // Conversational chat: straight to the selected AI provider, no task
      // engine, no tool-plan JSON. The lazy provider above guarantees the
      // selection from onboarding/Settings is honored immediately.
      const provider = providers.get<AIProvider>('ai') ?? new NoAiProvider();
      const capability = await provider.checkAvailability();
      if (!capability.available) {
        throw new Error(
          capability.reason ??
            'VYRA has no working AI provider right now. Connect your AI key to continue.',
        );
      }
      const history: ChatMessage[] = [
        {
          role: 'system',
          content:
            VYRA_CHAT_SYSTEM_PROMPT +
            (userFacts ? `\nFacts about the user (use them; never reveal them unprompted):\n${userFacts}` : ''),
        },
        ...messages.slice(-20).map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      ];
      let text: string;
      try {
        const response = await provider.chat(history, {
          temperature: 0.7,
          maxTokens: 1024,
        });
        text = response.text.trim();
      } catch (err) {
        const { message } = asErrorCode(err);
        throw new Error(message || 'VYRA could not reach the AI. Try again.');
      }
      if (!text) {
        throw new Error('VYRA came back with an empty reply. Try asking again.');
      }
      const savedModel = settings.getSection('models').defaultModel;
      const model =
        process.env.VYRA_AI_MODEL ||
        (typeof savedModel === 'string' ? savedModel : '') ||
        'unknown';
      logger.info('chat.send', { result: `model=${model} chars=${text.length}` });
      return { text, model };
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
          // REAL test: the key must be accepted by Google AND the resolved
          // model must actually generate text. Nothing is saved until both
          // pass — an untested key never becomes VYRA's brain.
          const preferred =
            typeof values.preferredModel === 'string' && values.preferredModel.length > 0
              ? values.preferredModel
              : undefined;
          const result = await testGeminiConnection(key, { model: preferred });
          if (!result.ok) {
            throw Object.assign(new Error(result.message), {
              code: 'GEMINI_' + result.code.toUpperCase().replace(/-/g, '_'),
            });
          }
          // The key works — keep it in the main process only (encrypted at
          // rest), remember the working model, and make Google VYRA's brain
          // and eyes.
          process.env.GOOGLE_GENERATIVE_AI_KEY = key;
          secretStore.set('GOOGLE_GENERATIVE_AI_KEY', key);
          process.env.VYRA_AI_MODEL = result.model;
          settings.setSection('models', { defaultModel: result.model });
          await services.selectProvider('ai', 'google');
          await services.selectProvider('vision', 'google');
          logger.info('onboarding.google-key', {
            result: `saved (verified live with model ${result.model})`,
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
