/**
 * Spoken replies — VYRA reads task results aloud with an ElevenLabs voice
 * via Puter (no API key needed).
 *
 * Trigger: a `task.status` event reaching COMPLETED or FAILED. The hook reads
 * the voice settings fresh for every event, so toggling the provider or the
 * speak switch takes effect immediately without a restart.
 *
 * Speech must never break the app: every failure path is swallowed after a
 * console warning. Silence on error is the honest behavior here — the task
 * result is still visible in the activity feed.
 */
import { useEffect, useRef } from 'react';
import { TaskStatus } from '@vyra/shared';
import type { AgentEvent, TaskStatusPayload } from '@vyra/shared';
import { getSettingsSection, getTask, onEvent } from '../api';
import { sanitizeForSpeech, speakWithPuter } from './puterTts';

function buildSpeechText(
  status: TaskStatus,
  goal: string,
  errorMessage?: string,
): string {
  if (status === TaskStatus.COMPLETED) {
    return `Done: ${goal}`;
  }
  const reason = errorMessage?.trim();
  return reason ? `Sorry, that didn't work: ${reason}` : `Sorry, that didn't work: ${goal}`;
}

async function speakTaskResult(taskId: string, status: TaskStatus): Promise<void> {
  const voice = await getSettingsSection('voice');
  if (!voice || voice.ttsProvider !== 'puter' || voice.speakReplies === false) return;

  const task = await getTask(taskId);
  if (!task) return;

  const text = buildSpeechText(status, task.goal ?? 'task complete', task.errors?.[0]?.message);
  await speakWithPuter(sanitizeForSpeech(text));
}

export function useSpokenReplies(): void {
  const spokenFor = useRef<Set<string>>(new Set());

  useEffect(() => {
    return onEvent((event: AgentEvent) => {
      if (event.type !== 'task.status' || !event.taskId) return;
      const payload = event.payload as TaskStatusPayload;
      if (payload?.to !== TaskStatus.COMPLETED && payload?.to !== TaskStatus.FAILED) return;
      if (spokenFor.current.has(event.taskId)) return;
      spokenFor.current.add(event.taskId);
      speakTaskResult(event.taskId, payload.to).catch((err: unknown) => {
        console.warn('[vyra] spoken reply failed:', err);
      });
    });
  }, []);
}
