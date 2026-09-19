/**
 * @vyra/agent-core — the AGENT CORE of VYRA ("Your PC. Your Voice. Your AI.").
 *
 *  - ToolRegistry: register + validated execution of tools.
 *  - TaskEngine (+ FileTaskStore): task lifecycle, persistence, execution loop.
 *  - Brain: the LISTEN → UNDERSTAND → PLAN → OBSERVE → ACT → VERIFY →
 *    RECOVER → CONTINUE → COMPLETE loop, driven by an AI provider.
 *  - RecoveryEngine: backoff retries, re-observation and alternative tools
 *    when a step fails.
 */
export * from './tool-registry.js';
export * from './task-engine.js';
export * from './brain.js';
export * from './recovery.js';
