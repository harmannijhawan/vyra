/**
 * Speech-to-text. A registry of real STTProvider adapters; the active one is
 * selected via the VYRA_STT_PROVIDER environment variable (default
 * "openai-whisper").
 *
 * Honesty rule: if no API key is configured, checkAvailability() reports
 * { available: false, reason } and transcribe() throws — it NEVER invents a
 * transcript. Empty audio resolves to { text: "" } (no speech), not an error.
 */
import type {
  ProviderCapability,
  STTProvider,
} from '@vyra/shared';
import { encodeWav } from './wav.js';

export interface AudioInput {
  pcm: Int16Array;
  sampleRate: number;
  channels: number;
}

export interface Transcript {
  text: string;
  language?: string;
}

function missingKey(envVar: string, providerName: string): ProviderCapability {
  return {
    available: false,
    reason:
      `${providerName}: ${envVar} is not set. ` +
      'Set it in your environment (or switch VYRA_STT_PROVIDER to a ' +
      'configured provider) to enable speech recognition.',
  };
}

/* ------------------------------------------------------------------ */
/* OpenAI Whisper                                                      */
/* ------------------------------------------------------------------ */

export class OpenAIWhisperSTT implements STTProvider {
  readonly id = 'openai-whisper';
  readonly displayName = 'OpenAI Whisper';

  async checkAvailability(): Promise<ProviderCapability> {
    if (!process.env.OPENAI_API_KEY) {
      return missingKey('OPENAI_API_KEY', this.displayName);
    }
    return { available: true };
  }

  async transcribe(audio: AudioInput): Promise<Transcript> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('[VYRA STT] OPENAI_API_KEY is not set — cannot transcribe.');
    }
    const wav = encodeWav(audio.pcm, audio.sampleRate, audio.channels);
    const form = new FormData();
    // Node 20+ Blob accepts Uint8Array parts.
    form.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', 'whisper-1');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `[VYRA STT] OpenAI transcription failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as { text?: string };
    return { text: json.text ?? '' };
  }
}

/* ------------------------------------------------------------------ */
/* Deepgram                                                            */
/* ------------------------------------------------------------------ */

export class DeepgramSTT implements STTProvider {
  readonly id = 'deepgram';
  readonly displayName = 'Deepgram';

  async checkAvailability(): Promise<ProviderCapability> {
    if (!process.env.DEEPGRAM_API_KEY) {
      return missingKey('DEEPGRAM_API_KEY', this.displayName);
    }
    return { available: true };
  }

  async transcribe(audio: AudioInput): Promise<Transcript> {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) {
      throw new Error('[VYRA STT] DEEPGRAM_API_KEY is not set — cannot transcribe.');
    }
    const wav = encodeWav(audio.pcm, audio.sampleRate, audio.channels);
    const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&detect_language=true', {
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': 'audio/wav',
      },
      body: wav as BodyInit,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `[VYRA STT] Deepgram transcription failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as {
      results?: {
        channels?: Array<{
          detected_language?: string;
          alternatives?: Array<{ transcript?: string }>;
        }>;
      };
    };
    const channel = json.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];
    return {
      text: alternative?.transcript ?? '',
      language: channel?.detected_language,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Azure Speech-to-Text                                                */
/* ------------------------------------------------------------------ */

export class AzureSTT implements STTProvider {
  readonly id = 'azure';
  readonly displayName = 'Azure Speech';

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
          'Set both in your environment (or switch VYRA_STT_PROVIDER) to enable speech recognition.',
      };
    }
    return { available: true };
  }

  async transcribe(audio: AudioInput): Promise<Transcript> {
    const key = process.env.AZURE_SPEECH_KEY;
    const region = process.env.AZURE_SPEECH_REGION;
    if (!key || !region) {
      throw new Error(
        '[VYRA STT] AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must both be set — cannot transcribe.',
      );
    }
    const wav = encodeWav(audio.pcm, audio.sampleRate, audio.channels);
    const url =
      `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/` +
      'cognitiveservices/v1?language=en-US';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
      },
      body: wav as BodyInit,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `[VYRA STT] Azure transcription failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as { DisplayText?: string };
    return { text: json.DisplayText ?? '' };
  }
}

/* ------------------------------------------------------------------ */
/* Service (registry + selection)                                      */
/* ------------------------------------------------------------------ */

export class STTService {
  private readonly providers = new Map<string, STTProvider>();
  private selectedId: string;

  constructor() {
    this.register(new OpenAIWhisperSTT());
    this.register(new DeepgramSTT());
    this.register(new AzureSTT());
    this.selectedId = process.env.VYRA_STT_PROVIDER?.trim() || 'openai-whisper';
  }

  register(provider: STTProvider): void {
    this.providers.set(provider.id, provider);
  }

  list(): STTProvider[] {
    return [...this.providers.values()];
  }

  getSelectedId(): string {
    return this.selectedId;
  }

  select(id: string): void {
    if (!this.providers.has(id)) {
      throw new Error(`[VYRA STT] Unknown STT provider id: "${id}".`);
    }
    this.selectedId = id;
  }

  getSelected(): STTProvider | undefined {
    return this.providers.get(this.selectedId);
  }

  async checkAvailability(): Promise<ProviderCapability & { providerId: string }> {
    const provider = this.providers.get(this.selectedId);
    if (!provider) {
      return {
        providerId: this.selectedId,
        available: false,
        reason: `STT provider "${this.selectedId}" is not registered.`,
      };
    }
    return { providerId: provider.id, ...(await provider.checkAvailability()) };
  }

  /**
   * Transcribe captured audio. Empty audio resolves to { text: "" }.
   * Throws an honest error when no provider is available — never a
   * fabricated transcript.
   */
  async transcribe(audio: AudioInput): Promise<Transcript> {
    if (audio.pcm.length === 0) {
      return { text: '' };
    }
    const provider = this.providers.get(this.selectedId);
    if (!provider) {
      throw new Error(
        `[VYRA STT] No STT provider is registered for id "${this.selectedId}".`,
      );
    }
    const capability = await provider.checkAvailability();
    if (!capability.available) {
      throw new Error(
        `[VYRA STT] Refusing to transcribe: ${provider.displayName} is unavailable ` +
          `(${capability.reason ?? 'no reason given'}). ` +
          'Configure an STT provider instead of accepting a fake transcript.',
      );
    }
    return provider.transcribe(audio);
  }
}
