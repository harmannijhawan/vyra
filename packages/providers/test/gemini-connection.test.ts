/**
 * Tests for the REAL Gemini connection test: pure helpers (error mapping,
 * model picking) plus the full test flow with stubbed network.
 * No real Google calls are ever made here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  geminiFailureMessage,
  pickGeminiModel,
  testGeminiConnection,
  type GeminiModelInfo,
} from '../src/ai.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function modelsList(models: GeminiModelInfo[]): unknown {
  return { models };
}

function generateOk(): unknown {
  return { candidates: [{ content: { parts: [{ text: 'VYRA-OK' }] } }] };
}

/** Stub fetch with a scripted sequence of responses; records URLs. */
function stubFetch(
  script: Array<
    | { status: number; body: unknown }
    | { error: 'network' | 'timeout' }
  >,
): string[] {
  const urls: string[] = [];
  let i = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    urls.push(url);
    const step = script[Math.min(i++, script.length - 1)];
    void init;
    if ('error' in step) {
      if (step.error === 'timeout') {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      throw new Error('network down');
    }
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      statusText: step.status === 200 ? 'OK' : 'Error',
      text: async () => JSON.stringify(step.body),
    } as Response;
  });
  return urls;
}

const FLASH_MODELS: GeminiModelInfo[] = [
  { name: 'models/gemini-3-flash-preview', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.1-pro-preview', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-embedding-001', supportedGenerationMethods: [] },
  { name: 'models/gemini-3.1-flash-image-preview', supportedGenerationMethods: ['generateContent'] },
];
const FLASH_MODELS_RESPONSE = modelsList(FLASH_MODELS);

describe('geminiFailureMessage', () => {
  it('maps auth failures to invalid-key without leaking details', () => {
    for (const status of [400, 401, 403]) {
      const f = geminiFailureMessage(status, 'secret-detail');
      expect(f.code).toBe('invalid-key');
      expect(f.message).toContain('AI Studio');
      expect(f.message).not.toContain('secret-detail');
    }
  });

  it('maps 404 to model-not-found and 429 to rate-limited', () => {
    expect(geminiFailureMessage(404, 'gemini-x').code).toBe('model-not-found');
    expect(geminiFailureMessage(429, '').code).toBe('rate-limited');
    expect(geminiFailureMessage(429, '').message).toContain('rate-limiting');
  });

  it('tells the user to enter a different model on 404 (no false auto-pick promise)', () => {
    const f = geminiFailureMessage(404, 'gemini-2.5-flash');
    expect(f.code).toBe('model-not-found');
    expect(f.message).toContain('gemini-2.5-flash');
    expect(f.message).toContain('different model');
    expect(f.message).not.toContain('pick a working model automatically');
  });

  it('maps missing responses to network', () => {
    const f = geminiFailureMessage(null, '');
    expect(f.code).toBe('network');
    expect(f.message).toContain('internet');
  });

  it('maps 5xx to unknown with the status, never a stack trace', () => {
    const f = geminiFailureMessage(503, '');
    expect(f.code).toBe('unknown');
    expect(f.message).toContain('503');
    expect(f.message).not.toContain('Error');
  });
});

describe('pickGeminiModel', () => {
  it('honors the preferred model when it supports generateContent', () => {
    expect(pickGeminiModel(FLASH_MODELS, 'gemini-3.1-pro-preview')).toBe(
      'gemini-3.1-pro-preview',
    );
  });

  it('ignores the preferred model when it cannot generate', () => {
    expect(pickGeminiModel(FLASH_MODELS, 'gemini-embedding-001')).toBe(
      'gemini-3-flash-preview',
    );
  });

  it('prefers flash over pro and skips image variants', () => {
    expect(pickGeminiModel(FLASH_MODELS)).toBe('gemini-3-flash-preview');
  });

  it('returns undefined when nothing can generate text', () => {
    expect(
      pickGeminiModel([
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: [] },
      ]),
    ).toBeUndefined();
  });
});

describe('testGeminiConnection', () => {
  it('rejects an empty key without touching the network', async () => {
    const urls = stubFetch([]);
    const result = await testGeminiConnection('   ');
    expect(result.ok).toBe(false);
    expect(urls).toHaveLength(0);
  });

  it('succeeds when the key lists models and the model generates', async () => {
    const urls = stubFetch([
      { status: 200, body: FLASH_MODELS_RESPONSE },
      { status: 200, body: generateOk() },
    ]);
    const result = await testGeminiConnection('good-key');
    expect(result).toEqual({ ok: true, model: 'gemini-3-flash-preview' });
    expect(urls[0]).toContain('/v1beta/models?key=');
    expect(urls[1]).toContain('/models/gemini-3-flash-preview:generateContent');
  });

  it('never puts the raw key in an error message', async () => {
    stubFetch([{ status: 400, body: { error: { message: 'API key not valid' } } }]);
    const result = await testGeminiConnection('super-secret-key-123');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid-key');
      expect(result.message).not.toContain('super-secret-key-123');
    }
  });

  it('reports network failure honestly', async () => {
    stubFetch([{ error: 'network' }]);
    const result = await testGeminiConnection('k');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('network');
  });

  it('reports timeout honestly', async () => {
    stubFetch([{ error: 'timeout' }]);
    const result = await testGeminiConnection('k', { timeoutMs: 50 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('timeout');
  });

  it('fails when the model cannot generate (404)', async () => {
    stubFetch([
      { status: 200, body: FLASH_MODELS_RESPONSE },
      { status: 404, body: { error: { message: 'not found' } } },
    ]);
    const result = await testGeminiConnection('k');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('model-not-found');
  });

  it('fails when the key lists no generative models', async () => {
    stubFetch([
      {
        status: 200,
        body: modelsList([
          { name: 'models/gemini-embedding-001', supportedGenerationMethods: [] },
        ]),
      },
    ]);
    const result = await testGeminiConnection('k');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('model-not-found');
  });

  it('fails when the generation reply is unparseable', async () => {
    stubFetch([
      { status: 200, body: FLASH_MODELS_RESPONSE },
      { status: 200, body: { nonsense: true } },
    ]);
    const result = await testGeminiConnection('k');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown');
  });

  it('honors an explicit model override instead of auto-picking', async () => {
    const urls = stubFetch([
      { status: 200, body: FLASH_MODELS_RESPONSE },
      { status: 200, body: generateOk() },
    ]);
    const result = await testGeminiConnection('k', { model: 'gemini-3.1-pro-preview' });
    expect(result).toEqual({ ok: true, model: 'gemini-3.1-pro-preview' });
    expect(urls[1]).toContain('/models/gemini-3.1-pro-preview:generateContent');
  });

  it('falls back to auto-pick when the override cannot generate', async () => {
    const urls = stubFetch([
      { status: 200, body: FLASH_MODELS_RESPONSE },
      { status: 200, body: generateOk() },
    ]);
    const result = await testGeminiConnection('k', { model: 'gemini-embedding-001' });
    expect(result).toEqual({ ok: true, model: 'gemini-3-flash-preview' });
    expect(urls[1]).toContain('/models/gemini-3-flash-preview:generateContent');
  });
});
