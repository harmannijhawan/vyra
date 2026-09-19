/**
 * @vyra/providers — provider registry + concrete adapters for VYRA.
 *
 * `createDefaultRegistry(env)` wires up every provider kind:
 * - ai:      OpenAI / Anthropic / Google / Ollama (this package)
 * - vision:  VisionAdapter for openai / anthropic / google (this package)
 * - stt/tts: loaded from @vyra/voice when present, otherwise honest
 *            "unavailable" stubs — the voice package owns those adapters.
 * - computer: NutJsComputerProvider from @vyra/tools when present,
 *            otherwise an honest "unavailable" stub.
 * - browser: PlaywrightBrowserProvider from @vyra/tools when present,
 *            otherwise an honest "unavailable" stub.
 *
 * The @vyra/tools and @vyra/voice packages are loaded lazily via
 * createRequire inside try/catch so this package still typechecks and
 * runs when they haven't landed yet. Missing adapters are NEVER faked:
 * the registry reports them unavailable with a clear reason.
 */
import { createRequire } from 'node:module';
import type {
  AIProvider,
  BaseProvider,
  BrowserProvider,
  ComputerProvider,
  ProviderKind,
  STTProvider,
  TTSProvider,
  VisionProvider,
} from '@vyra/shared';
import {
  InMemorySettings,
  ProviderRegistryImpl,
  UnavailableProvider,
  type SettingsStore,
} from './registry.js';
import { loadEnvConfig, type VyraEnvConfig } from './env.js';
import {
  AnthropicProvider,
  GoogleProvider,
  OllamaProvider,
  OpenAIProvider,
} from './ai.js';
import { VisionAdapter, type VisionBackend } from './vision.js';

export * from './registry.js';
export * from './env.js';
export * from './ai.js';
export * from './vision.js';

/** Try to require an optional sibling package; undefined when absent. */
function tryRequirePackage(
  specifier: string,
): Record<string, unknown> | undefined {
  try {
    const require = createRequire(import.meta.url);
    const mod = require(specifier) as unknown;
    if (mod && typeof mod === 'object') {
      return mod as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isProvider(value: unknown): value is BaseProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BaseProvider).id === 'string' &&
    typeof (value as BaseProvider).checkAvailability === 'function'
  );
}

function constructProvider(
  mod: Record<string, unknown>,
  exportName: string,
): BaseProvider | undefined {
  const Ctor = mod[exportName];
  if (typeof Ctor !== 'function') return undefined;
  try {
    const instance = new (Ctor as new () => BaseProvider)();
    return isProvider(instance) ? instance : undefined;
  } catch {
    return undefined;
  }
}

function loadComputerProvider(): ComputerProvider {
  const mod = tryRequirePackage('@vyra/tools');
  const provider = mod
    ? constructProvider(mod, 'NutJsComputerProvider')
    : undefined;
  if (provider) return provider as ComputerProvider;
  return new UnavailableProvider(
    'nutjs-computer',
    'Computer control (nut-js)',
    '@vyra/tools is not available in this environment, so computer control cannot run.',
  ) as unknown as ComputerProvider;
}

function loadBrowserProvider(): BrowserProvider {
  const mod = tryRequirePackage('@vyra/tools');
  const provider = mod
    ? constructProvider(mod, 'PlaywrightBrowserProvider')
    : undefined;
  if (provider) return provider as BrowserProvider;
  return new UnavailableProvider(
    'playwright-browser',
    'Browser automation (Playwright)',
    '@vyra/tools is not available in this environment, so browser automation cannot run.',
  ) as unknown as BrowserProvider;
}

function loadVoiceProviders(
  kind: 'stt' | 'tts',
): Array<STTProvider | TTSProvider> {
  const mod = tryRequirePackage('@vyra/voice');
  const factoryName =
    kind === 'stt' ? 'createSttProviders' : 'createTtsProviders';
  const factory = mod?.[factoryName];
  if (typeof factory === 'function') {
    try {
      const providers = (factory as () => unknown[])();
      if (Array.isArray(providers)) {
        return providers.filter(isProvider) as Array<STTProvider | TTSProvider>;
      }
    } catch {
      // fall through to the honest stub below
    }
  }
  const stub = new UnavailableProvider(
    'unavailable',
    kind === 'stt' ? 'Speech-to-text' : 'Text-to-speech',
    '@vyra/voice is not available in this environment, so speech cannot run.',
  );
  return [stub as unknown as STTProvider & TTSProvider];
}

function selectIfRegistered(
  registry: ProviderRegistryImpl,
  kind: ProviderKind,
  id: string,
): void {
  if (registry.list(kind).some((p) => p.id === id)) {
    registry.select(kind, id);
  }
}

/**
 * Build a fully wired registry from the environment. Selection follows
 * VYRA_AI_PROVIDER / VYRA_VISION_PROVIDER / VYRA_STT_PROVIDER /
 * VYRA_TTS_PROVIDER, falling back to the first registered provider of
 * each kind when the env choice isn't registered.
 */
export function createDefaultRegistry(
  env: VyraEnvConfig = loadEnvConfig(),
  settings: SettingsStore = new InMemorySettings(),
): ProviderRegistryImpl {
  const registry = new ProviderRegistryImpl(settings);

  const aiProviders: AIProvider[] = [
    new OpenAIProvider({ model: env.aiModel || undefined }),
    new AnthropicProvider({ model: env.aiModel || undefined }),
    new GoogleProvider({ model: env.aiModel || undefined }),
    new OllamaProvider({
      model: env.aiModel || undefined,
      baseUrl: env.ollamaBaseUrl,
    }),
  ];
  for (const p of aiProviders) registry.register('ai', p);

  const visionBackends: VisionBackend[] = ['openai', 'anthropic', 'google'];
  for (const backend of visionBackends) {
    const adapter: VisionProvider = new VisionAdapter({ backend });
    registry.register('vision', adapter);
  }

  for (const stt of loadVoiceProviders('stt')) registry.register('stt', stt);
  for (const tts of loadVoiceProviders('tts')) registry.register('tts', tts);

  registry.register('computer', loadComputerProvider());
  registry.register('browser', loadBrowserProvider());

  selectIfRegistered(registry, 'ai', env.aiProvider);
  selectIfRegistered(registry, 'vision', env.visionProvider);
  selectIfRegistered(registry, 'stt', env.sttProvider);
  selectIfRegistered(registry, 'tts', env.ttsProvider);

  return registry;
}
