/**
 * VYRA product identity constants.
 *
 * The product is VYRA. "VoiceOS" describes the underlying
 * voice-first interaction concept, never the product name.
 * Never brand anything in this codebase as "JARVIS".
 */
export const PRODUCT_NAME = 'VYRA' as const;
export const PRODUCT_TAGLINE = 'Your PC. Your Voice. Your AI.' as const;
export const PRODUCT_SUBTITLE = 'VoiceOS Intelligence' as const;
export const PRODUCT_VERSION = '0.1.0' as const;

/** Canonical "VYRA is …" product-language phrases used across UI + voice. */
export const VYRA_PHRASES = {
  ready: 'VYRA is ready.',
  listening: 'VYRA is listening.',
  analyzing: 'VYRA is analyzing the screen.',
  working: 'VYRA is working on your task.',
  planning: 'VYRA is creating a plan.',
  verifying: 'VYRA is verifying the result.',
  recovering: 'VYRA is recovering from an error.',
  completed: 'VYRA completed the task.',
  interrupted: 'VYRA paused the task.',
} as const;
