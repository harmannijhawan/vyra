/**
 * Provider registry routing + env config tests.
 * No network access — all providers here are in-memory fakes.
 */
import { describe, expect, it } from 'vitest';
import type { BaseProvider, ProviderKind } from '@vyra/shared';
import {
  InMemorySettings,
  ProviderRegistryImpl,
} from '../src/registry.js';
import { loadEnvConfig } from '../src/env.js';

class FakeProvider implements BaseProvider {
  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly capability: {
      available: boolean;
      reason?: string;
    },
  ) {}

  async checkAvailability(): Promise<{
    available: boolean;
    reason?: string;
  }> {
    return this.capability;
  }
}

function makeRegistry(): ProviderRegistryImpl {
  const registry = new ProviderRegistryImpl(new InMemorySettings());
  registry.register(
    'ai',
    new FakeProvider('openai', 'OpenAI', { available: false, reason: 'no key' }),
  );
  registry.register(
    'ai',
    new FakeProvider('ollama', 'Ollama (local)', { available: true }),
  );
  registry.register(
    'stt',
    new FakeProvider('system', 'System STT', { available: true }),
  );
  return registry;
}

describe('ProviderRegistryImpl', () => {
  it('lists registered providers per kind', () => {
    const registry = makeRegistry();
    expect(registry.list('ai').map((p) => p.id)).toEqual(['openai', 'ollama']);
    expect(registry.list('stt').map((p) => p.id)).toEqual(['system']);
    expect(registry.list('tts')).toEqual([]);
  });

  it('selects and persists the selected provider id', () => {
    const settings = new InMemorySettings();
    const registry = new ProviderRegistryImpl(settings);
    registry.register(
      'ai',
      new FakeProvider('openai', 'OpenAI', { available: true }),
    );
    registry.register(
      'ai',
      new FakeProvider('ollama', 'Ollama', { available: true }),
    );

    registry.select('ai', 'ollama');
    expect(registry.selected('ai')).toBe('ollama');
    expect(registry.get('ai')?.id).toBe('ollama');
    // Persisted in the settings store itself:
    expect(settings.get('providers.ai')).toBe('ollama');

    // A second registry over the same store sees the selection.
    const registry2 = new ProviderRegistryImpl(settings);
    registry2.register(
      'ai',
      new FakeProvider('openai', 'OpenAI', { available: true }),
    );
    registry2.register(
      'ai',
      new FakeProvider('ollama', 'Ollama', { available: true }),
    );
    expect(registry2.selected('ai')).toBe('ollama');
    expect(registry2.get('ai')?.id).toBe('ollama');
  });

  it('get(kind, id) returns the exact provider', () => {
    const registry = makeRegistry();
    expect(registry.get('ai', 'openai')?.displayName).toBe('OpenAI');
    expect(registry.get('ai', 'missing')).toBeUndefined();
  });

  it('get(kind) without selection falls back to the first registered', () => {
    const registry = makeRegistry();
    expect(registry.get('ai')?.id).toBe('openai');
    expect(registry.get('browser')).toBeUndefined();
  });

  it('select() throws for an unknown provider id', () => {
    const registry = makeRegistry();
    expect(() => registry.select('ai', 'nope')).toThrow(/unknown provider/);
  });

  it('ignores a stored selection whose provider is no longer registered', () => {
    const settings = new InMemorySettings();
    settings.set('providers.ai', 'ghost');
    const registry = new ProviderRegistryImpl(settings);
    registry.register(
      'ai',
      new FakeProvider('openai', 'OpenAI', { available: true }),
    );
    expect(registry.selected('ai')).toBeUndefined();
    expect(registry.get('ai')?.id).toBe('openai');
  });

  it('probeAll returns an honest availability map', async () => {
    const registry = makeRegistry();
    const report = await registry.probeAll();
    expect(report['ai:openai']).toEqual({
      id: 'openai',
      available: false,
      reason: 'no key',
    });
    expect(report['ai:ollama']).toEqual({
      id: 'ollama',
      available: true,
      reason: undefined,
    });
    expect(report['stt:system'].available).toBe(true);
  });

  it('probeAll reports a crashing probe as unavailable, not as a throw', async () => {
    const registry = new ProviderRegistryImpl();
    const bad: BaseProvider = {
      id: 'broken',
      displayName: 'Broken',
      checkAvailability: async () => {
        throw new Error('kaboom');
      },
    };
    registry.register('ai', bad);
    const report = await registry.probeAll();
    expect(report['ai:broken'].available).toBe(false);
    expect(report['ai:broken'].reason).toMatch(/kaboom/);
  });
});

describe('loadEnvConfig', () => {
  it('maps VYRA_AI_PROVIDER and friends', () => {
    const config = loadEnvConfig({
      VYRA_AI_PROVIDER: 'Anthropic',
      VYRA_AI_MODEL: 'claude-x',
      VYRA_STT_PROVIDER: 'whisper',
      VYRA_TTS_PROVIDER: 'piper',
      VYRA_VISION_PROVIDER: 'google',
      OLLAMA_BASE_URL: 'http://ollama:11434',
      VYRA_DATA_DIR: '/tmp/vyra-data',
      VYRA_LOG_LEVEL: 'debug',
      VYRA_PTT_HOTKEY: 'Alt+Space',
      VYRA_WAKE_WORD_ENABLED: 'true',
    } as NodeJS.ProcessEnv);
    expect(config.aiProvider).toBe('anthropic');
    expect(config.aiModel).toBe('claude-x');
    expect(config.sttProvider).toBe('whisper');
    expect(config.ttsProvider).toBe('piper');
    expect(config.visionProvider).toBe('google');
    expect(config.ollamaBaseUrl).toBe('http://ollama:11434');
    expect(config.dataDir).toBe('/tmp/vyra-data');
    expect(config.logLevel).toBe('debug');
    expect(config.pttHotkey).toBe('Alt+Space');
    expect(config.wakeWordEnabled).toBe(true);
  });

  it('never includes secret values in the returned object', () => {
    const config = loadEnvConfig({
      OPENAI_API_KEY: 'sk-super-secret-value-12345',
      ANTHROPIC_API_KEY: 'sk-ant-secret-67890',
      GOOGLE_GENERATIVE_AI_KEY: 'AIzaSecretKeyValue',
      GITHUB_TOKEN: 'ghp_secretTokenValue123',
    } as NodeJS.ProcessEnv);
    expect(config.hasOpenAiKey).toBe(true);
    expect(config.hasAnthropicKey).toBe(true);
    expect(config.hasGoogleKey).toBe(true);
    expect(config.hasGithubToken).toBe(true);
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('sk-super-secret-value-12345');
    expect(serialized).not.toContain('sk-ant-secret-67890');
    expect(serialized).not.toContain('AIzaSecretKeyValue');
    expect(serialized).not.toContain('ghp_secretTokenValue123');
  });

  it('applies sane defaults for an empty environment', () => {
    const config = loadEnvConfig({} as NodeJS.ProcessEnv);
    expect(config.aiProvider).toBe('openai');
    expect(config.ollamaBaseUrl).toBe('http://localhost:11434');
    expect(config.logLevel).toBe('info');
    expect(config.pttHotkey).toBe('Ctrl+Space');
    expect(config.wakeWordEnabled).toBe(false);
    expect(config.hasOpenAiKey).toBe(false);
    expect(typeof config.dataDir).toBe('string');
  });

  it('rejects invalid log levels', () => {
    const config = loadEnvConfig({
      VYRA_LOG_LEVEL: 'verbose',
    } as NodeJS.ProcessEnv);
    expect(config.logLevel).toBe('info');
  });
});

describe('ProviderKind coverage', () => {
  it('accepts all documented kinds at the type level', () => {
    const kinds: ProviderKind[] = [
      'ai',
      'stt',
      'tts',
      'vision',
      'computer',
      'browser',
      'wakeword',
    ];
    const registry = new ProviderRegistryImpl();
    for (const kind of kinds) {
      expect(registry.list(kind)).toEqual([]);
    }
  });
});
