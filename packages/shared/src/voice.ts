/**
 * Voice-state contract. The orb, the status line and spoken feedback all
 * render from this single enum — UI states are never invented elsewhere.
 */

export enum VoiceState {
  IDLE = 'IDLE',
  LISTENING = 'LISTENING',
  THINKING = 'THINKING',
  PLANNING = 'PLANNING',
  ACTING = 'ACTING',
  VERIFYING = 'VERIFYING',
  SPEAKING = 'SPEAKING',
  WAITING = 'WAITING',
  ERROR = 'ERROR',
  COMPLETE = 'COMPLETE',
}

/** Product-language line for each voice state ("VYRA is …"). */
export const VOICE_STATE_PHRASES: Record<VoiceState, string> = {
  [VoiceState.IDLE]: 'VYRA is ready.',
  [VoiceState.LISTENING]: 'VYRA is listening.',
  [VoiceState.THINKING]: 'VYRA is thinking.',
  [VoiceState.PLANNING]: 'VYRA is creating a plan.',
  [VoiceState.ACTING]: 'VYRA is working on your task.',
  [VoiceState.VERIFYING]: 'VYRA is verifying the result.',
  [VoiceState.SPEAKING]: 'VYRA is speaking.',
  [VoiceState.WAITING]: 'VYRA is waiting for you.',
  [VoiceState.ERROR]: 'VYRA ran into a problem.',
  [VoiceState.COMPLETE]: 'VYRA completed the task.',
};

export interface VoiceConfig {
  sttProvider: string;
  ttsProvider: string;
  microphoneId?: string;
  pushToTalkHotkey: string;
  pushToTalkEnabled: boolean;
  wakeWordEnabled: boolean;
  wakeWord: string;
  interruptibleSpeech: boolean;
  voiceId?: string;
  speechRate: number;
}
