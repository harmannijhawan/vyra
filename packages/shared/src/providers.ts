/**
 * Provider contracts. Every provider is swappable: the rest of VYRA only
 * ever talks to these interfaces, never to a concrete SDK.
 *
 * Availability rule: probe() / checkAvailability() MUST return
 * { available: false, reason } — with an honest human-readable reason —
 * whenever the capability cannot run here (missing API key, unsupported
 * OS, no microphone, …). NEVER pretend an unavailable capability works.
 */

export interface ProviderCapability {
  available: boolean;
  /** Required when available === false. Shown in Settings and the UI. */
  reason?: string;
}

export interface BaseProvider {
  /** Stable id, e.g. "openai", "nutjs-computer", "playwright". */
  readonly id: string;
  readonly displayName: string;
  checkAvailability(): Promise<ProviderCapability>;
}

/* ------------------------------------------------------------------ */
/* AI (reasoning / planning)                                           */
/* ------------------------------------------------------------------ */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolResult?: unknown;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AIResponse {
  /** Assistant text (may be empty when only tool calls are returned). */
  text: string;
  toolCalls: ToolCallRequest[];
  /** Token usage when the provider reports it. */
  usage?: { promptTokens: number; completionTokens: number };
}

export interface AIProvider extends BaseProvider {
  chat(
    messages: ChatMessage[],
    opts?: {
      tools?: Array<{
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      }>;
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    },
  ): Promise<AIResponse>;
}

/* ------------------------------------------------------------------ */
/* Speech                                                             */
/* ------------------------------------------------------------------ */

export interface STTProvider extends BaseProvider {
  /**
   * Transcribe 16-bit PCM audio. Returns the transcript; an empty string
   * means "no speech detected" (not an error).
   */
  transcribe(audio: {
    pcm: Int16Array;
    sampleRate: number;
    channels: number;
  }): Promise<{ text: string; language?: string }>;
}

export interface TTSProvider extends BaseProvider {
  /**
   * Synthesize speech. Returns raw audio the voice service can play.
   * The returned `cancel` stops playback for interruptible speech.
   */
  speak(text: string, opts?: { voiceId?: string; rate?: number }): Promise<{
    pcm: Int16Array;
    sampleRate: number;
    cancel: () => void;
  }>;
  stop(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Vision                                                              */
/* ------------------------------------------------------------------ */

export interface UIElement {
  /** e.g. "button", "input", "link", "menu", "dialog", "tab", "icon". */
  kind: string;
  label?: string;
  /** Normalized 0–1000 coordinates relative to the screenshot. */
  x: number;
  y: number;
  width?: number;
  height?: number;
  confidence: number;
}

export interface ScreenAnalysis {
  description: string;
  elements: UIElement[];
  /** e.g. "loading", "error-dialog", "login-form", "idle". */
  screenState: string;
}

export interface VisionProvider extends BaseProvider {
  analyzeScreenshot(png: Buffer | Uint8Array): Promise<ScreenAnalysis>;
}

/* ------------------------------------------------------------------ */
/* Computer control                                                    */
/* ------------------------------------------------------------------ */

export interface Screenshot {
  /** PNG bytes. */
  png: Buffer;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: number | string;
  title: string;
  appName: string;
  focused: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface ProcessInfo {
  pid: number;
  name: string;
}

export type MouseButton = 'left' | 'right' | 'middle';

export interface ComputerProvider extends BaseProvider {
  screenshot(): Promise<Screenshot>;
  getCursorPosition(): Promise<{ x: number; y: number }>;
  move(x: number, y: number): Promise<void>;
  click(button?: MouseButton): Promise<void>;
  doubleClick(button?: MouseButton): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  type(text: string): Promise<void>;
  key(
    key: string,
    modifiers?: Array<'ctrl' | 'shift' | 'alt' | 'meta'>,
  ): Promise<void>;
  hotkey(keys: string[]): Promise<void>;
  /** Launch an application by name or path. Resolves when launched. */
  launchApp(app: string): Promise<void>;
  listWindows(): Promise<WindowInfo[]>;
  listProcesses(): Promise<ProcessInfo[]>;
}

/* ------------------------------------------------------------------ */
/* Browser                                                             */
/* ------------------------------------------------------------------ */

export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserProvider extends BaseProvider {
  /** Open the browser (or attach to a running instance). */
  open(opts?: { headless?: boolean }): Promise<void>;
  close(): Promise<void>;
  newTab(url?: string): Promise<BrowserTabInfo>;
  listTabs(): Promise<BrowserTabInfo[]>;
  activateTab(id: string): Promise<void>;
  closeTab(id: string): Promise<void>;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  reload(): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string, opts?: { clear?: boolean }): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(opts?: {
    x?: number;
    y?: number;
    selector?: string;
  }): Promise<void>;
  /** Visible text + a compact structural summary of the page. */
  read(): Promise<{ title: string; url: string; text: string }>;
  screenshot(): Promise<Screenshot>;
  /**
   * Wait until the page reaches the given state or the timeout elapses.
   * Returns true when the state was reached.
   */
  waitFor(
    state: 'load' | 'domcontentloaded' | 'networkidle',
    timeoutMs?: number,
  ): Promise<boolean>;
  /** Wait for a selector to appear. Returns true when found in time. */
  waitForSelector(selector: string, timeoutMs?: number): Promise<boolean>;
}

/* ------------------------------------------------------------------ */
/* Wake word                                                           */
/* ------------------------------------------------------------------ */

export interface WakeWordProvider extends BaseProvider {
  /** Begin listening for the wake word. Resolves when detected. */
  startListening(onWake: () => void): Promise<void>;
  stopListening(): Promise<void>;
  setWakeWord(phrase: string): void;
}

/* ------------------------------------------------------------------ */
/* Provider registry                                                   */
/* ------------------------------------------------------------------ */

export type ProviderKind =
  | 'ai'
  | 'stt'
  | 'tts'
  | 'vision'
  | 'computer'
  | 'browser'
  | 'wakeword';

export interface ProviderRegistry {
  register(kind: ProviderKind, provider: BaseProvider): void;
  get<T extends BaseProvider>(kind: ProviderKind, id?: string): T | undefined;
  list(kind: ProviderKind): BaseProvider[];
  /** Currently selected provider id per kind (from settings/env). */
  selected(kind: ProviderKind): string | undefined;
  select(kind: ProviderKind, id: string): void;
  /** Probe every registered provider; honest availability report. */
  probeAll(): Promise<
    Record<string, { id: string; available: boolean; reason?: string }>
  >;
}
