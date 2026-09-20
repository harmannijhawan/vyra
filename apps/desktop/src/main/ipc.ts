/**
 * IPC handler registration — the ONLY place renderer→main calls land.
 *
 * Every channel in INVOKE_CHANNELS gets a handler; anything else is never
 * handled. Each handler:
 *   1. validates the payload with zod (CHANNEL_SCHEMAS),
 *   2. delegates to the injected MainServices,
 *   3. returns { ok: true, data } — or { ok: false, error: { code, message } }.
 *
 * Handlers never throw across IPC: unexpected errors are caught and
 * reported with code UNKNOWN.
 */
import type { IpcMain } from 'electron';
import type {
  InvokeChannel,
  TaskStartPayload,
  TaskIdPayload,
  TaskListQueryPayload,
  PushToTalkPayload,
  MemoryRememberPayload,
  MemoryRecallPayload,
  MemoryUpdatePayload,
  MemoryForgetPayload,
  SettingsSetPayload,
  SettingsSectionPayload,
  ProviderSelectPayload,
  SafetyRespondPayload,
  ChatSendPayload,
  OnboardingStepPayload,
  GoogleKeyTestPayload,
  OpenExternalPayload,
  LogsQueryPayload,
} from '@vyra/shared';
import { CHANNEL_SCHEMAS } from './schemas.js';
import type { MainServices } from './services.js';

export interface IpcSuccess<T = unknown> {
  ok: true;
  data: T;
}

export interface IpcFailure {
  ok: false;
  error: { code: string; message: string };
}

export type IpcResult<T = unknown> = IpcSuccess<T> | IpcFailure;

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

export function fail(code: string, message: string): IpcFailure {
  return { ok: false, error: { code, message } };
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return 'UNKNOWN';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'An unexpected error occurred.';
}

function isEmptyPayload(payload: unknown): boolean {
  return (
    payload === undefined ||
    payload === null ||
    (typeof payload === 'object' && Object.keys(payload as object).length === 0)
  );
}

export interface IpcHooks {
  /** Called after vyra:settings:set succeeds (e.g. to re-register hotkeys). */
  onSettingsChanged?: (section: string) => void;
  /** Called after vyra:app:quit succeeds (main performs the actual quit). */
  onQuitRequested?: () => void;
}

/**
 * Register a validated handler for every channel in INVOKE_CHANNELS.
 * Unknown channels are never handled — the preload already refuses them.
 */
export function registerIpcHandlers(
  ipcMain: IpcMain,
  services: MainServices,
  hooks: IpcHooks = {},
): void {
  const handle = (
    channel: InvokeChannel,
    fn: (payload: unknown) => Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, async (_event, rawPayload: unknown): Promise<IpcResult> => {
      try {
        const schema = CHANNEL_SCHEMAS[channel];
        let payload: unknown = rawPayload;
        if (schema === null) {
          if (!isEmptyPayload(rawPayload)) {
            return fail('INVALID_PAYLOAD', `Channel ${channel} takes no payload.`);
          }
          payload = undefined;
        } else {
          const parsed = schema.safeParse(rawPayload);
          if (!parsed.success) {
            return fail('INVALID_PAYLOAD', `Invalid payload for ${channel}.`);
          }
          payload = parsed.data;
        }
        const data = await fn(payload);
        return ok(data);
      } catch (err) {
        return fail(errorCode(err), errorMessage(err));
      }
    });
  };

  // --- Tasks -----------------------------------------------------------
  handle('vyra:task:start', async (p) => {
    const { goal, context } = p as TaskStartPayload;
    return services.startTask(goal, context);
  });
  handle('vyra:task:cancel', async (p) => {
    const { taskId } = p as TaskIdPayload;
    await services.cancelTask(taskId);
    return { cancelled: taskId };
  });
  handle('vyra:task:list', async (p) => {
    const { limit, includeTerminal } = (p ?? {}) as TaskListQueryPayload;
    return services.listTasks(limit, includeTerminal);
  });
  handle('vyra:task:get', async (p) => {
    const { taskId } = p as TaskIdPayload;
    return services.getTask(taskId);
  });

  // --- Voice -----------------------------------------------------------
  handle('vyra:voice:start-listening', async () => {
    await services.voiceStart();
    return { listening: true };
  });
  handle('vyra:voice:stop', async () => {
    await services.voiceStop();
    return { listening: false };
  });
  handle('vyra:voice:push-to-talk', async (p) => {
    const { active } = p as PushToTalkPayload;
    await services.pushToTalk(active);
    return { active };
  });
  handle('vyra:voice:interrupt', async () => {
    await services.interruptSpeech();
    return { interrupted: true };
  });

  // --- Memory ----------------------------------------------------------
  handle('vyra:memory:remember', async (p) => {
    const { key, value, category } = p as MemoryRememberPayload;
    await services.memoryRemember(key, value, category);
    return { key };
  });
  handle('vyra:memory:recall', async (p) => {
    const { query, category, limit } = (p ?? {}) as MemoryRecallPayload;
    return services.memoryRecall(query, category, limit);
  });
  handle('vyra:memory:update', async (p) => {
    const { key, value } = p as MemoryUpdatePayload;
    await services.memoryUpdate(key, value);
    return { key };
  });
  handle('vyra:memory:forget', async (p) => {
    const { key } = p as MemoryForgetPayload;
    return { forgotten: await services.memoryForget(key) };
  });

  // --- Settings --------------------------------------------------------
  handle('vyra:settings:get', async () => services.getSettings());
  handle('vyra:settings:set', async (p) => {
    const { section, values } = p as SettingsSetPayload;
    await services.setSettings(section, values);
    hooks.onSettingsChanged?.(section);
    return { section };
  });
  handle('vyra:settings:get-section', async (p) => {
    const { section } = p as SettingsSectionPayload;
    return services.getSettingsSection(section);
  });

  // --- Providers -------------------------------------------------------
  handle('vyra:providers:status', async () => services.providersStatus());
  handle('vyra:providers:select', async (p) => {
    const { kind, id } = p as ProviderSelectPayload;
    await services.selectProvider(kind, id);
    return { kind, id };
  });

  // --- Computer preview ------------------------------------------------
  handle('vyra:computer:latest-frame', async () => services.latestComputerFrame());

  // --- Safety ----------------------------------------------------------
  handle('vyra:safety:respond', async (p) => {
    const { requestId, approved } = p as SafetyRespondPayload;
    await services.safetyRespond(requestId, approved);
    return { requestId, approved };
  });

  // --- Chat ----------------------------------------------------------
  handle('vyra:chat:send', async (p) => {
    const { messages } = p as ChatSendPayload;
    return services.chatSend(messages);
  });

  // --- Onboarding ------------------------------------------------------
  handle('vyra:onboarding:get-state', async () => services.onboardingState());
  handle('vyra:onboarding:complete-step', async (p) => {
    const { step, values } = p as OnboardingStepPayload;
    return services.completeOnboardingStep(step, values);
  });
  handle('vyra:onboarding:test-google-key', async (p) => {
    const { apiKey, model } = p as GoogleKeyTestPayload;
    return services.testGoogleConnection(apiKey, model);
  });

  // --- Logs ------------------------------------------------------------
  handle('vyra:logs:query', async (p) => {
    const query = (p ?? {}) as LogsQueryPayload;
    return services.queryLogs(query);
  });

  // --- App -------------------------------------------------------------
  handle('vyra:app:version', async () => ({ version: await services.getVersion() }));
  handle('vyra:app:quit', async () => {
    await services.quitApp();
    hooks.onQuitRequested?.();
    return { quitting: true };
  });
  handle('vyra:app:open-external', async (p) => {
    const { url } = p as OpenExternalPayload;
    // Only https URLs, opened in the user's real browser — never inside VYRA.
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new Error('Only https links can be opened.');
    }
    const { shell } = await import('electron');
    await shell.openExternal(parsed.toString());
    return { opened: true };
  });
}
