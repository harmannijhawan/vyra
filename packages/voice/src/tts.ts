/**
 * Text-to-speech. A registry of real TTSProvider adapters; the active one is
 * selected via the VYRA_TTS_PROVIDER environment variable (default "openai").
 *
 * Interruptible speech: speak() returns { pcm, sampleRate, cancel } and the
 * service keeps the in-flight synthesis so stop() — or a new speak() — can
 * cancel it. Same honesty rule as STT: no key, no speech, no pretending.
 */
import type {
  ProviderCapability,
  TTSProvider,
} from '@vyra/shared';
import { decodeWav } from './wav.js';

export interface SpeechResult {
  pcm: Int16Array;
  sampleRate: number;
  cancel: () => void;
}

export interface SpeakOptions {
  voiceId?: string;
  rate?: number;
}

function missingKey(envVar: string, providerName: string): ProviderCapability {
  return {
    available: false,
    reason:
      `${providerName}: ${envVar} is not set. ` +
      'Set it in your environment (or switch VYRA_TTS_PROVIDER to a ' +
      'configured provider) to enable speech synthesis.',
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ------------------------------------------------------------------ */
/* OpenAI TTS                                                          */
/* ------------------------------------------------------------------ */

export class OpenAITTS implements TTSProvider {
  readonly id = 'openai';
  readonly displayName = 'OpenAI TTS';
  private inFlight = new Set<AbortController>();

  async checkAvailability(): Promise<ProviderCapability> {
    if (!process.env.OPENAI_API_KEY) {
      return missingKey('OPENAI_API_KEY', this.displayName);
    }
    return { available: true };
  }

  async speak(text: string, opts?: SpeakOptions): Promise<SpeechResult> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('[VYRA TTS] OPENAI_API_KEY is not set — cannot synthesize speech.');
    }
    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: opts?.voiceId ?? 'alloy',
          response_format: 'wav',
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `[VYRA TTS] OpenAI synthesis failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
        );
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const { pcm, sampleRate } = decodeWav(bytes);
      return {
        pcm,
        sampleRate,
        cancel: () => controller.abort(),
      };
    } finally {
      this.inFlight.delete(controller);
    }
  }

  async stop(): Promise<void> {
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
  }
}

/* ------------------------------------------------------------------ */
/* ElevenLabs                                                          */
/* ------------------------------------------------------------------ */

const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // ElevenLabs "Rachel"

export class ElevenLabsTTS implements TTSProvider {
  readonly id = 'elevenlabs';
  readonly displayName = 'ElevenLabs';
  private inFlight = new Set<AbortController>();

  async checkAvailability(): Promise<ProviderCapability> {
    if (!process.env.ELEVENLABS_API_KEY) {
      return missingKey('ELEVENLABS_API_KEY', this.displayName);
    }
    return { available: true };
  }

  async speak(text: string, opts?: SpeakOptions): Promise<SpeechResult> {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) {
      throw new Error('[VYRA TTS] ELEVENLABS_API_KEY is not set — cannot synthesize speech.');
    }
    const voiceId = opts?.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? ELEVENLABS_DEFAULT_VOICE;
    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      // output_format=pcm_16000 → raw 16-bit PCM @16kHz, no decoder needed.
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_16000`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'xi-api-key': key,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_multilingual_v2',
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `[VYRA TTS] ElevenLabs synthesis failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
        );
      }
      const raw = new Uint8Array(await res.arrayBuffer());
      const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
      return {
        pcm: pcm.slice(),
        sampleRate: 16000,
        cancel: () => controller.abort(),
      };
    } finally {
      this.inFlight.delete(controller);
    }
  }

  async stop(): Promise<void> {
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Azure Speech                                                        */
/* ------------------------------------------------------------------ */

export class AzureTTS implements TTSProvider {
  readonly id = 'azure';
  readonly displayName = 'Azure Speech';
  private inFlight = new Set<AbortController>();

  async checkAvailability(): Promise<ProviderCapability> {
    if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
      const missing = [
        !process.env.AZURE_SPEECH_KEY ? 'AZURE_SPEECH_KEY' : null,
        !process.env.AZURE_SPEECH_REGION ? 'AZURE_SPEECH_REGION' : null,
      ].filter(Boolean).join(' and ');
      return {
        available: false,
        reason:
          `${this.displayName}: ${missing} not set. ` +
          'Set both in your environment (or switch VYRA_TTS_PROVIDER) to enable speech synthesis.',
      };
    }
    return { available: true };
  }

  async speak(text: string, opts?: SpeakOptions): Promise<SpeechResult> {
    const key = process.env.AZURE_SPEECH_KEY;
    const region = process.env.AZURE_SPEECH_REGION;
    if (!key || !region) {
      throw new Error(
        '[VYRA TTS] AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must both be set — cannot synthesize speech.',
      );
    }
    const voice = opts?.voiceId ?? 'en-US-AriaNeural';
    const ssml =
      `<speak version='1.0' xml:lang='en-US'>` +
      `<voice xml:lang='en-US' name='${escapeXml(voice)}'>${escapeXml(text)}</voice></speak>`;
    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      const res = await fetch(
        `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Ocp-Apim-Subscription-Key': key,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'riff-16khz-16bit-mono-pcm',
            'User-Agent': 'VYRA',
          },
          body: ssml,
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `[VYRA TTS] Azure synthesis failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
        );
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const { pcm, sampleRate } = decodeWav(bytes);
      return {
        pcm,
        sampleRate,
        cancel: () => controller.abort(),
      };
    } finally {
      this.inFlight.delete(controller);
    }
  }

  async stop(): Promise<void> {
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
  }
}

/* ------------------------------------------------------------------ */
/* System TTS (not implemented — honest placeholder)                   */
/* ------------------------------------------------------------------ */

/**
 * The app layer will wire a platform engine here (SAPI on Windows).
 * This adapter exists so the registry has a stable "system" id, but it
 * reports unavailable rather than faking speech.
 */
export class SystemTTS implements TTSProvider {
  readonly id = 'system';
  readonly displayName = 'System Speech';

  async checkAvailability(): Promise<ProviderCapability> {
    return {
      available: false,
      reason:
        'No system speech engine is wired up yet. On Windows this will use ' +
        'SAPI via the desktop app layer; no TTS runs from this package.',
    };
  }

  async speak(_text: string, _opts?: SpeakOptions): Promise<SpeechResult> {
    throw new Error('[VYRA TTS] System speech engine is not implemented.');
  }

  async stop(): Promise<void> {
    // Nothing in flight — nothing to stop.
  }
}

/* ------------------------------------------------------------------ */
/* Service (registry + selection + interruption)                       */
/* ------------------------------------------------------------------ */

/**
 * Thrown when a speak() is superseded by a newer speak() or by stop().
 * Callers treat this as a normal control-flow signal, not a failure:
 * the interrupting call already owns the state machine.
 */
export class SpeechInterruptedError extends Error {
  constructor() {
    super('[VYRA TTS] Speech was interrupted.');
    this.name = 'SpeechInterruptedError';
  }
}

export class TTSService {
  private readonly providers = new Map<string, TTSProvider>();
  private selectedId: string;
  private currentCancel: (() => void) | null = null;
  /**
   * Monotonic generation counter. Every speak() and stop() claims a new
   * generation, so a speak() that was superseded mid-flight (even before
   * the provider's speak() was invoked) aborts instead of racing the
   * interrupting call.
   */
  private speechGeneration = 0;

  constructor() {
    this.register(new OpenAITTS());
    this.register(new ElevenLabsTTS());
    this.register(new AzureTTS());
    this.register(new SystemTTS());
    this.selectedId = process.env.VYRA_TTS_PROVIDER?.trim() || 'openai';
  }

  register(provider: TTSProvider): void {
    this.providers.set(provider.id, provider);
  }

  list(): TTSProvider[] {
    return [...this.providers.values()];
  }

  getSelectedId(): string {
    return this.selectedId;
  }

  select(id: string): void {
    if (!this.providers.has(id)) {
      throw new Error(`[VYRA TTS] Unknown TTS provider id: "${id}".`);
    }
    this.selectedId = id;
  }

  getSelected(): TTSProvider | undefined {
    return this.providers.get(this.selectedId);
  }

  async checkAvailability(): Promise<ProviderCapability & { providerId: string }> {
    const provider = this.providers.get(this.selectedId);
    if (!provider) {
      return {
        providerId: this.selectedId,
        available: false,
        reason: `TTS provider "${this.selectedId}" is not registered.`,
      };
    }
    return { providerId: provider.id, ...(await provider.checkAvailability()) };
  }

  /**
   * Synthesize text. Interrupts any in-flight synthesis first
  /**
   * Synthesize text. Interrupts any in-flight synthesis first
   * (interruptible speech): a superseded speak() throws
   * SpeechInterruptedError instead of racing the new utterance.
   * Empty text resolves immediately with empty PCM.
   */
  async speak(text: string, opts?: SpeakOptions): Promise<SpeechResult> {
    const myGeneration = ++this.speechGeneration;
    const ensureCurrent = (): void => {
      if (myGeneration !== this.speechGeneration) {
        throw new SpeechInterruptedError();
      }
    };

    this.cancelCurrent();
    await this.stopSelectedProvider();

    if (text.trim().length === 0) {
      return { pcm: new Int16Array(0), sampleRate: 16000, cancel: () => undefined };
    }
    const provider = this.providers.get(this.selectedId);
    if (!provider) {
      throw new Error(
        `[VYRA TTS] No TTS provider is registered for id "${this.selectedId}".`,
      );
    }
    const capability = await provider.checkAvailability();
    ensureCurrent();
    if (!capability.available) {
      throw new Error(
        `[VYRA TTS] Refusing to synthesize: ${provider.displayName} is unavailable ` +
          `(${capability.reason ?? 'no reason given'}). ` +
          'Configure a TTS provider instead of accepting fake audio.',
      );
    }
    let result: { pcm: Int16Array; sampleRate: number; cancel: () => void };
    try {
      result = await provider.speak(text, opts);
    } catch (err) {
      // A provider-level abort caused by our own stop() surfaces as the
      // provider's error (e.g. AbortError) — translate it when superseded.
      ensureCurrent();
      throw err;
    }
    ensureCurrent();
    const cancel = () => {
      result.cancel();
      if (this.currentCancel === cancel) this.currentCancel = null;
    };
    this.currentCancel = cancel;
    return { pcm: result.pcm, sampleRate: result.sampleRate, cancel };
  }

  /** Cancel in-flight synthesis (barge-in / interruption). */
  async stop(): Promise<void> {
    this.speechGeneration++;
    this.cancelCurrent();
    await this.stopSelectedProvider();
  }

  private cancelCurrent(): void {
    const cancel = this.currentCancel;
    this.currentCancel = null;
    try {
      cancel?.();
    } catch {
      // Best-effort: a failing cancel must not break interruption.
    }
  }

  private async stopSelectedProvider(): Promise<void> {
    const provider = this.providers.get(this.selectedId);
    if (provider) {
      await provider.stop().catch(() => {
        // Best-effort: a failing stop must not break interruption.
      });
    }
  }
}
