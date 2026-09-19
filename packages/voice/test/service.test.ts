import { describe, expect, it, vi } from 'vitest';
import { VoiceState } from '@vyra/shared';
import type { AgentEvent, STTProvider, TTSProvider } from '@vyra/shared';
import { STTService, TTSService, VoiceService, SpeechInterruptedError } from '../src/index.js';
import type { AudioInput } from '../src/index.js';

/** Stub STT at the provider boundary (no real transcription in unit tests). */
class StubSTT implements STTProvider {
  readonly id = 'stub-stt';
  readonly displayName = 'Stub STT';
  transcript = 'open the calculator';
  calls: AudioInput[] = [];
  async checkAvailability() {
    return { available: true };
  }
  async transcribe(audio: AudioInput) {
    this.calls.push(audio);
    return { text: this.transcript };
  }
}

/** Stub TTS at the provider boundary. */
class StubTTS implements TTSProvider {
  readonly id = 'stub-tts';
  readonly displayName = 'Stub TTS';
  spoken: string[] = [];
  cancelCalls = 0;
  stopCalls = 0;
  /** When set, speak() hangs until released (simulates long speech). */
  hangSpeak = false;
  private releaseHanging: Array<() => void> = [];

  async checkAvailability() {
    return { available: true };
  }
  async speak(text: string) {
    this.spoken.push(text);
    if (this.hangSpeak) {
      await new Promise<void>((resolve) => this.releaseHanging.push(resolve));
    }
    return {
      pcm: new Int16Array([1, 2, 3]),
      sampleRate: 16000,
      cancel: () => {
        this.cancelCalls += 1;
      },
    };
  }
  async stop() {
    this.stopCalls += 1;
    for (const release of this.releaseHanging.splice(0)) release();
  }
}

function makeServices(opts?: { respond?: (text: string) => string }) {
  const stt = new STTService();
  const tts = new TTSService();
  const stubStt = new StubSTT();
  const stubTts = new StubTTS();
  stt.register(stubStt);
  stt.select('stub-stt');
  tts.register(stubTts);
  tts.select('stub-tts');

  const events: AgentEvent[] = [];
  const states: VoiceState[] = [];
  const service = new VoiceService({
    stt,
    tts,
    emit: (e) => events.push(e),
    respond: async () => opts?.respond?.('') ?? 'done',
  });
  service.onStateChange((s) => states.push(s));
  return { service, stubStt, stubTts, events, states };
}

describe('VoiceService state machine', () => {
  it('transitions IDLE → LISTENING → THINKING → SPEAKING → IDLE on a full turn', async () => {
    const { service, states, events, stubStt, stubTts } = makeServices({
      respond: () => 'opening it now',
    });

    expect(service.getState()).toBe(VoiceState.IDLE);

    await service.startUtterance();
    expect(service.getState()).toBe(VoiceState.LISTENING);

    service.feedAudio(new Int16Array([100, 200, 300]));
    await service.stopUtterance();

    expect(service.getState()).toBe(VoiceState.IDLE);
    expect(stubStt.calls).toHaveLength(1);
    expect(stubTts.spoken).toEqual(['opening it now']);

    expect(states).toEqual([
      VoiceState.LISTENING,
      VoiceState.THINKING,
      VoiceState.SPEAKING,
      VoiceState.IDLE,
    ]);

    // Every transition emitted a real 'voice.state' event…
    const voiceEvents = events.filter((e) => e.type === 'voice.state');
    expect(voiceEvents.map((e) => (e.payload as { to: VoiceState }).to)).toEqual(states);

    // …and the activity feed got VYRA product-language lines.
    const activityLines = events
      .filter((e) => e.type === 'activity')
      .map((e) => (e.payload as { message: string }).message);
    expect(activityLines).toContain('VYRA is listening.');
    expect(activityLines).toContain('VYRA is thinking.');
    expect(activityLines).toContain('VYRA is speaking.');
    expect(activityLines).toContain('VYRA is ready.');
  });

  it('keeps a bounded conversation history', async () => {
    const { service } = makeServices({ respond: () => 'ok' });
    await service.startUtterance();
    service.feedAudio(new Int16Array([1]));
    await service.stopUtterance();

    const history = service.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: 'user', text: 'open the calculator' });
    expect(history[1]).toMatchObject({ role: 'assistant', text: 'ok' });
  });

  it('returns to IDLE without speaking when nothing was said', async () => {
    const { service, states, stubStt, stubTts } = makeServices();
    stubStt.transcript = ''; // STT heard silence → empty transcript

    await service.startUtterance();
    service.feedAudio(new Int16Array([0, 0, 0]));
    await service.stopUtterance();

    expect(service.getState()).toBe(VoiceState.IDLE);
    expect(states).toEqual([
      VoiceState.LISTENING,
      VoiceState.THINKING,
      VoiceState.IDLE,
    ]);
    expect(states).not.toContain(VoiceState.SPEAKING);
    expect(stubTts.spoken).toEqual([]);
  });

  it('interrupt cancels in-flight speech and a new utterance barges in', async () => {
    const { service, states, stubTts } = makeServices({ respond: () => 'first reply' });
    stubTts.hangSpeak = true;

    // Start speaking and leave it hanging (simulates long TTS playback).
    const speaking = service.speakReply('a very long answer');
    await vi.waitFor(() => expect(service.getState()).toBe(VoiceState.SPEAKING));

    // A new utterance interrupts the speech first.
    await service.startUtterance();
    expect(stubTts.stopCalls).toBeGreaterThanOrEqual(1);
    expect(service.getState()).toBe(VoiceState.LISTENING);

    stubTts.hangSpeak = false;
    await speaking; // resolves quietly: interruption is not a failure
    await service.interrupt();
    expect(service.getState()).toBe(VoiceState.IDLE);

    // The interrupted speech never produced an ERROR state…
    expect(states).not.toContain(VoiceState.ERROR);
    // …and was never recorded as a completed assistant turn.
    expect(service.getHistory()).toEqual([]);
  });

  it('speakReply with empty text does not enter SPEAKING', async () => {
    const { service, states, stubTts } = makeServices();
    await service.speakReply('   ');
    expect(service.getState()).toBe(VoiceState.IDLE);
    expect(states).not.toContain(VoiceState.SPEAKING);
    expect(stubTts.spoken).toEqual([]);
  });

  it('TTSService.stop() cancels the in-flight synthesis handle', async () => {
    const tts = new TTSService();
    const stub = new StubTTS();
    tts.register(stub);
    tts.select('stub-tts');

    const first = await tts.speak('one');
    const second = await tts.speak('two'); // interrupts the first
    // Each speak() stops the provider first (interrupt previous), and the
    // first utterance's cancel handle fires exactly once.
    expect(stub.stopCalls).toBe(2);
    expect(stub.cancelCalls).toBe(1);
    expect(stub.spoken).toEqual(['one', 'two']);
    expect(second.pcm.length).toBe(3);
    void first;
  });

  it('a superseded speak() throws SpeechInterruptedError, not a provider error', async () => {
    const tts = new TTSService();
    const stub = new StubTTS();
    tts.register(stub);
    tts.select('stub-tts');
    stub.hangSpeak = true;

    const pending = tts.speak('never finishes');
    // Let the first speak() get past its internal stop() and hang in the provider.
    await vi.waitFor(() => expect(stub.spoken).toEqual(['never finishes']));
    await tts.stop(); // interrupt while the provider call is hanging

    await expect(pending).rejects.toBeInstanceOf(SpeechInterruptedError);
  });
});
