/**
 * Preload bridge allowlist — pure, testable logic.
 *
 * The renderer may ONLY:
 *  - invoke() channels listed in INVOKE_CHANNELS
 *  - listen to channels listed in EVENT_CHANNELS
 *
 * Anything else throws. The unit test asserts these lists EXACTLY equal
 * the @vyra/shared allowlists (no more, no less), so the bridge can never
 * drift from the contract.
 */
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '@vyra/shared';

/** Exact copy of the invoke allowlist — must equal INVOKE_CHANNELS. */
export const ALLOWED_INVOKE_CHANNELS: readonly string[] = [...INVOKE_CHANNELS];

/** Exact copy of the event allowlist — must equal EVENT_CHANNELS. */
export const ALLOWED_EVENT_CHANNELS: readonly string[] = [...EVENT_CHANNELS];

/** Throws unless `channel` is an allowed invoke channel. */
export function assertInvokeChannel(channel: string): void {
  if (!ALLOWED_INVOKE_CHANNELS.includes(channel)) {
    throw new Error(`[vyra] blocked invoke on non-allowlisted channel: ${channel}`);
  }
}

/** Throws unless `channel` is an allowed event channel. */
export function assertEventChannel(channel: string): void {
  if (!ALLOWED_EVENT_CHANNELS.includes(channel)) {
    throw new Error(`[vyra] blocked listen on non-allowlisted channel: ${channel}`);
  }
}
