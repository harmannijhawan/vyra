/**
 * Secret redaction tests — keys/tokens/PEM blocks redacted (including
 * nested objects), non-secrets left untouched, input never mutated.
 */
import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from '../src/redact.js';

describe('redactSecrets', () => {
  it('redacts OpenAI-style keys embedded in strings', () => {
    const out = redactSecrets(
      'using key sk-abcdefgh12345678 to call the API',
    ) as string;
    expect(out).not.toContain('sk-abcdefgh12345678');
    expect(out).toContain(REDACTED);
    expect(out).toContain('to call the API');
  });

  it('redacts GitHub tokens, Slack tokens and Bearer headers', () => {
    expect(redactSecrets('ghp_ABCDEFGHIJKLMNOP1234')).toBe(REDACTED);
    expect(redactSecrets('xoxb-123456789012-abcdefg')).toBe(REDACTED);
    const header = redactSecrets(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload',
    ) as string;
    expect(header).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(header).toContain(REDACTED);
  });

  it('redacts AWS access key ids', () => {
    const out = redactSecrets('key id AKIAIOSFODNN7EXAMPLE in config');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain(REDACTED);
  });

  it('redacts PEM private key blocks wholesale', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA7b...',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets(`config: ${pem} done`) as string;
    expect(out).not.toContain('MIIEpAIBAAKCAQEA7b');
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(out).toContain(REDACTED);
  });

  it('redacts values of secret-named keys in objects (deeply nested)', () => {
    const input = {
      level: 'info',
      component: 'agent',
      config: {
        apiKey: 'sk-should-not-appear-1234567890',
        nested: { password: 'hunter2-hunter2', ok: 'visible' },
        // A secret-named key redacts the whole value…
        tokens: ['ghp_ABCDEFGHIJKLMNOP1234', 'plain-value'],
        // …while a plain key redacts only the secret-looking items.
        items: ['ghp_ABCDEFGHIJKLMNOP1234', 'plain-value'],
      },
    };
    const out = redactSecrets(input) as unknown as {
      level: string;
      config: {
        apiKey: string;
        nested: { password: string; ok: string };
        tokens: string;
        items: string[];
      };
    };
    expect(out.config.apiKey).toBe(REDACTED);
    expect(out.config.nested.password).toBe(REDACTED);
    expect(out.config.nested.ok).toBe('visible');
    expect(out.config.tokens).toBe(REDACTED);
    expect(out.config.items[0]).toBe(REDACTED);
    expect(out.config.items[1]).toBe('plain-value');
    expect(out.level).toBe('info');
  });

  it('leaves non-secrets untouched', () => {
    const input = {
      action: 'computer.screenshot',
      durationMs: 120,
      result: 'screenshot captured (1920x1080)',
      tags: ['ui', 'ok'],
      count: 3,
      flag: true,
      nothing: null,
    };
    expect(redactSecrets(input)).toEqual(input);
  });

  it('never mutates the input', () => {
    const input = { apiKey: 'sk-abcdefgh12345678', sub: { token: 'x' } };
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    redactSecrets(input);
    expect(input).toEqual(snapshot);
  });

  it('handles circular references without hanging', () => {
    const input: Record<string, unknown> = { name: 'loop' };
    input.self = input;
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.name).toBe('loop');
    expect(out.self).toBe('[Circular]');
  });

  it('handles arrays, dates and primitives', () => {
    const date = new Date('2026-09-20T00:00:00Z');
    const out = redactSecrets({ at: date, n: 42 }) as {
      at: Date;
      n: number;
    };
    expect(out.at).toBeInstanceOf(Date);
    expect(out.at.getTime()).toBe(date.getTime());
    expect(out.n).toBe(42);
    expect(redactSecrets(7)).toBe(7);
    expect(redactSecrets(null)).toBeNull();
  });
});
