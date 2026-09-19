/**
 * Shared helpers for @vyra/tools unit tests.
 */
import type { RegisteredTool, ToolContext, ToolResult } from '@vyra/shared';

export function makeCtx(timeoutMs = 30_000): ToolContext {
  return {
    signal: new AbortController().signal,
    emit: () => undefined,
    timeoutMs,
  };
}

export function getTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool;
}

export async function execTool(
  tools: RegisteredTool[],
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return getTool(tools, name).execute(args, makeCtx());
}
