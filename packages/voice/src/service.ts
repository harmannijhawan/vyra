/**
 * VoiceService — orchestrates the full voice loop for VYRA:
 *
 *   push-to-talk or VAD-driven capture → STT → (app responds) → TTS
 *
 * It owns the VoiceState machine and emits 'voice.state' AgentEvents plus
 * activity-feed lines rendered from VOICE_STATE_PHRASES, so the orb, status
 * line and spoken feedback all stay in sync. States are only ever emitted
 * when the underlying transition really happens.
 */
import {
  VoiceState,
  VOICE_STATE_PHRASES,
  activity,
  type AgentEvent,
} from '@vyra/shared';
import { STTService, type AudioInput } from './stt.js';
import { TTSService, SpeechInterruptedError } from './tts.js';
import { VoiceActivityDetector, type VadDecision } from './vad.js';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface VoiceServiceOptions {
  stt: STTService;
  tts: TTSService;
  /** Optional VAD for automatic end-of-utterance detection. */
  vad?: VoiceActivityDetector | null;
  /** Sample rate of audio fed via feedAudio(). Default 16000. */
  sampleRate?: number;
  /** Max conversation turns kept in memory. Default 20. */
  historyLimit?: number;
  /** Sink for AgentEvents ('voice.state' + activity lines). */
  emit?: (event: AgentEvent) => void;
  /**
   * Produces the assistant's reply text for a completed user utterance.
   * The app layer wires this to the agent brain; the default echoes nothing
   * (returns an empty string, so nothing is spoken).
   */
  respond?: (turn: ConversationTurn, history: ConversationTurn[]) => Promise<string> | string;
}

export class VoiceService {
  private readonly stt: STTService;
  private readonly tts: TTSService;
  private readonly vad: VoiceActivityDetector | null;
  private readonly sampleRate: number;
  private readonly historyLimit: number;
  private readonly emitFn?: (event: AgentEvent) => void;
  private readonly respondFn: NonNullable<VoiceServiceOptions['respond']>;

  private state: VoiceState = VoiceState.IDLE;
  private readonly listeners = new Set<(state: VoiceState) => void>();
  private readonly history: ConversationTurn[] = [];
  private audioBuffer: Int16Array[] = [];
  private audioSampleCount = 0;
  private sawSpeech = false;

  constructor(options: VoiceServiceOptions) {
    this.stt = options.stt;
    this.tts = options.tts;
    this.vad = options.vad ?? null;
    this.sampleRate = options.sampleRate ?? 16000;
    this.historyLimit = options.historyLimit ?? 20;
    this.emitFn = options.emit;
    this.respondFn = options.respond ?? (() => '');

    if (this.vad) {
      this.vad.setCallbacks({
        onSpeechStart: () => {
          this.sawSpeech = true;
        },
        onSpeechEnd: () => {
          // Auto-stop only after speech was actually heard (never on
          // leading silence) and only while still capturing.
          if (this.sawSpeech && this.state === VoiceState.LISTENING) {
            void this.stopUtterance();
          }
        },
      });
    }
  }

  /* ---------------- state machine ---------------- */

  getState(): VoiceState {
    return this.state;
  }

  onStateChange(listener: (state: VoiceState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(to: VoiceState): void {
    if (to === this.state) return;
    const from = this.state;
    this.state = to;
    const timestamp = new Date().toISOString();
    this.emitFn?.({
      type: 'voice.state',
      timestamp,
      payload: { from, to },
    });
    // Activity-feed line in VYRA's product language.
    this.emitFn?.(activity(VOICE_STATE_PHRASES[to], to === VoiceState.ERROR ? 'error' : 'info'));
    for (const listener of this.listeners) {
      try {
        listener(to);
      } catch {
        // A listener must never break the state machine.
      }
    }
  }

  /* ---------------- capture ---------------- */

  /**
   * Begin a push-to-talk utterance. If VYRA is currently speaking, the
   * in-flight speech is interrupted first (barge-in).
   */
  async startUtterance(): Promise<void> {
    if (this.state === VoiceState.LISTENING) return;
    if (this.state === VoiceState.SPEAKING) {
      await this.interrupt();
    }
    if (this.state !== VoiceState.IDLE) {
      throw new Error(
        `[VYRA voice] Cannot start an utterance while ${this.state}.`,
      );
    }
    this.audioBuffer = [];
    this.audioSampleCount = 0;
    this.sawSpeech = false;
    this.vad?.reset();
    this.setState(VoiceState.LISTENING);
  }

  /**
   * Feed one frame of 16-bit PCM (ideally matching the VAD frame length).
   * Returns the VAD decision when a VAD is configured.
   */
  feedAudio(pcm: Int16Array): VadDecision | null {
    if (this.state !== VoiceState.LISTENING) return null;
    this.audioBuffer.push(pcm.slice());
    this.audioSampleCount += pcm.length;
    if (!this.vad) return null;
    return this.vad.processFrame(pcm);
  }

  /** End the current utterance: transcribe → respond → speak. */
  async stopUtterance(): Promise<void> {
    if (this.state !== VoiceState.LISTENING) return;
    this.setState(VoiceState.THINKING);

    const pcm = new Int16Array(this.audioSampleCount);
    let offset = 0;
    for (const chunk of this.audioBuffer) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    this.audioBuffer = [];
    this.audioSampleCount = 0;

    try {
      const audio: AudioInput = { pcm, sampleRate: this.sampleRate, channels: 1 };
      const transcript = await this.stt.transcribe(audio);
      const text = transcript.text.trim();
      if (!text) {
        // Nothing was said — back to idle without a state charade.
        this.setState(VoiceState.IDLE);
        return;
      }
      const userTurn: ConversationTurn = {
        role: 'user',
        text,
        timestamp: new Date().toISOString(),
      };
      this.pushTurn(userTurn);

      const reply = await this.respondFn(userTurn, this.getHistory());
      await this.speakReply(reply);
    } catch (err) {
      this.setState(VoiceState.ERROR);
      this.emitFn?.(
        activity(
          'VYRA ran into a problem.',
          'error',
          err instanceof Error ? err.message : String(err),
        ),
      );
      this.setState(VoiceState.IDLE);
      throw err;
    }
  }

  /** Cancel capture or in-flight speech and return to idle. */
  async interrupt(): Promise<void> {
    if (this.state === VoiceState.LISTENING) {
      this.audioBuffer = [];
      this.audioSampleCount = 0;
    }
    if (this.state === VoiceState.SPEAKING) {
      await this.tts.stop();
    }
    if (this.state !== VoiceState.IDLE) {
      this.setState(VoiceState.IDLE);
    }
  }

  /* ---------------- speech output ---------------- */

  /** Speak assistant text (interrupts previous speech). Emits SPEAKING→IDLE. */
  async speakReply(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      this.setState(VoiceState.IDLE);
      return;
    }
    this.setState(VoiceState.SPEAKING);
    try {
      await this.tts.speak(trimmed);
    } catch (err) {
      if (err instanceof SpeechInterruptedError) {
        // A newer utterance or an explicit interrupt() took over; it owns
        // the state machine now. Not a failure — stay silent about it.
        return;
      }
      this.setState(VoiceState.ERROR);
      this.emitFn?.(
        activity(
          'VYRA ran into a problem.',
          'error',
          err instanceof Error ? err.message : String(err),
        ),
      );
      this.setState(VoiceState.IDLE);
      throw err;
    }
    // The PCM is handed to the app layer for playback; SPEAKING reflects
    // that real synthesis happened (the provider threw otherwise).
    this.pushTurn({
      role: 'assistant',
      text: trimmed,
      timestamp: new Date().toISOString(),
    });
    this.setState(VoiceState.IDLE);
  }

  /* ---------------- conversation history ---------------- */

  private pushTurn(turn: ConversationTurn): void {
    this.history.push(turn);
    while (this.history.length > this.historyLimit) {
      this.history.shift();
    }
  }

  getHistory(): ConversationTurn[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history.length = 0;
  }
}
