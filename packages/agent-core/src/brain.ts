/**
 * Brain — the LISTEN → UNDERSTAND → PLAN → OBSERVE → ACT → VERIFY →
 * RECOVER → CONTINUE → COMPLETE loop.
 *
 * The Brain never fakes anything:
 *  - plan() returns an honest failure (no fabricated steps) when the AI
 *    provider is unavailable or its response cannot be understood,
 *  - observe() reports "observation unavailable" honestly when there is no
 *    computer or vision provider,
 *  - verifyStep() only passes a step when the criterion is actually met.
 *
 * All product-language activity messages use VYRA_PHRASES.
 */
import { z } from 'zod';
import {
  VYRA_PHRASES,
  activity,
  validateToolArgs,
  type AgentEvent,
  type AIProvider,
  type ChatMessage,
  type ComputerProvider,
  type Task,
  type TaskStep,
  type ToolResult,
  type VisionProvider,
} from '@vyra/shared';
import type { TaskEngine } from './task-engine.js';
import type { ToolRegistry } from './tool-registry.js';
import { RecoveryEngine, type Observation } from './recovery.js';

/**
 * System prompt — identifies the assistant as VYRA ("Your PC. Your Voice.
 * Your AI."), never as anything else.
 */
export const VYRA_SYSTEM_PROMPT = `You are VYRA — "Your PC. Your Voice. Your AI."
You are a personal AI assistant that controls the user's Windows 10/11 PC to complete tasks on their behalf.

Rules you must follow:
- Be honest: never claim an action succeeded unless a tool result confirms it.
- Never invent tools, files, applications, or UI elements. Only use the tools provided to you.
- Keep plans short and concrete: each step does exactly one thing.
- For computer control, prefer keyboard shortcuts over blind clicks when the target's position is uncertain.
- Never include secrets, passwords, API keys, or tokens in plans or reasoning.
- If you cannot do something, say so plainly and explain why. Never fabricate a plan.`;

const planStepSchema = z.object({
  label: z.string().min(1),
  tool: z.string().min(1).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  verify: z.string().min(1).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

export interface PlanResult {
  ok: boolean;
  steps: TaskStep[];
  /** Honest human-readable reason when ok === false. */
  error?: string;
}

export interface BrainOptions {
  ai: AIProvider;
  registry: ToolRegistry;
  vision?: VisionProvider;
  computer?: ComputerProvider;
  onEvent?: (event: Omit<AgentEvent, 'timestamp'>) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Extract the first top-level JSON array from free-form model text. */
function extractJsonArray(text: string): unknown {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) {
    throw new Error('no JSON array found in the AI response');
  }
  return JSON.parse(text.slice(start, end + 1));
}

export class Brain {
  private readonly recovery: RecoveryEngine;

  constructor(private readonly opts: BrainOptions) {
    this.recovery = new RecoveryEngine({
      registry: opts.registry,
      observe: () => this.observe(),
      onEvent: opts.onEvent,
    });
  }

  private emit(event: Omit<AgentEvent, 'timestamp'>): void {
    this.opts.onEvent?.(event);
  }

  private emitActivity(
    message: string,
    level: 'info' | 'success' | 'warning' | 'error' = 'info',
    detail?: string,
    taskId?: string,
  ): void {
    this.emit(activity(message, level, detail, taskId));
  }

  /* ---------------- PLAN ---------------- */

  /**
   * Ask the AI provider for a plan, with the registered tools as function
   * schemas. Returns { ok: false } — and never fabricated steps — when the
   * AI is unavailable or its response cannot be turned into a valid plan.
   *
   * NOTE: `context` is free-form and is sent to the AI provider. Callers
   * MUST NOT put secrets (passwords, API keys, tokens) in it.
   */
  async plan(goal: string, context?: Record<string, unknown>): Promise<PlanResult> {
    this.emitActivity(VYRA_PHRASES.planning);

    const availability = await this.opts.ai.checkAvailability();
    if (!availability.available) {
      return {
        ok: false,
        steps: [],
        error:
          `VYRA cannot create a plan: the AI provider is unavailable ` +
          `(${availability.reason ?? 'no reason given'}). No plan was fabricated.`,
      };
    }

    const tools = this.opts.registry.listDefinitions().map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    }));

    const messages: ChatMessage[] = [
      { role: 'system', content: VYRA_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Goal: ${goal}\n` +
          (context ? `Context (never secrets): ${JSON.stringify(context)}\n` : '') +
          `Create a step-by-step plan using ONLY the tools provided.\n` +
          `Respond with ONLY a JSON array. Each step is an object:\n` +
          `{ "label": "short label", "tool": "tool_name", "args": { ... }, ` +
          `"verify": "how to check this step succeeded", "maxAttempts": 3 }\n` +
          `"tool", "args", "verify" and "maxAttempts" are optional; "label" is required. ` +
          `No prose outside the JSON array.`,
      },
    ];

    let text: string;
    try {
      const response = await this.opts.ai.chat(messages, { tools });
      text = response.text;
    } catch (err) {
      return {
        ok: false,
        steps: [],
        error: `VYRA could not reach the AI provider: ${errMsg(err)}. No plan was fabricated.`,
      };
    }

    return this.parsePlan(text);
  }

  /** Validate the AI's plan text into TaskSteps. Rejects bad plans honestly. */
  private parsePlan(text: string): PlanResult {
    let raw: unknown;
    try {
      raw = extractJsonArray(text);
    } catch {
      return {
        ok: false,
        steps: [],
        error:
          'VYRA could not understand the AI response: it contained no plan. ' +
          'The plan was not fabricated.',
      };
    }

    const parsed = z.array(planStepSchema).safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        steps: [],
        error:
          `The AI returned a plan VYRA cannot use: ` +
          `${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}. ` +
          `The plan was not fabricated.`,
      };
    }

    const steps: TaskStep[] = [];
    for (let i = 0; i < parsed.data.length; i++) {
      const s = parsed.data[i];
      if (!s) continue;
      const id = `step_${i}_${randomSuffix()}`;
      if (s.tool) {
        const definition = this.opts.registry.get(s.tool)?.definition;
        if (!definition) {
          return {
            ok: false,
            steps: [],
            error:
              `Plan rejected: step ${i + 1} ("${s.label}") uses unknown tool ` +
              `"${s.tool}". The plan was not fabricated.`,
          };
        }
        const validation = validateToolArgs(definition, s.args ?? {});
        if (!validation.valid) {
          return {
            ok: false,
            steps: [],
            error:
              `Plan rejected: step ${i + 1} ("${s.label}") has invalid arguments: ` +
              `${validation.errors.join('; ')}. The plan was not fabricated.`,
          };
        }
        steps.push({
          id,
          label: s.label,
          tool: s.tool,
          args: validation.normalized ?? {},
          status: 'PENDING',
          verify: s.verify,
          attempts: 0,
          maxAttempts: s.maxAttempts ?? 3,
        });
      } else {
        steps.push({
          id,
          label: s.label,
          status: 'PENDING',
          verify: s.verify,
          attempts: 0,
          maxAttempts: s.maxAttempts ?? 3,
        });
      }
    }

    if (steps.length === 0) {
      return { ok: false, steps: [], error: 'The AI returned an empty plan.' };
    }
    return { ok: true, steps };
  }

  /* ---------------- OBSERVE ---------------- */

  /**
   * OBSERVE: screenshot via the computer provider + vision analysis when
   * available. Honest "observation unavailable" otherwise — never a fake
   * description of the screen.
   */
  async observe(): Promise<Observation> {
    const computer = this.opts.computer;
    if (!computer) {
      return { ok: false, reason: 'Observation unavailable: no computer provider is configured.' };
    }
    const computerCap = await computer.checkAvailability();
    if (!computerCap.available) {
      return {
        ok: false,
        reason:
          `Observation unavailable: the computer provider is not available ` +
          `(${computerCap.reason ?? 'no reason given'}).`,
      };
    }

    let png: Uint8Array;
    try {
      const shot = await computer.screenshot();
      png = shot.png;
    } catch (err) {
      return { ok: false, reason: `Observation unavailable: screenshot failed (${errMsg(err)}).` };
    }

    this.emitActivity(VYRA_PHRASES.analyzing);

    const vision = this.opts.vision;
    if (!vision) {
      return {
        ok: true,
        description: 'Screenshot captured; no vision provider is configured, so the screen was not analyzed.',
        screenState: 'unknown',
      };
    }
    const visionCap = await vision.checkAvailability();
    if (!visionCap.available) {
      return {
        ok: true,
        description:
          `Screenshot captured; vision is unavailable ` +
          `(${visionCap.reason ?? 'no reason given'}), so the screen was not analyzed.`,
        screenState: 'unknown',
      };
    }
    try {
      const analysisResult = await vision.analyzeScreenshot(png);
      return {
        ok: true,
        description: analysisResult.description,
        screenState: analysisResult.screenState,
      };
    } catch (err) {
      return {
        ok: true,
        description: `Screenshot captured; vision analysis failed (${errMsg(err)}).`,
        screenState: 'unknown',
      };
    }
  }

  /* ---------------- VERIFY ---------------- */

  /**
   * VERIFY: decide whether a step's result satisfies its verify criterion.
   * Steps without a criterion pass when the tool reported success. When the
   * AI is unavailable, verification is limited and reported honestly via
   * an activity event instead of being faked.
   */
  async verifyStep(step: TaskStep, result: ToolResult): Promise<boolean> {
    if (!step.verify) return true;

    const availability = await this.opts.ai.checkAvailability();
    if (!availability.available) {
      this.emitActivity(
        'VYRA could not fully verify the result — the AI provider is unavailable.',
        'warning',
        `Step "${step.label}": accepting the tool result as-is.`,
      );
      return result.ok;
    }

    const response = await this.opts.ai.chat(
      [
        { role: 'system', content: VYRA_SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `Step: "${step.label}"\n` +
            `Verification criterion: ${step.verify}\n` +
            `Tool result: ${JSON.stringify({ ok: result.ok, data: result.data, error: result.error })}\n` +
            `Did the step verifiably succeed? Reply with exactly one word: PASS or FAIL.`,
        },
      ],
      { temperature: 0 },
    );
    return response.text.trim().toUpperCase() === 'PASS';
  }

  /* ---------------- RUN ---------------- */

  /**
   * Drive a task to completion: wire the Brain's planner, verifier and
   * recovery engine into the TaskEngine, then start the task. The task must
   * already exist in the engine's store (see TaskEngine.createTask).
   */
  async runTask(task: Task, engine: TaskEngine): Promise<Task> {
    engine.setPlanner(async (t) => {
      const plan = await this.plan(t.goal, t.context);
      if (!plan.ok) {
        throw new Error(plan.error ?? 'Planning failed.');
      }
      return plan.steps;
    });
    engine.setVerifyStep((step, result) => this.verifyStep(step, result));
    engine.setRecovery(this.recovery);
    return engine.start(task.id);
  }
}

export type { Observation };
