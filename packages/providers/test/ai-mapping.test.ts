/**
 * AI response → ToolCallRequest mapping tests.
 * Pure mapper functions over canned responses — no network access.
 */
import { describe, expect, it } from 'vitest';
import {
  anthropicToAIResponse,
  googleToAIResponse,
  ollamaToAIResponse,
  openAIToAIResponse,
} from '../src/ai.js';
import { parseScreenAnalysis } from '../src/vision.js';

describe('openAIToAIResponse', () => {
  it('maps text + tool calls from a canned response', () => {
    const body = {
      choices: [
        {
          message: {
            content: 'Let me open that for you.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'computer_click',
                  arguments: '{"x": 100, "y": 200}',
                },
              },
              {
                id: 'call_2',
                type: 'function',
                function: {
                  name: 'terminal_run',
                  arguments: '{"command": "dir"}',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    };
    const result = openAIToAIResponse(body);
    expect(result.text).toBe('Let me open that for you.');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'computer_click', arguments: { x: 100, y: 200 } },
      { id: 'call_2', name: 'terminal_run', arguments: { command: 'dir' } },
    ]);
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 30 });
  });

  it('handles a text-only response', () => {
    const body = { choices: [{ message: { content: 'Hello!' } }] };
    const result = openAIToAIResponse(body);
    expect(result.text).toBe('Hello!');
    expect(result.toolCalls).toEqual([]);
  });

  it('throws an honest error on malformed tool_calls — never fabricates calls', () => {
    const body = {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'computer_click',
                  arguments: '{"x": 100, ', // truncated JSON
                },
              },
            ],
          },
        },
      ],
    };
    expect(() => openAIToAIResponse(body)).toThrow(/not valid JSON/);
  });

  it('throws when choices are missing entirely', () => {
    expect(() => openAIToAIResponse({})).toThrow(/no choices/);
    expect(() => openAIToAIResponse(null)).toThrow();
  });
});

describe('anthropicToAIResponse', () => {
  it('maps text + tool_use blocks', () => {
    const body = {
      content: [
        { type: 'text', text: 'On it.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'filesystem_read',
          input: { path: 'C:\\notes.txt' },
        },
      ],
      usage: { input_tokens: 50, output_tokens: 12 },
    };
    const result = anthropicToAIResponse(body);
    expect(result.text).toBe('On it.');
    expect(result.toolCalls).toEqual([
      {
        id: 'toolu_1',
        name: 'filesystem_read',
        arguments: { path: 'C:\\notes.txt' },
      },
    ]);
    expect(result.usage).toEqual({ promptTokens: 50, completionTokens: 12 });
  });

  it('throws on malformed tool_use blocks instead of guessing', () => {
    const body = {
      content: [{ type: 'tool_use', id: 'toolu_1', input: {} }], // no name
    };
    expect(() => anthropicToAIResponse(body)).toThrow(/no name/);
  });
});

describe('googleToAIResponse', () => {
  it('maps text + functionCall parts', () => {
    const body = {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Sure.' },
              {
                functionCall: {
                  name: 'browser_navigate',
                  args: { url: 'https://example.com' },
                },
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10 },
    };
    const result = googleToAIResponse(body);
    expect(result.text).toBe('Sure.');
    expect(result.toolCalls).toEqual([
      {
        id: 'google-0',
        name: 'browser_navigate',
        arguments: { url: 'https://example.com' },
      },
    ]);
  });

  it('throws when no candidates are present', () => {
    expect(() => googleToAIResponse({ candidates: [] })).toThrow(
      /no candidates/,
    );
  });
});

describe('ollamaToAIResponse', () => {
  it('maps message content + tool_calls', () => {
    const body = {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'computer_type',
              arguments: { text: 'hello' },
            },
          },
        ],
      },
    };
    const result = ollamaToAIResponse(body);
    expect(result.toolCalls).toEqual([
      { id: 'ollama-0', name: 'computer_type', arguments: { text: 'hello' } },
    ]);
  });

  it('throws on a malformed tool_call instead of inventing one', () => {
    const body = { message: { content: '', tool_calls: [{ nope: true }] } };
    expect(() => ollamaToAIResponse(body)).toThrow(/malformed/);
  });
});

describe('parseScreenAnalysis', () => {
  it('parses a well-formed vision JSON payload', () => {
    const text = JSON.stringify({
      description: 'A login form.',
      screenState: 'login-form',
      elements: [
        {
          kind: 'input',
          label: 'Username',
          x: 500,
          y: 300,
          width: 200,
          height: 30,
          confidence: 0.95,
        },
        { kind: 'button', label: 'Sign in', x: 500, y: 360, confidence: 0.9 },
      ],
    });
    const result = parseScreenAnalysis(text);
    expect(result.description).toBe('A login form.');
    expect(result.screenState).toBe('login-form');
    expect(result.elements).toHaveLength(2);
    expect(result.elements[0].label).toBe('Username');
  });

  it('tolerates surrounding prose/fences around the JSON', () => {
    const text =
      'Here is the analysis:\n```json\n{"description":"d","screenState":"idle","elements":[]}\n```';
    const result = parseScreenAnalysis(text);
    expect(result.elements).toEqual([]);
  });

  it('throws an honest error when the output is not usable JSON', () => {
    expect(() => parseScreenAnalysis('no json here at all')).toThrow(
      /no JSON object found/,
    );
    expect(() => parseScreenAnalysis('{oops')).toThrow();
    expect(() =>
      parseScreenAnalysis('{"description":"d","elements":"nope"}'),
    ).toThrow(/"elements" was not an array/);
  });
});
