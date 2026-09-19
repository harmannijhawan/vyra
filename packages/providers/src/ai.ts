/**
 * Real AIProvider adapters over fetch() — no vendor SDKs required.
 *
 * Providers: OpenAI (chat/completions), Anthropic (messages API),
 * Google (generativelanguage), Ollama (local /api/chat).
 *
 * Honesty rules enforced here:
 * - checkAvailability() returns { available: false, reason } whenever the
 *   API key is missing (or Ollama is unreachable). Never pretend to work.
 * - Provider tool_calls are mapped into ToolCallRequest[] by pure,
 *   exported mapper functions. Malformed model output throws an honest
 *   Error — the code NEVER fabricates tool calls to fill a gap.
 */
import type {
  AIProvider,
  AIResponse,
  ChatMessage,
  ProviderCapability,
  ToolCallRequest,
} from '@vyra/shared';
import { readSecret } from './env.js';

export interface ChatOptions {
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failParse(what: string, detail: string): never {
  throw new Error(
    `VYRA could not understand the ${what} response (${detail}). ` +
      'No tool calls were generated from it.',
  );
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Provider request failed (${response.status} ${response.statusText}): ${text.slice(0, 300)}`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      failParse('provider', 'response body was not JSON');
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Provider request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a tool-arguments JSON string; throws an honest error when invalid. */
function parseToolArguments(
  raw: unknown,
  toolName: string,
): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string') {
    failParse('tool call', `arguments for "${toolName}" were not an object`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      failParse('tool call', `arguments for "${toolName}" were not an object`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('VYRA could not')) {
      throw err;
    }
    failParse(
      'tool call',
      `arguments for "${toolName}" were not valid JSON`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* OpenAI                                                              */
/* ------------------------------------------------------------------ */

/**
 * Map a raw OpenAI chat/completions response body to AIResponse.
 * Pure function — unit-tested without network access.
 */
export function openAIToAIResponse(body: unknown): AIResponse {
  if (!isRecord(body)) failParse('OpenAI', 'top-level body was not an object');
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    failParse('OpenAI', 'response contained no choices');
  }
  const message = (choices[0] as Record<string, unknown>)?.message;
  if (!isRecord(message)) {
    failParse('OpenAI', 'first choice had no message object');
  }
  const text = typeof message.content === 'string' ? message.content : '';
  const toolCalls: ToolCallRequest[] = [];
  const rawCalls = message.tool_calls;
  if (rawCalls !== undefined && rawCalls !== null) {
    if (!Array.isArray(rawCalls)) {
      failParse('OpenAI', '"tool_calls" was not an array');
    }
    for (const raw of rawCalls) {
      if (!isRecord(raw) || raw.type !== 'function' || !isRecord(raw.function)) {
        failParse('OpenAI', 'a tool_call was malformed');
      }
      const fn = raw.function as Record<string, unknown>;
      const name = fn.name;
      if (typeof name !== 'string' || name === '') {
        failParse('OpenAI', 'a tool_call had no function name');
      }
      toolCalls.push({
        id: typeof raw.id === 'string' ? raw.id : `openai-${toolCalls.length}`,
        name,
        arguments: parseToolArguments(fn.arguments, name),
      });
    }
  }
  const usageRaw = (body as Record<string, unknown>).usage;
  const usage =
    isRecord(usageRaw) &&
    typeof usageRaw.prompt_tokens === 'number' &&
    typeof usageRaw.completion_tokens === 'number'
      ? {
          promptTokens: usageRaw.prompt_tokens,
          completionTokens: usageRaw.completion_tokens,
        }
      : undefined;
  return { text, toolCalls, usage };
}

function toOpenAITools(
  tools: ChatOptions['tools'],
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function toOpenAIMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: String(m.toolResult ?? ''),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai';
  readonly displayName = 'OpenAI';

  constructor(
    private readonly opts: { model?: string; apiKey?: string } = {},
  ) {}

  private get model(): string {
    return this.opts.model || process.env.VYRA_AI_MODEL || 'gpt-4o-mini';
  }

  private get apiKey(): string | undefined {
    return this.opts.apiKey ?? readSecret('OPENAI_API_KEY');
  }

  async checkAvailability(): Promise<ProviderCapability> {
    if (!this.apiKey) {
      return {
        available: false,
        reason:
          'OPENAI_API_KEY is not set. Add it to your .env file or environment to enable OpenAI.',
      };
    }
    return { available: true };
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<AIResponse> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new Error(
        'OpenAI is not available: OPENAI_API_KEY is not set.',
      );
    }
    const body = await fetchJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(opts.tools),
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
      }),
      signal: opts.signal,
    });
    return openAIToAIResponse(body);
  }
}

/* ------------------------------------------------------------------ */
/* Anthropic                                                           */
/* ------------------------------------------------------------------ */

/**
 * Map a raw Anthropic messages response body to AIResponse.
 * Pure function — unit-tested without network access.
 */
export function anthropicToAIResponse(body: unknown): AIResponse {
  if (!isRecord(body)) {
    failParse('Anthropic', 'top-level body was not an object');
  }
  const content = (body as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    failParse('Anthropic', 'response had no content array');
  }
  const textParts: string[] = [];
  const toolCalls: ToolCallRequest[] = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      failParse('Anthropic', 'a content block was malformed');
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      const name = block.name;
      if (typeof name !== 'string' || name === '') {
        failParse('Anthropic', 'a tool_use block had no name');
      }
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : `anthropic-${toolCalls.length}`,
        name,
        arguments: parseToolArguments(block.input, name),
      });
    }
  }
  const usageRaw = (body as Record<string, unknown>).usage;
  const usage =
    isRecord(usageRaw) &&
    typeof usageRaw.input_tokens === 'number' &&
    typeof usageRaw.output_tokens === 'number'
      ? {
          promptTokens: usageRaw.input_tokens,
          completionTokens: usageRaw.output_tokens,
        }
      : undefined;
  return { text: textParts.join(''), toolCalls, usage };
}

function toAnthropicMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // sent separately
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: String(m.toolResult ?? ''),
          },
        ],
      });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic';

  constructor(
    private readonly opts: { model?: string; apiKey?: string } = {},
  ) {}

  private get model(): string {
    return (
      this.opts.model ||
      process.env.VYRA_AI_MODEL ||
      'claude-sonnet-4-5-20250929'
    );
  }

  private get apiKey(): string | undefined {
    return this.opts.apiKey ?? readSecret('ANTHROPIC_API_KEY');
  }

  async checkAvailability(): Promise<ProviderCapability> {
    if (!this.apiKey) {
      return {
        available: false,
        reason:
          'ANTHROPIC_API_KEY is not set. Add it to your .env file or environment to enable Anthropic.',
      };
    }
    return { available: true };
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<AIResponse> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new Error(
        'Anthropic is not available: ANTHROPIC_API_KEY is not set.',
      );
    }
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const body = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 4096,
        system: system || undefined,
        messages: toAnthropicMessages(messages),
        tools:
          opts.tools && opts.tools.length > 0
            ? opts.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              }))
            : undefined,
      }),
      signal: opts.signal,
    });
    return anthropicToAIResponse(body);
  }
}

/* ------------------------------------------------------------------ */
/* Google (generativelanguage)                                          */
/* ------------------------------------------------------------------ */

/**
 * Map a raw Google generateContent response body to AIResponse.
 * Pure function — unit-tested without network access.
 */
export function googleToAIResponse(body: unknown): AIResponse {
  if (!isRecord(body)) failParse('Google', 'top-level body was not an object');
  const candidates = (body as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    failParse('Google', 'response contained no candidates');
  }
  const content = (candidates[0] as Record<string, unknown>)?.content;
  if (!isRecord(content) || !Array.isArray(content.parts)) {
    failParse('Google', 'first candidate had no content parts');
  }
  const textParts: string[] = [];
  const toolCalls: ToolCallRequest[] = [];
  for (const part of content.parts as unknown[]) {
    if (!isRecord(part)) failParse('Google', 'a content part was malformed');
    if (typeof part.text === 'string') textParts.push(part.text);
    const fn = part.functionCall;
    if (fn !== undefined) {
      if (!isRecord(fn) || typeof fn.name !== 'string' || fn.name === '') {
        failParse('Google', 'a functionCall had no name');
      }
      toolCalls.push({
        id: `google-${toolCalls.length}`,
        name: fn.name,
        arguments: parseToolArguments(fn.args, fn.name),
      });
    }
  }
  const usageRaw = (body as Record<string, unknown>).usageMetadata;
  const usage =
    isRecord(usageRaw) &&
    typeof usageRaw.promptTokenCount === 'number' &&
    typeof usageRaw.candidatesTokenCount === 'number'
      ? {
          promptTokens: usageRaw.promptTokenCount,
          completionTokens: usageRaw.candidatesTokenCount,
        }
      : undefined;
  return { text: textParts.join(''), toolCalls, usage };
}

export class GoogleProvider implements AIProvider {
  readonly id = 'google';
  readonly displayName = 'Google';

  constructor(
    private readonly opts: { model?: string; apiKey?: string } = {},
  ) {}

  private get model(): string {
    return this.opts.model || process.env.VYRA_AI_MODEL || 'gemini-3-flash-preview';
  }

  private get apiKey(): string | undefined {
    return this.opts.apiKey ?? readSecret('GOOGLE_GENERATIVE_AI_KEY');
  }

  async checkAvailability(): Promise<ProviderCapability> {
    if (!this.apiKey) {
      return {
        available: false,
        reason:
          'GOOGLE_GENERATIVE_AI_KEY is not set. Add it to your .env file or environment to enable Google.',
      };
    }
    return { available: true };
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<AIResponse> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new Error(
        'Google is not available: GOOGLE_GENERATIVE_AI_KEY is not set.',
      );
    }
    const contents = messages
      .filter((m) => m.role !== 'tool')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}` +
      `:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        tools:
          opts.tools && opts.tools.length > 0
            ? [
                {
                  functionDeclarations: opts.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  })),
                },
              ]
            : undefined,
        generationConfig: {
          maxOutputTokens: opts.maxTokens,
          temperature: opts.temperature,
        },
      }),
      signal: opts.signal,
    });
    return googleToAIResponse(body);
  }
}

/* ------------------------------------------------------------------ */
/* Ollama (local, no key needed)                                        */
/* ------------------------------------------------------------------ */

/**
 * Map a raw Ollama /api/chat response body to AIResponse.
 * Pure function — unit-tested without network access.
 */
export function ollamaToAIResponse(body: unknown): AIResponse {
  if (!isRecord(body)) failParse('Ollama', 'top-level body was not an object');
  const message = (body as Record<string, unknown>).message;
  if (!isRecord(message)) {
    failParse('Ollama', 'response had no message object');
  }
  const text = typeof message.content === 'string' ? message.content : '';
  const toolCalls: ToolCallRequest[] = [];
  const rawCalls = message.tool_calls;
  if (rawCalls !== undefined && rawCalls !== null) {
    if (!Array.isArray(rawCalls)) {
      failParse('Ollama', '"tool_calls" was not an array');
    }
    for (const raw of rawCalls) {
      if (!isRecord(raw) || !isRecord(raw.function)) {
        failParse('Ollama', 'a tool_call was malformed');
      }
      const fn = raw.function as Record<string, unknown>;
      const name = fn.name;
      if (typeof name !== 'string' || name === '') {
        failParse('Ollama', 'a tool_call had no function name');
      }
      toolCalls.push({
        id: `ollama-${toolCalls.length}`,
        name,
        arguments: parseToolArguments(fn.arguments, name),
      });
    }
  }
  return { text, toolCalls };
}

export class OllamaProvider implements AIProvider {
  readonly id = 'ollama';
  readonly displayName = 'Ollama (local)';

  constructor(
    private readonly opts: { model?: string; baseUrl?: string } = {},
  ) {}

  private get baseUrl(): string {
    return (
      this.opts.baseUrl ||
      process.env.OLLAMA_BASE_URL ||
      'http://localhost:11434'
    ).replace(/\/+$/, '');
  }

  private get model(): string {
    return this.opts.model || process.env.VYRA_AI_MODEL || 'llama3.1';
  }

  async checkAvailability(): Promise<ProviderCapability> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`${this.baseUrl}/api/tags`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          return {
            available: false,
            reason: `Ollama at ${this.baseUrl} answered with HTTP ${response.status}. Is the Ollama server running?`,
          };
        }
        return { available: true };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return {
        available: false,
        reason: `Ollama is not reachable at ${this.baseUrl}. Start Ollama (ollama serve) to use local models.`,
      };
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<AIResponse> {
    const body = await fetchJson(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: messages
          .filter((m) => m.role !== 'tool')
          .map((m) => ({ role: m.role, content: m.content })),
        tools:
          opts.tools && opts.tools.length > 0
            ? opts.tools.map((t) => ({
                type: 'function',
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              }))
            : undefined,
        options: {
          num_predict: opts.maxTokens,
          temperature: opts.temperature,
        },
      }),
      signal: opts.signal,
    });
    return ollamaToAIResponse(body);
  }
}

/** Convenience union type for code that works with any AI adapter. */
export type AnyAIProvider =
  | OpenAIProvider
  | AnthropicProvider
  | GoogleProvider
  | OllamaProvider;
