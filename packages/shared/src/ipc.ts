/**
 * IPC security contract — the channel allowlist.
 *
 * The renderer NEVER gets unrestricted Node access (no nodeIntegration,
 * contextIsolation on). It may only:
 *  - invoke() the channels in INVOKE_CHANNELS
 *  - listen to the channels in EVENT_CHANNELS (main → renderer only)
 *
 * The preload script enforces this list at runtime; main-process handlers
 * validate every payload. Unit tests assert the allowlist has no wildcards
 * and that no handler bypasses validation. Any channel not listed here is
 * rejected by the preload bridge.
 */

/** Renderer → main request/response calls. */
export const INVOKE_CHANNELS = [
  // Tasks
  'vyra:task:start',
  'vyra:task:cancel',
  'vyra:task:list',
  'vyra:task:get',
  // Chat
  'vyra:chat:send',
  // Voice
  'vyra:voice:start-listening',
  'vyra:voice:stop',
  'vyra:voice:push-to-talk',
  'vyra:voice:interrupt',
  // Memory
  'vyra:memory:remember',
  'vyra:memory:recall',
  'vyra:memory:update',
  'vyra:memory:forget',
  // Settings (includes provider + onboarding state)
  'vyra:settings:get',
  'vyra:settings:set',
  'vyra:settings:get-section',
  // Providers
  'vyra:providers:status',
  'vyra:providers:select',
  // Computer preview (latest real screenshot frame)
  'vyra:computer:latest-frame',
  // Safety confirmations
  'vyra:safety:respond',
  // Onboarding
  'vyra:onboarding:get-state',
  'vyra:onboarding:complete-step',
  'vyra:onboarding:test-google-key',
  // Logs
  'vyra:logs:query',
  // App
  'vyra:app:version',
  'vyra:app:quit',
  'vyra:app:open-external',
  'vyra:app:backend-status',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

/** Main → renderer one-way event broadcast (single multiplexed channel). */
export const EVENT_CHANNELS = ['vyra:event'] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];

/**
 * Every invoke channel maps to a payload validator id. Main handlers must
 * validate the payload before acting. "none" = no payload expected.
 */
export const INVOKE_PAYLOAD_SCHEMAS: Record<InvokeChannel, string> = {
  'vyra:task:start': 'TaskStart',
  'vyra:task:cancel': 'TaskId',
  'vyra:task:list': 'TaskListQuery',
  'vyra:task:get': 'TaskId',
  'vyra:chat:send': 'ChatSend',
  'vyra:voice:start-listening': 'none',
  'vyra:voice:stop': 'none',
  'vyra:voice:push-to-talk': 'PushToTalk',
  'vyra:voice:interrupt': 'none',
  'vyra:memory:remember': 'MemoryRemember',
  'vyra:memory:recall': 'MemoryRecall',
  'vyra:memory:update': 'MemoryUpdate',
  'vyra:memory:forget': 'MemoryForget',
  'vyra:settings:get': 'none',
  'vyra:settings:set': 'SettingsSet',
  'vyra:settings:get-section': 'SettingsSection',
  'vyra:providers:status': 'none',
  'vyra:providers:select': 'ProviderSelect',
  'vyra:computer:latest-frame': 'none',
  'vyra:safety:respond': 'SafetyRespond',
  'vyra:onboarding:get-state': 'none',
  'vyra:onboarding:complete-step': 'OnboardingStep',
  'vyra:onboarding:test-google-key': 'GoogleKeyTest',
  'vyra:logs:query': 'LogsQuery',
  'vyra:app:version': 'none',
  'vyra:app:quit': 'none',
  'vyra:app:backend-status': 'none',
  'vyra:app:open-external': 'OpenExternal',
};

/** Payload shapes (validated with zod in main; mirrored here for typing). */
export interface TaskStartPayload {
  goal: string;
  context?: Record<string, unknown>;
}
export interface TaskIdPayload {
  taskId: string;
}
export interface TaskListQueryPayload {
  limit?: number;
  includeTerminal?: boolean;
}
export interface PushToTalkPayload {
  active: boolean;
}
export interface MemoryRememberPayload {
  key: string;
  value: string;
  category?: string;
}
export interface MemoryRecallPayload {
  query?: string;
  category?: string;
  limit?: number;
}
export interface MemoryUpdatePayload {
  key: string;
  value: string;
}
export interface MemoryForgetPayload {
  key: string;
}
export interface SettingsSetPayload {
  section: string;
  values: Record<string, unknown>;
}
export interface SettingsSectionPayload {
  section: string;
}
export interface ProviderSelectPayload {
  kind: string;
  id: string;
}
export interface SafetyRespondPayload {
  requestId: string;
  approved: boolean;
}
export interface OnboardingStepPayload {
  step: string;
  values?: Record<string, unknown>;
}
/** Dry-run Gemini key test (nothing is saved). */
export interface GoogleKeyTestPayload {
  apiKey: string;
  /** Optional model override (without the "models/" prefix). Omit for auto-pick. */
  model?: string;
}
export interface LogsQueryPayload {
  level?: string;
  taskId?: string;
  limit?: number;
}

/** Open a URL in the user's browser (https only, validated in main). */
export interface OpenExternalPayload {
  url: string;
}

/** Conversational chat message batch (system prompts stay server-side). */
export interface ChatSendPayload {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}
