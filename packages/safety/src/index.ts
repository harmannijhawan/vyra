/**
 * @vyra/safety — the safety policy engine for VYRA.
 *
 * Every tool call is classified by SafetyPolicy as 'allow' | 'confirm' |
 * 'deny'. Destructive tools require an explicit UI confirmation; anything
 * ambiguous fails closed to 'deny'.
 */
export * from './policy.js';
