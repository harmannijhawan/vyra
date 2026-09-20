/**
 * Zod validators for every renderer→main invoke payload.
 *
 * Shapes mirror the payload interfaces documented in
 * @vyra/shared (packages/shared/src/ipc.ts). Main-process handlers must
 * validate with these BEFORE touching any service — never trust the
 * renderer.
 */
import { z } from 'zod';
import type { InvokeChannel } from '@vyra/shared';

export const TaskStartSchema = z.object({
  goal: z.string().min(1, 'goal must be a non-empty string'),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const TaskIdSchema = z.object({
  taskId: z.string().min(1),
});

export const TaskListQuerySchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
  includeTerminal: z.boolean().optional(),
});

export const PushToTalkSchema = z.object({
  active: z.boolean(),
});

export const MemoryRememberSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  category: z.string().optional(),
});

export const MemoryRecallSchema = z.object({
  query: z.string().optional(),
  category: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const MemoryUpdateSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

export const MemoryForgetSchema = z.object({
  key: z.string().min(1),
});

export const SettingsSetSchema = z.object({
  section: z.string().min(1),
  values: z.record(z.string(), z.unknown()),
});

export const SettingsSectionSchema = z.object({
  section: z.string().min(1),
});

export const ProviderSelectSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
});

export const SafetyRespondSchema = z.object({
  requestId: z.string().min(1),
  approved: z.boolean(),
});

export const OnboardingStepSchema = z.object({
  step: z.string().min(1),
  values: z.record(z.string(), z.unknown()).optional(),
});

export const ChatSendSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(40),
});

export const GoogleKeyTestSchema = z.object({
  apiKey: z.string().min(1).max(500),
  model: z.string().min(1).max(120).optional(),
});

export const OpenExternalSchema = z.object({
  url: z.string().url().max(500),
});

export const LogsQuerySchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  taskId: z.string().optional(),
  limit: z.number().int().positive().max(5000).optional(),
});

/**
 * Validator per invoke channel. `null` = no payload expected; the handler
 * still rejects a non-empty payload for those channels.
 */
export const CHANNEL_SCHEMAS: Record<InvokeChannel, z.ZodTypeAny | null> = {
  'vyra:task:start': TaskStartSchema,
  'vyra:task:cancel': TaskIdSchema,
  'vyra:task:list': TaskListQuerySchema,
  'vyra:task:get': TaskIdSchema,
  'vyra:voice:start-listening': null,
  'vyra:voice:stop': null,
  'vyra:voice:push-to-talk': PushToTalkSchema,
  'vyra:voice:interrupt': null,
  'vyra:memory:remember': MemoryRememberSchema,
  'vyra:memory:recall': MemoryRecallSchema,
  'vyra:memory:update': MemoryUpdateSchema,
  'vyra:memory:forget': MemoryForgetSchema,
  'vyra:settings:get': null,
  'vyra:settings:set': SettingsSetSchema,
  'vyra:settings:get-section': SettingsSectionSchema,
  'vyra:providers:status': null,
  'vyra:providers:select': ProviderSelectSchema,
  'vyra:computer:latest-frame': null,
  'vyra:safety:respond': SafetyRespondSchema,
  'vyra:onboarding:get-state': null,
  'vyra:onboarding:complete-step': OnboardingStepSchema,
  'vyra:onboarding:test-google-key': GoogleKeyTestSchema,
  'vyra:chat:send': ChatSendSchema,
  'vyra:logs:query': LogsQuerySchema,
  'vyra:app:version': null,
  'vyra:app:quit': null,
  'vyra:app:open-external': OpenExternalSchema,
  'vyra:app:backend-status': null,
};
