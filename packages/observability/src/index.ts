/**
 * @vyra/observability — structured JSONL logging with secret redaction.
 *
 * Every record is passed through redactSecrets() before it is written,
 * so API keys and tokens can never reach the log files or the live panel.
 */
export * from './redact.js';
export * from './logger.js';
