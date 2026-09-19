import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AzureSTT,
  AzureTTS,
  DeepgramSTT,
  ElevenLabsTTS,
  OpenAITTS,
  OpenAIWhisperSTT,
  STTService,
  SystemTTS,
  TTSService,
} from '../src/index.js';

const STT_ENV = ['OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'];
const TTS_ENV = [...STT_ENV, 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'];
const ALL = [...new Set([...STT_ENV, ...TTS_ENV])];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ALL) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ALL) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function nonEmptyAudio() {
  return { pcm: new Int16Array([100, -200, 300]), sampleRate: 16000, channels: 1 };
}

describe('STT adapters with no API keys', () => {
  it.each([
    ['OpenAIWhisperSTT', () => new OpenAIWhisperSTT()],
    ['DeepgramSTT', () => new DeepgramSTT()],
    ['AzureSTT', () => new AzureSTT()],
  ])('%s reports unavailable with an honest reason', async (_name, make) => {
    const provider = make();
    const cap = await provider.checkAvailability();
    expect(cap.available).toBe(false);
    expect(cap.reason).toBeTruthy();
    expect(cap.reason).toMatch(/not set/i);
  });

  it('STTService refuses to transcribe without an available provider', async () => {
    const service = new STTService();
    const cap = await service.checkAvailability();
    expect(cap.available).toBe(false);
    expect(cap.reason).toBeTruthy();

    await expect(service.transcribe(nonEmptyAudio())).rejects.toThrow(/unavailable|not set/i);
  });

  it('STTService returns empty text for empty audio (not an error)', async () => {
    const service = new STTService();
    const result = await service.transcribe({ pcm: new Int16Array(0), sampleRate: 16000, channels: 1 });
    expect(result).toEqual({ text: '' });
  });

  it('STTService reports honest availability for the selected provider', async () => {
    const service = new STTService();
    service.select('deepgram');
    const cap = await service.checkAvailability();
    expect(cap.providerId).toBe('deepgram');
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/DEEPGRAM_API_KEY/);
  });

  it('select() rejects unknown provider ids', () => {
    const service = new STTService();
    expect(() => service.select('nope')).toThrow(/unknown/i);
  });
});

describe('TTS adapters with no API keys', () => {
  it.each([
    ['OpenAITTS', () => new OpenAITTS()],
    ['ElevenLabsTTS', () => new ElevenLabsTTS()],
    ['AzureTTS', () => new AzureTTS()],
    ['SystemTTS', () => new SystemTTS()],
  ])('%s reports unavailable with an honest reason', async (_name, make) => {
    const provider = make();
    const cap = await provider.checkAvailability();
    expect(cap.available).toBe(false);
    expect(cap.reason).toBeTruthy();
  });

  it('TTSService refuses to synthesize without an available provider', async () => {
    const service = new TTSService();
    const cap = await service.checkAvailability();
    expect(cap.available).toBe(false);

    await expect(service.speak('hello')).rejects.toThrow(/unavailable|not set|not implemented/i);
  });

  it('TTSService resolves empty PCM for empty text without calling a provider', async () => {
    const service = new TTSService();
    const result = await service.speak('   ');
    expect(result.pcm.length).toBe(0);
  });

  it('SystemTTS never pretends to work', async () => {
    const provider = new SystemTTS();
    expect((await provider.checkAvailability()).available).toBe(false);
    await expect(provider.speak('hi')).rejects.toThrow(/not implemented/i);
  });
});
