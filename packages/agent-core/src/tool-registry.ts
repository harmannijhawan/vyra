/**
 * ToolRegistry — the single place tools are registered and executed.
 *
 * Every execution:
 *  - rejects unknown tools and invalid arguments with structured
 *    ToolResult failures (never throws to the caller),
 *  - validates arguments with validateToolArgs from @vyra/shared
 *    (defaults applied, unknown keys rejected),
 *  - emits 'tool.call' before and 'tool.result' after via ctx.emit,
 *  - measures wall-clock durationMs and stamps the result.
 *
 * Executors that throw instead of returning a ToolResult are converted
 * into structured failures — the registry never lets an exception escape.
 */
import {
  toolFail,
  validateToolArgs,
  type RegisteredTool,
  type ToolContext,
  type ToolDefinition,
  type ToolExecutor,
  type ToolResult,
} from '@vyra/shared';

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  /** Register (or replace) a tool definition + executor. */
  register(definition: ToolDefinition, execute: ToolExecutor): void {
    if (!definition || typeof definition.name !== 'string' || !definition.name) {
      throw new Error('ToolRegistry.register: a definition with a non-empty name is required');
    }
    if (typeof execute !== 'function') {
      throw new Error(`ToolRegistry.register: executor for "${definition.name}" must be a function`);
    }
    this.tools.set(definition.name, { definition, execute });
  }

  /** Remove a tool. Returns true when a tool was removed. Mainly for tests. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** All registered tool definitions (for the Brain's function schemas). */
  listDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  /**
   * Execute a tool by name. Never throws: every failure mode returns a
   * structured ToolResult with ok === false.
   */
  async execute(
    name: string,
    rawArgs: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const args = rawArgs ?? {};

    ctx.emit({
      type: 'tool.call',
      taskId: ctx.taskId,
      payload: { tool: name, args },
    });

    const finish = (result: ToolResult): ToolResult => {
      const completed: ToolResult = {
        ...result,
        durationMs: result.durationMs ?? Date.now() - startedAt,
        timestamp: result.timestamp ?? new Date().toISOString(),
        taskId: result.taskId ?? ctx.taskId,
      };
      ctx.emit({
        type: 'tool.result',
        taskId: ctx.taskId,
        payload: {
          tool: name,
          ok: completed.ok,
          durationMs: completed.durationMs,
          errorCode: completed.error?.code,
          errorMessage: completed.error?.message,
        },
      });
      return completed;
    };

    const registered = this.tools.get(name);
    if (!registered) {
      return finish(
        toolFail(
          'UNKNOWN_TOOL',
          `Unknown tool: "${name}". It is not registered, so VYRA cannot call it.`,
          Date.now() - startedAt,
          { recoverable: false, taskId: ctx.taskId },
        ),
      );
    }

    const validation = validateToolArgs(registered.definition, args);
    if (!validation.valid) {
      return finish(
        toolFail(
          'INVALID_ARGUMENTS',
          `Invalid arguments for tool "${name}": ${validation.errors.join('; ')}`,
          Date.now() - startedAt,
          { recoverable: false, taskId: ctx.taskId },
        ),
      );
    }

    try {
      const result = await registered.execute(validation.normalized ?? {}, ctx);
      if (!result || typeof result.ok !== 'boolean') {
        return finish(
          toolFail(
            'BAD_TOOL_RESULT',
            `Tool "${name}" returned a malformed result (missing "ok"). Treated as failure.`,
            Date.now() - startedAt,
            { taskId: ctx.taskId },
          ),
        );
      }
      return finish(result);
    } catch (err) {
      return finish(
        toolFail(
          'EXECUTOR_THROWN',
          `Tool "${name}" threw instead of returning a ToolResult: ${err instanceof Error ? err.message : String(err)}`,
          Date.now() - startedAt,
          { taskId: ctx.taskId },
        ),
      );
    }
  }
}
