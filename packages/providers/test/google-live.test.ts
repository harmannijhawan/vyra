/**
 * VYRA runs on Google's Gemini API. These tests pin the LIVE model
 * defaults: both the chat provider and the vision adapter must target the
 * current Gemini model unless the user explicitly overrides it.
 *
 * Network is stubbed — we assert on the request URL the provider builds,
 * never on a real API call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleProvider } from '../src/ai.js';
import { VisionAdapter } from '../src/vision.js';

const LIVE_MODEL = 'gemini-3-flash-preview';

function stubFetchJson(body: unknown): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as Response;
    },
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GoogleProvider live defaults', () => {
  it('targets the live Gemini model by default', async () => {
    const urls = stubFetchJson({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    const provider = new GoogleProvider({ apiKey: 'test-key' });
    await provider.chat([{ role: 'user', content: 'hello' }]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/models/${LIVE_MODEL}:generateContent`);
  });

  it('honors an explicit model override', async () => {
    const urls = stubFetchJson({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    const provider = new GoogleProvider({ apiKey: 'test-key', model: 'gemini-3.1-pro-preview' });
    await provider.chat([{ role: 'user', content: 'hello' }]);
    expect(urls[0]).toContain('/models/gemini-3.1-pro-preview:generateContent');
  });

  it('reports unavailable honestly without a key', async () => {
    const provider = new GoogleProvider({});
    const cap = await provider.checkAvailability();
    expect(cap.available).toBe(false);
    expect(cap.reason).toContain('GOOGLE_GENERATIVE_AI_KEY');
  });
});

describe('VisionAdapter google backend live defaults', () => {
  it('targets the live Gemini model by default', async () => {
    const urls = stubFetchJson({
      candidates: [
        {
          content: {
            parts: [{ text: '{"description":"test screen","elements":[]}' }],
          },
        },
      ],
    });
    const adapter = new VisionAdapter({ backend: 'google', apiKey: 'test-key' });
    await adapter.analyzeScreenshot(Buffer.from([1, 2, 3]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/models/${LIVE_MODEL}:generateContent`);
  });
});
