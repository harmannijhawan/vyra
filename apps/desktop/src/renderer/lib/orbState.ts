/**
 * Pure mapping: VoiceState → orb CSS class.
 *
 * The Orb component's animation is driven SOLELY by this mapping and the
 * real VoiceState coming from main-process events. Every state in the
 * VoiceState enum must have an entry — the unit test enforces it.
 */
import { VoiceState } from '@vyra/shared';

export const ORB_CLASS_BY_STATE: Record<VoiceState, string> = {
  [VoiceState.IDLE]: 'orb--idle',
  [VoiceState.LISTENING]: 'orb--listening',
  [VoiceState.THINKING]: 'orb--thinking',
  [VoiceState.PLANNING]: 'orb--planning',
  [VoiceState.ACTING]: 'orb--acting',
  [VoiceState.VERIFYING]: 'orb--verifying',
  [VoiceState.SPEAKING]: 'orb--speaking',
  [VoiceState.WAITING]: 'orb--waiting',
  [VoiceState.ERROR]: 'orb--error',
  [VoiceState.COMPLETE]: 'orb--complete',
};

/** Returns the orb CSS class for a voice state; throws on unknown states. */
export function orbClassForState(state: VoiceState): string {
  const cls = ORB_CLASS_BY_STATE[state];
  if (typeof cls !== 'string' || cls.length === 0) {
    throw new Error(`[vyra] no orb animation defined for voice state: ${String(state)}`);
  }
  return cls;
}
