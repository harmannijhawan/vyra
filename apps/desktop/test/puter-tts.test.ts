/**
 * Puter TTS tests — the keyless ElevenLabs voice path.
 * @heyputer/puter.js is mocked; no network, no real audio.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const txt2speech = vi.fn();

vi.mock('@heyputer/puter.js', () => ({
  puter: { ai: { txt2speech } },
}));

import {
  PUTER_ELEVENLABS_VOICE,
  isPuterSpeechActive,
  sanitizeForSpeech,
  speakWithPuter,
  stopPuterSpeech,
} from '../src/renderer/lib/puterTts';

type Listener = () => void;

class FakeAudio {
  private listeners = new Map<string, Set<Listener>>();
  playCalled = false;
  pauseCalled = false;

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  play(): Promise<void> {
    this.playCalled = true;
    return Promise.resolve();
  }
  pause(): void {
    this.pauseCalled = true;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  stopPuterSpeech();
});

describe('sanitizeForSpeech', () => {
  it('strips code fences, inline code, links and markdown', () => {
    const out = sanitizeForSpeech(
      '# Done\n```js\nconst x = 1;\n```\nRun `npm test` and see [the docs](https://example.com) **now**.',
    );
    expect(out).not.toContain('```');
    expect(out).not.toContain('const x = 1');
    expect(out).not.toContain('https://example.com');
    expect(out).not.toContain('**');
    expect(out).toContain('the docs');
    expect(out).toContain('npm test');
  });

  it('returns empty for blank input', () => {
    expect(sanitizeForSpeech('   \n  ')).toBe('');
  });

  it('caps very long text under the Puter limit', () => {
    expect(sanitizeForSpeech('a'.repeat(10_000)).length).toBeLessThanOrEqual(2500);
  });
});

describe('speakWithPuter', () => {
  it('resolves without calling Puter for empty text', async () => {
    await speakWithPuter('   ');
    expect(txt2speech).not.toHaveBeenCalled();
  });

  it('calls Puter with the ElevenLabs provider and default Rachel voice', async () => {
    const audio = new FakeAudio();
    txt2speech.mockResolvedValueOnce(audio as unknown as HTMLAudioElement);

    const promise = speakWithPuter('Hello world');
    await vi.waitFor(() => expect(txt2speech).toHaveBeenCalledTimes(1));
    expect(txt2speech).toHaveBeenCalledTimes(1);
    const [text, options] = txt2speech.mock.calls[0] as [string, Record<string, string>];
    expect(text).toBe('Hello world');
    expect(options.provider).toBe('elevenlabs');
    expect(options.voice).toBe(PUTER_ELEVENLABS_VOICE);
    expect(isPuterSpeechActive()).toBe(true);

    audio.emit('ended');
    await promise;
    expect(isPuterSpeechActive()).toBe(false);
  });

  it('honors a custom voice id', async () => {
    const audio = new FakeAudio();
    txt2speech.mockResolvedValueOnce(audio as unknown as HTMLAudioElement);
    const promise = speakWithPuter('Hi', { voiceId: 'custom-voice-id' });
    await vi.waitFor(() => expect(txt2speech).toHaveBeenCalledTimes(1));
    const [, options] = txt2speech.mock.calls[0] as [string, Record<string, string>];
    expect(options.voice).toBe('custom-voice-id');
    audio.emit('ended');
    await promise;
  });

  it('rejects when Puter synthesis fails', async () => {
    txt2speech.mockRejectedValueOnce(new Error('puter is down'));
    await expect(speakWithPuter('Hello')).rejects.toThrow('puter is down');
    expect(isPuterSpeechActive()).toBe(false);
  });

  it('stopPuterSpeech pauses audio and settles the pending speak', async () => {
    const audio = new FakeAudio();
    txt2speech.mockResolvedValueOnce(audio as unknown as HTMLAudioElement);
    const promise = speakWithPuter('A long sentence that keeps going');
    await vi.waitFor(() => expect(isPuterSpeechActive()).toBe(true));
    expect(isPuterSpeechActive()).toBe(true);

    stopPuterSpeech();
    await promise; // resolves instead of hanging
    expect(audio.pauseCalled).toBe(true);
    expect(isPuterSpeechActive()).toBe(false);
  });

  it('a new utterance interrupts the previous one', async () => {
    const first = new FakeAudio();
    const second = new FakeAudio();
    txt2speech
      .mockResolvedValueOnce(first as unknown as HTMLAudioElement)
      .mockResolvedValueOnce(second as unknown as HTMLAudioElement);

    const p1 = speakWithPuter('first utterance');
    await vi.waitFor(() => expect(isPuterSpeechActive()).toBe(true));
    const p2 = speakWithPuter('second utterance');
    await vi.waitFor(() => expect(txt2speech).toHaveBeenCalledTimes(2));
    expect(first.pauseCalled).toBe(true);

    second.emit('ended');
    await p2;
    await p1; // first was settled by the interruption
    expect(isPuterSpeechActive()).toBe(false);
  });
});
