/**
 * Schema validation tests — the validate-then-handle pattern: every zod
 * schema accepts its documented payload shape and rejects malformed ones.
 */
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_SCHEMAS,
  LogsQuerySchema,
  MemoryRecallSchema,
  MemoryRememberSchema,
  OnboardingStepSchema,
  ProviderSelectSchema,
  PushToTalkSchema,
  SafetyRespondSchema,
  SettingsSetSchema,
  TaskIdSchema,
  TaskListQuerySchema,
  TaskStartSchema,
} from '../src/main/schemas';
import { INVOKE_CHANNELS } from '@vyra/shared';

describe('channel schema coverage', () => {
  it('has a schema entry for every invoke channel', () => {
    for (const channel of INVOKE_CHANNELS) {
      expect(channel in CHANNEL_SCHEMAS, `missing schema for ${channel}`).toBe(true);
    }
    expect(Object.keys(CHANNEL_SCHEMAS)).toHaveLength(INVOKE_CHANNELS.length);
  });
});

describe('TaskStart', () => {
  it('accepts a goal with optional context', () => {
    expect(TaskStartSchema.safeParse({ goal: 'Open notepad' }).success).toBe(true);
    expect(
      TaskStartSchema.safeParse({ goal: 'Do it', context: { app: 'notepad' } }).success,
    ).toBe(true);
  });
  it('rejects missing or empty goals', () => {
    expect(TaskStartSchema.safeParse({}).success).toBe(false);
    expect(TaskStartSchema.safeParse({ goal: '' }).success).toBe(false);
    expect(TaskStartSchema.safeParse({ goal: 42 }).success).toBe(false);
  });
});

describe('TaskId / TaskListQuery', () => {
  it('accepts valid ids and queries', () => {
    expect(TaskIdSchema.safeParse({ taskId: 'task_abc' }).success).toBe(true);
    expect(TaskListQuerySchema.safeParse({}).success).toBe(true);
    expect(
      TaskListQuerySchema.safeParse({ limit: 10, includeTerminal: false }).success,
    ).toBe(true);
  });
  it('rejects bad ids and out-of-range limits', () => {
    expect(TaskIdSchema.safeParse({ taskId: '' }).success).toBe(false);
    expect(TaskIdSchema.safeParse({}).success).toBe(false);
    expect(TaskListQuerySchema.safeParse({ limit: -1 }).success).toBe(false);
    expect(TaskListQuerySchema.safeParse({ limit: 1.5 }).success).toBe(false);
  });
});

describe('PushToTalk', () => {
  it('accepts booleans only', () => {
    expect(PushToTalkSchema.safeParse({ active: true }).success).toBe(true);
    expect(PushToTalkSchema.safeParse({ active: 'yes' }).success).toBe(false);
    expect(PushToTalkSchema.safeParse({}).success).toBe(false);
  });
});

describe('Memory schemas', () => {
  it('remember requires key and value', () => {
    expect(
      MemoryRememberSchema.safeParse({ key: 'k', value: 'v', category: 'c' }).success,
    ).toBe(true);
    expect(MemoryRememberSchema.safeParse({ key: '', value: 'v' }).success).toBe(false);
    expect(MemoryRememberSchema.safeParse({ key: 'k' }).success).toBe(false);
  });
  it('recall accepts empty and filtered queries', () => {
    expect(MemoryRecallSchema.safeParse({}).success).toBe(true);
    expect(
      MemoryRecallSchema.safeParse({ query: 'editor', limit: 5 }).success,
    ).toBe(true);
    expect(MemoryRecallSchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe('SettingsSet', () => {
  it('requires section and values record', () => {
    expect(
      SettingsSetSchema.safeParse({ section: 'voice', values: { a: 1 } }).success,
    ).toBe(true);
    expect(SettingsSetSchema.safeParse({ section: 'voice' }).success).toBe(false);
    expect(SettingsSetSchema.safeParse({ section: '', values: {} }).success).toBe(false);
  });
});

describe('ProviderSelect / SafetyRespond', () => {
  it('accepts valid selections and responses', () => {
    expect(ProviderSelectSchema.safeParse({ kind: 'ai', id: 'openai' }).success).toBe(true);
    expect(
      SafetyRespondSchema.safeParse({ requestId: 'req_1', approved: false }).success,
    ).toBe(true);
  });
  it('rejects malformed responses', () => {
    expect(ProviderSelectSchema.safeParse({ kind: 'ai' }).success).toBe(false);
    expect(SafetyRespondSchema.safeParse({ requestId: 'req_1' }).success).toBe(false);
    expect(
      SafetyRespondSchema.safeParse({ requestId: 'req_1', approved: 'yes' }).success,
    ).toBe(false);
  });
});

describe('OnboardingStep / LogsQuery', () => {
  it('accepts step completions with optional values', () => {
    expect(OnboardingStepSchema.safeParse({ step: 'voice' }).success).toBe(true);
    expect(
      OnboardingStepSchema.safeParse({ step: 'voice', values: { wakeWord: 'hey vyra' } }).success,
    ).toBe(true);
    expect(OnboardingStepSchema.safeParse({}).success).toBe(false);
  });
  it('restricts log levels to the known set', () => {
    expect(LogsQuerySchema.safeParse({ level: 'warn', limit: 50 }).success).toBe(true);
    expect(LogsQuerySchema.safeParse({ level: 'verbose' }).success).toBe(false);
  });
});
