/**
 * Wake-word handling for VYRA.
 *
 * Architecture: detection is pluggable. Ship NO fake detector — the service
 * only reports "available" when a real WakeWordDetector has been plugged in
 * (e.g. an on-device model wired by the desktop app layer). With no detector
 * configured, checkAvailability() returns an honest { available: false }.
 *
 * Privacy controls: the service tracks an enabled flag, a mic-active
 * (listening) indicator state, and exposes getPrivacyState() so the UI can
 * always show exactly what the microphone is doing.
 *
 * Hotkey fallback: registerHotkey() goes through a HotkeyRegistrar
 * abstraction. Electron's globalShortcut is wired by the app layer; the
 * Node fallback here reports unavailable instead of pretending to work.
 */
import type {
  ProviderCapability,
  WakeWordProvider,
} from '@vyra/shared';

/** Pluggable wake-word detector. The app layer provides a real engine. */
export interface WakeWordDetector {
  readonly name: string;
  /** Begin detection; call onDetect each time the wake word is heard. */
  start(onDetect: () => void): Promise<void>;
  stop(): Promise<void>;
}

/** Hotkey registration abstraction (Electron globalShortcut in the app). */
export interface HotkeyRegistrar {
  readonly isAvailable: boolean;
  /** Returns true when the hotkey was actually registered. */
  register(accelerator: string, handler: () => void): boolean;
  unregister(accelerator: string): void;
}

/** Node fallback: no global hotkeys here — reports unavailable honestly. */
export class NodeHotkeyRegistrar implements HotkeyRegistrar {
  readonly isAvailable = false;

  register(_accelerator: string, _handler: () => void): boolean {
    // Outside Electron there is no globalShortcut. The desktop app layer
    // injects a registrar that wraps Electron's globalShortcut.
    return false;
  }

  unregister(_accelerator: string): void {
    // No-op: nothing was ever registered.
  }
}

export interface WakeWordPrivacyState {
  /** The microphone is currently being sampled for the wake word. */
  listening: boolean;
  /** Wake-word detection is enabled in settings. */
  wakeWordEnabled: boolean;
}

export interface WakeWordServiceOptions {
  detector?: WakeWordDetector | null;
  hotkeyRegistrar?: HotkeyRegistrar;
  wakeWord?: string;
  enabled?: boolean;
}

export class WakeWordService implements WakeWordProvider {
  readonly id = 'wakeword';
  readonly displayName = 'VYRA Wake Word';

  private detector: WakeWordDetector | null;
  private hotkeyRegistrar: HotkeyRegistrar;
  private wakeWord: string;
  private enabled: boolean;
  private listening = false;

  constructor(options: WakeWordServiceOptions = {}) {
    this.detector = options.detector ?? null;
    this.hotkeyRegistrar = options.hotkeyRegistrar ?? new NodeHotkeyRegistrar();
    this.wakeWord = (options.wakeWord ?? 'hey vyra').trim().toLowerCase();
    this.enabled = options.enabled ?? true;
  }

  /** Plug in (or swap out) the detection engine at runtime. */
  setDetector(detector: WakeWordDetector | null): void {
    this.detector = detector;
    if (!detector) {
      this.listening = false;
    }
  }

  getDetectorName(): string | null {
    return this.detector?.name ?? null;
  }

  setWakeWord(phrase: string): void {
    const normalized = phrase.trim().toLowerCase();
    if (!normalized) {
      throw new Error('[VYRA wake-word] Wake word must not be empty.');
    }
    this.wakeWord = normalized;
  }

  getWakeWord(): string {
    return this.wakeWord;
  }

  /** Master privacy switch. Disabling stops any active listening. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.listening) {
      void this.stopListening();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isListening(): boolean {
    return this.listening;
  }

  /** Privacy state for the mic indicator in the UI. */
  getPrivacyState(): WakeWordPrivacyState {
    return { listening: this.listening, wakeWordEnabled: this.enabled };
  }

  async checkAvailability(): Promise<ProviderCapability> {
    if (!this.detector) {
      return {
        available: false,
        reason:
          'No wake-word engine configured. Plug a WakeWordDetector (e.g. an ' +
          'on-device model) into WakeWordService to enable always-on listening.',
      };
    }
    if (!this.enabled) {
      return {
        available: false,
        reason: 'Wake word is disabled in settings.',
      };
    }
    return { available: true };
  }

  async startListening(onWake: () => void): Promise<void> {
    const capability = await this.checkAvailability();
    if (!capability.available || !this.detector) {
      throw new Error(`[VYRA wake-word] Cannot listen: ${capability.reason ?? 'unavailable'}.`);
    }
    const detector = this.detector;
    await detector.start(() => {
      // Never fire while the privacy switch is off, even if the engine
      // delivers a late detection.
      if (this.enabled) onWake();
    });
    this.listening = true;
  }

  async stopListening(): Promise<void> {
    if (this.detector) {
      await this.detector.stop().catch(() => {
        // Best-effort: stopping must not throw when the engine is gone.
      });
    }
    this.listening = false;
  }

  /**
   * Push-to-talk hotkey fallback. Returns true only when the hotkey was
   * really registered; outside Electron this reports unavailable.
   */
  registerHotkey(accelerator: string, onWake: () => void): boolean {
    if (!this.hotkeyRegistrar.isAvailable) return false;
    return this.hotkeyRegistrar.register(accelerator, onWake);
  }

  unregisterHotkey(accelerator: string): void {
    this.hotkeyRegistrar.unregister(accelerator);
  }
}
