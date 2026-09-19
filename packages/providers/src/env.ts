/**
 * Environment configuration for VYRA providers.
 *
 * SECURITY CONTRACT (read carefully):
 * - `loadEnvConfig()` returns a typed config object that NEVER contains a
 *   secret value. Secrets are exposed only as `hasXxxKey: boolean` flags.
 * - Actual secret values are read via `readSecret(name)`, which is main-
 *   process only. Secret values must NEVER cross the IPC bridge to the
 *   renderer: the preload allowlist has no channel for them and main
 *   handlers must never include them in `vyra:providers:status` payloads.
 * - `loadEnvConfig()` itself never logs anything, so secrets can't leak
 *   through a stray console.log either.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface VyraEnvConfig {
  /** Selected AI provider id: 'openai' | 'anthropic' | 'google' | 'ollama'. */
  aiProvider: string;
  /** Model name for the selected AI provider. */
  aiModel: string;
  /** Selected STT provider id (implemented by @vyra/voice). */
  sttProvider: string;
  /** Selected TTS provider id (implemented by @vyra/voice). */
  ttsProvider: string;
  /** Selected vision provider id: 'openai' | 'anthropic' | 'google'. */
  visionProvider: string;
  /** Base URL for a local Ollama server. */
  ollamaBaseUrl: string;
  /** Directory for logs, memory DB and other local data. */
  dataDir: string;
  logLevel: LogLevel;
  /** Push-to-talk hotkey, e.g. "Ctrl+Space". */
  pttHotkey: string;
  wakeWordEnabled: boolean;
  // Secret-presence flags only — never the values themselves.
  hasOpenAiKey: boolean;
  hasAnthropicKey: boolean;
  hasGoogleKey: boolean;
  hasGithubToken: boolean;
}

const SECRET_ENV_NAMES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_KEY',
  'GITHUB_TOKEN',
] as const;

export type SecretEnvName = (typeof SECRET_ENV_NAMES)[number];

/**
 * Read a secret value from the environment. Main-process only.
 * NEVER send the returned value to the renderer or write it to logs.
 */
export function readSecret(
  name: SecretEnvName,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[name];
  if (!value || value.trim() === '') return undefined;
  return value;
}

function nonEmpty(value: string | undefined, fallback: string): string {
  return value !== undefined && value.trim() !== '' ? value : fallback;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const v = (value ?? '').toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error'
    ? v
    : 'info';
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function defaultDataDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return `${home}/.vyra`;
}

/**
 * Load the typed VYRA config from the environment. The returned object
 * contains NO secret values — only `hasXxxKey` presence flags. It is safe
 * to pass to the renderer for the Settings UI.
 */
export function loadEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
): VyraEnvConfig {
  return {
    aiProvider: nonEmpty(env.VYRA_AI_PROVIDER, 'google').toLowerCase(),
    aiModel: nonEmpty(env.VYRA_AI_MODEL, ''),
    sttProvider: nonEmpty(env.VYRA_STT_PROVIDER, 'system').toLowerCase(),
    ttsProvider: nonEmpty(env.VYRA_TTS_PROVIDER, 'system').toLowerCase(),
    visionProvider: nonEmpty(env.VYRA_VISION_PROVIDER, 'google').toLowerCase(),
    ollamaBaseUrl: nonEmpty(env.OLLAMA_BASE_URL, 'http://localhost:11434'),
    dataDir: nonEmpty(env.VYRA_DATA_DIR, defaultDataDir()),
    logLevel: parseLogLevel(env.VYRA_LOG_LEVEL),
    pttHotkey: nonEmpty(env.VYRA_PTT_HOTKEY, 'Ctrl+Space'),
    wakeWordEnabled: parseBool(env.VYRA_WAKE_WORD_ENABLED, false),
    hasOpenAiKey: readSecret('OPENAI_API_KEY', env) !== undefined,
    hasAnthropicKey: readSecret('ANTHROPIC_API_KEY', env) !== undefined,
    hasGoogleKey: readSecret('GOOGLE_GENERATIVE_AI_KEY', env) !== undefined,
    hasGithubToken: readSecret('GITHUB_TOKEN', env) !== undefined,
  };
}
