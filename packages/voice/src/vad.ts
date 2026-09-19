/**
 * Energy-based voice activity detection (VAD).
 *
 * A REAL algorithm, not a stub: each frame's RMS energy (in dBFS) is compared
 * against an adaptive noise floor that tracks the room tone with a slow
 * exponential moving average. Frames louder than `floor + thresholdDb` count
 * as speech; a hangover window keeps the decision at "speech" briefly after
 * the energy drops so word endings aren't clipped.
 *
 * Upgrade path: a neural VAD (Silero, WebRTC-style gating, …) can replace
 * this class as long as it keeps the same interface — processFrame() plus
 * the speech-start / speech-end callbacks.
 */

export type VadDecision = 'speech' | 'silence';

export interface VadOptions {
  /** Input sample rate in Hz, e.g. 16000. */
  sampleRate: number;
  /** Frame length in milliseconds. Default 20. */
  frameMs?: number;
  /** dB above the adaptive noise floor required to count as speech. Default 12. */
  thresholdDb?: number;
  /** How long (ms) to hold "speech" after energy drops. Default 200. */
  hangoverMs?: number;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
}

const MIN_DB = -90; // floor for log math, avoids -Infinity on digital silence

export class VoiceActivityDetector {
  private readonly frameSamples: number;
  private readonly frameMs: number;
  private readonly thresholdDb: number;
  private readonly hangoverFrames: number;

  private noiseFloorDb = MIN_DB;
  private silenceFramesSinceSpeech = Number.POSITIVE_INFINITY;
  private inSpeech = false;
  private onSpeechStart: (() => void) | undefined;
  private onSpeechEnd: (() => void) | undefined;

  constructor(options: VadOptions) {
    if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0) {
      throw new Error('[VYRA VAD] sampleRate must be a positive number.');
    }
    this.frameMs = options.frameMs ?? 20;
    this.frameSamples = Math.max(1, Math.round((options.sampleRate * this.frameMs) / 1000));
    this.thresholdDb = options.thresholdDb ?? 12;
    const hangoverMs = options.hangoverMs ?? 200;
    this.hangoverFrames = Math.max(0, Math.round(hangoverMs / this.frameMs));
    this.onSpeechStart = options.onSpeechStart;
    this.onSpeechEnd = options.onSpeechEnd;
  }

  /** Replace the speech-start / speech-end callbacks (used by VoiceService). */
  setCallbacks(callbacks: {
    onSpeechStart?: () => void;
    onSpeechEnd?: () => void;
  }): void {
    this.onSpeechStart = callbacks.onSpeechStart;
    this.onSpeechEnd = callbacks.onSpeechEnd;
  }

  expectedFrameSamples(): number {
    return this.frameSamples;
  }

  /** Current adaptive noise-floor estimate, in dBFS. */
  getNoiseFloorDb(): number {
    return this.noiseFloorDb;
  }

  reset(): void {
    this.noiseFloorDb = MIN_DB;
    this.silenceFramesSinceSpeech = Number.POSITIVE_INFINITY;
    this.inSpeech = false;
  }

  /**
   * Classify one frame of 16-bit PCM (ideally `frameMs` long) as
   * 'speech' or 'silence'. Fires onSpeechStart/onSpeechEnd on transitions.
   */
  processFrame(pcm: Int16Array): VadDecision {
    const levelDb = rmsDb(pcm);

    const isLoud = levelDb > this.noiseFloorDb + this.thresholdDb;

    // Adapt the noise floor only on quiet frames: track downward quickly
    // (new quieter room tone) and drift upward very slowly (avoid learning
    // sustained speech as "noise").
    if (!isLoud) {
      const rate = levelDb < this.noiseFloorDb ? 0.2 : 0.01;
      this.noiseFloorDb += (levelDb - this.noiseFloorDb) * rate;
      if (this.noiseFloorDb < MIN_DB) this.noiseFloorDb = MIN_DB;
    }

    if (isLoud) {
      this.silenceFramesSinceSpeech = 0;
    } else if (this.silenceFramesSinceSpeech !== Number.POSITIVE_INFINITY) {
      this.silenceFramesSinceSpeech += 1;
    }

    const withinHangover =
      this.silenceFramesSinceSpeech <= this.hangoverFrames;
    const decision: VadDecision =
      isLoud || withinHangover ? 'speech' : 'silence';

    if (decision === 'speech' && !this.inSpeech) {
      this.inSpeech = true;
      this.onSpeechStart?.();
    } else if (decision === 'silence' && this.inSpeech) {
      this.inSpeech = false;
      this.onSpeechEnd?.();
    }

    return decision;
  }
}

/** RMS energy of 16-bit PCM, in dBFS. */
function rmsDb(pcm: Int16Array): number {
  if (pcm.length === 0) return MIN_DB;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i] / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / pcm.length);
  if (rms <= 0) return MIN_DB;
  const db = 20 * Math.log10(rms);
  return Math.max(db, MIN_DB);
}
