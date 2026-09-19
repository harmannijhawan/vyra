/**
 * @vyra/tools — tool definitions + executors for VYRA.
 *
 * Computer, browser, terminal, filesystem, git and GitHub tools. Providers
 * are injected (never constructed here), so tests can mock at the provider
 * boundary and the app can swap implementations.
 */
import type {
  BrowserProvider,
  ComputerProvider,
  RegisteredTool,
  ToolDefinition,
  ToolExecutor,
} from '@vyra/shared';
import { createBrowserTools } from './browser/tools.js';
import { createComputerTools } from './computer/tools.js';
import { filesystemTools } from './filesystem.js';
import { gitTools } from './git.js';
import { githubTools } from './github.js';
import { terminalTools } from './terminal.js';

export { NutJsComputerProvider } from './computer/nut-computer.js';
export { PlaywrightBrowserProvider, type PlaywrightBrowserExtras } from './browser/playwright-browser.js';
export { createBrowserTools } from './browser/tools.js';
export { createComputerTools } from './computer/tools.js';
export { filesystemTools } from './filesystem.js';
export { gitTools } from './git.js';
export { githubTools } from './github.js';
export { terminalTools } from './terminal.js';
export { ToolRuntimeError } from './util.js';

/** Minimal registry surface registerAllTools needs. */
export interface ToolRegistryLike {
  register(definition: ToolDefinition, executor: ToolExecutor): void;
}

export interface ToolsDeps {
  computer: ComputerProvider;
  browser: BrowserProvider;
}

/**
 * Register every tool with the given registry. Returns the registered tools.
 */
export function registerAllTools(registry: ToolRegistryLike, deps: ToolsDeps): RegisteredTool[] {
  const all: RegisteredTool[] = [
    ...createComputerTools(deps.computer),
    ...createBrowserTools(deps.browser),
    ...terminalTools,
    ...filesystemTools,
    ...gitTools,
    ...githubTools,
  ];
  for (const tool of all) {
    registry.register(tool.definition, tool.execute);
  }
  return all;
}
