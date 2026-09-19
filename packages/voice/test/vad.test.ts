import { describe, expect, it } from 'vitest';
import { VoiceActivityDetector } from '../src/vad.js';

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 320

function silenceFrame(): Int16Array {
  return new Int16Array(FRAME_SAMPLES); // all zeros = digital silence
}

function loudSineFrame(amplitude = 12000, freqHz = 220): Int16Array {
  const frame = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    frame[i] = Math.round(
      amplitude * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE),
    );
  }
  return frame;
}

describe('VoiceActivityDetector', () => {
  it('classifies silence frames as silence', () => {
    const vad = new VoiceActivityDetector({ sampleRate: SAMPLE_RATE, frameMs: FRAME_MS });
    for (let i = 0; i < 10; i++) {
      expect(vad.processFrame(silenceFrame())).toBe('silence');
    }
  });

  it('classifies loud sine frames as speech', () => {
    const vad = new VoiceActivityDetector({ sampleRate: SAMPLE_RATE, frameMs: FRAME_MS });
    // Let the noise floor settle on silence first.
    for (let i = 0; i < 10; i++) vad.processFrame(silenceFrame());
    for (let i = 0; i < 5; i++) {
      expect(vad.processFrame(loudSineFrame())).toBe('speech');
    }
  });

  it('hangover keeps speech briefly after loud frames end', () => {
    const hangoverMs = 100;
    const vad = new VoiceActivityDetector({
      sampleRate: SAMPLE_RATE,
      frameMs: FRAME_MS,
      hangoverMs,
    });
    for (let i = 0; i < 10; i++) vad.processFrame(silenceFrame());
    for (let i = 0; i < 5; i++) vad.processFrame(loudSineFrame());

    // 100ms hangover at 20ms frames = 5 frames of held speech.
    const decisions: string[] = [];
    for (let i = 0; i < 10; i++) decisions.push(vad.processFrame(silenceFrame()));

    expect(decisions.slice(0, 5)).toEqual(['speech', 'speech', 'speech', 'speech', 'speech']);
    expect(decisions.slice(5)).toEqual(['silence', 'silence', 'silence', 'silence', 'silence']);
  });

  it('fires speech-start and speech-end callbacks on transitions', () => {
    const events: string[] = [];
    const vad = new VoiceActivityDetector({
      sampleRate: SAMPLE_RATE,
      frameMs: FRAME_MS,
      hangoverMs: 40, // 2 frames
      onSpeechStart: () => events.push('start'),
      onSpeechEnd: () => events.push('end'),
    });
    for (let i = 0; i < 5; i++) vad.processFrame(silenceFrame());
    for (let i = 0; i < 3; i++) vad.processFrame(loudSineFrame());
    for (let i = 0; i < 10; i++) vad.processFrame(silenceFrame());

    expect(events).toEqual(['start', 'end']);
  });

  it('does not fire speech-end for leading silence (no speech yet)', () => {
    const events: string[] = [];
    const vad = new VoiceActivityDetector({
      sampleRate: SAMPLE_RATE,
      frameMs: FRAME_MS,
      onSpeechStart: () => events.push('start'),
      onSpeechEnd: () => events.push('end'),
    });
    for (let i = 0; i < 20; i++) vad.processFrame(silenceFrame());
    expect(events).toEqual([]);
  });

  it('adapts: a quieter sustained tone is not learned as permanent speech', () => {
    const vad = new VoiceActivityDetector({
      sampleRate: SAMPLE_RATE,
      frameMs: FRAME_MS,
      thresholdDb: 12,
      hangoverMs: 0,
    });
    for (let i = 0; i < 10; i++) vad.processFrame(silenceFrame());
    // Loud burst → speech.
    expect(vad.processFrame(loudSineFrame(12000))).toBe('speech');
    // Long quiet stretch → the floor tracks down and stays silent.
    for (let i = 0; i < 50; i++) {
      expect(vad.processFrame(silenceFrame())).toBe('silence');
    }
  });

  it('rejects an invalid sample rate', () => {
    expect(() => new VoiceActivityDetector({ sampleRate: 0 })).toThrow();
  });
});
