/**
 * VisionAdapter — a VisionProvider for openai / anthropic / google.
 *
 * Sends a PNG screenshot (as a base64 data URL) plus a prompt asking for
 * UI elements as JSON, then parses the model output into a ScreenAnalysis
 * { description, elements[], screenState }.
 *
 * Honesty rules:
 * - No API key → checkAvailability() is false with an honest reason;
 *   analyzeScreenshot() throws rather than guessing.
 * - Parse failure → an honest Error. The adapter NEVER invents UI
 *   elements to fill a gap.
 */
import type {
  ProviderCapability,
  ScreenAnalysis,
  UIElement,
  VisionProvider,
} from '@vyra/shared';
import { readSecret } from './env.js';

export type VisionBackend = 'openai' | 'anthropic' | 'google';

export interface VisionAdapterOptions {
  backend: VisionBackend;
  /** API key; falls back to the backend's env var when omitted. */
  apiKey?: string;
  model?: string;
}

const VISION_PROMPT = `Analyze this screenshot of a computer screen. Respond with ONLY a JSON object (no markdown, no commentary) with this exact shape:
{
  "description": "one or two sentences describing what is visible on screen",
  "screenState": "one of: idle, loading, login-form, error-dialog, browser, desktop, app-open, unknown",
  "elements": [
    { "kind": "button|input|link|menu|dialog|tab|icon|text", "label": "visible label or null", "x": 500, "y": 300, "width": 120, "height": 30, "confidence": 0.9 }
  ]
}
Coordinates x and y are normalized to 0-1000 relative to the screenshot dimensions. List only elements you can actually see. If you cannot identify any elements, return an empty array.`;

function toDataUrl(png: Buffer | Uint8Array): string {
  const bytes = Buffer.isBuffer(png) ? png : Buffer.from(png);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract the JSON object from model text (which may include stray
 * whitespace or fences) and validate it into a ScreenAnalysis.
 * Throws an honest error on any parse/validation failure.
 */
export function parseScreenAnalysis(text: string): ScreenAnalysis {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      'VYRA could not parse the vision response: no JSON object found in the model output.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error(
      'VYRA could not parse the vision response: the model output was not valid JSON.',
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      'VYRA could not parse the vision response: the JSON was not an object.',
    );
  }
  const description =
    typeof parsed.description === 'string' ? parsed.description : '';
  const screenState =
    typeof parsed.screenState === 'string' ? parsed.screenState : 'unknown';
  if (!Array.isArray(parsed.elements)) {
    throw new Error(
      'VYRA could not parse the vision response: "elements" was not an array.',
    );
  }
  const elements: UIElement[] = [];
  for (const raw of parsed.elements) {
    if (!isRecord(raw)) {
      throw new Error(
        'VYRA could not parse the vision response: an element was not an object.',
      );
    }
    const { kind, x, y, confidence } = raw;
    if (
      typeof kind !== 'string' ||
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof confidence !== 'number'
    ) {
      throw new Error(
        'VYRA could not parse the vision response: an element was missing required fields (kind, x, y, confidence).',
      );
    }
    elements.push({
      kind,
      label: typeof raw.label === 'string' ? raw.label : undefined,
      x,
      y,
      width: typeof raw.width === 'number' ? raw.width : undefined,
      height: typeof raw.height === 'number' ? raw.height : undefined,
      confidence,
    });
  }
  return { description, elements, screenState };
}

export class VisionAdapter implements VisionProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly backend: VisionBackend;
  private readonly apiKey?: string;
  private readonly model: string;

  constructor(opts: VisionAdapterOptions) {
    this.backend = opts.backend;
    this.apiKey = opts.apiKey;
    this.id = opts.backend;
    this.displayName =
      opts.backend === 'openai'
        ? 'OpenAI Vision'
        : opts.backend === 'anthropic'
          ? 'Anthropic Vision'
          : 'Google Vision';
    this.model =
      opts.model ??
      (opts.backend === 'openai'
        ? 'gpt-4o-mini'
        : opts.backend === 'anthropic'
          ? 'claude-sonnet-4-5-20250929'
          : 'gemini-2.5-flash');
  }

  private resolveKey(): string | undefined {
    if (this.apiKey) return this.apiKey;
    switch (this.backend) {
      case 'openai':
        return readSecret('OPENAI_API_KEY');
      case 'anthropic':
        return readSecret('ANTHROPIC_API_KEY');
      case 'google':
        return readSecret('GOOGLE_GENERATIVE_AI_KEY');
    }
  }

  private keyEnvName(): string {
    return this.backend === 'openai'
      ? 'OPENAI_API_KEY'
      : this.backend === 'anthropic'
        ? 'ANTHROPIC_API_KEY'
        : 'GOOGLE_GENERATIVE_AI_KEY';
  }

  async checkAvailability(): Promise<ProviderCapability> {
    if (!this.resolveKey()) {
      return {
        available: false,
        reason: `${this.keyEnvName()} is not set. Add it to your .env file or environment to enable vision.`,
      };
    }
    return { available: true };
  }

  async analyzeScreenshot(png: Buffer | Uint8Array): Promise<ScreenAnalysis> {
    const apiKey = this.resolveKey();
    if (!apiKey) {
      throw new Error(
        `Vision is not available: ${this.keyEnvName()} is not set.`,
      );
    }
    const dataUrl = toDataUrl(png);
    let text: string;
    if (this.backend === 'openai') {
      text = await this.callOpenAI(dataUrl, apiKey);
    } else if (this.backend === 'anthropic') {
      text = await this.callAnthropic(dataUrl, apiKey);
    } else {
      text = await this.callGoogle(dataUrl, apiKey);
    }
    // Throws an honest error when the output isn't usable JSON.
    return parseScreenAnalysis(text);
  }

  private async callOpenAI(dataUrl: string, apiKey: string): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        `Vision request failed (${response.status}): ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
    const content = (
      (body.choices as Array<Record<string, unknown>>)?.[0]
        ?.message as Record<string, unknown> | undefined
    )?.content;
    if (typeof content !== 'string') {
      throw new Error('Vision response had no usable text content.');
    }
    return content;
  }

  private async callAnthropic(dataUrl: string, apiKey: string): Promise<string> {
    const base64 = dataUrl.slice('data:image/png;base64,'.length);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: base64,
                },
              },
              { type: 'text', text: VISION_PROMPT },
            ],
          },
        ],
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        `Vision request failed (${response.status}): ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
    const text = ((body.content as Array<Record<string, unknown>>) ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    if (!text) throw new Error('Vision response had no usable text content.');
    return text;
  }

  private async callGoogle(dataUrl: string, apiKey: string): Promise<string> {
    const base64 = dataUrl.slice('data:image/png;base64,'.length);
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}` +
      `:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/png', data: base64 } },
              { text: VISION_PROMPT },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 2048 },
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        `Vision request failed (${response.status}): ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
    const parts = (
      (body.candidates as Array<Record<string, unknown>>)?.[0]
        ?.content as Record<string, unknown> | undefined
    )?.parts as Array<Record<string, unknown>> | undefined;
    const text = (parts ?? [])
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('');
    if (!text) throw new Error('Vision response had no usable text content.');
    return text;
  }
}
