/**
 * Executor-level honesty tests: tools must return ok:false with a stable
 * error code when the underlying capability is unavailable — never ok:true.
 */
import { describe, expect, it } from 'vitest';
import { createBrowserTools } from '../src/browser/tools.js';
import { PlaywrightBrowserProvider } from '../src/browser/playwright-browser.js';
import { createComputerTools } from '../src/computer/tools.js';
import { NutJsComputerProvider } from '../src/computer/nut-computer.js';
import { terminalTools } from '../src/terminal.js';
import { execTool } from './helpers.js';

describe('tool error honesty', () => {
  it('computer_screenshot fails with COMPUTER_UNAVAILABLE on Linux', async () => {
    const tools = createComputerTools(new NutJsComputerProvider());
    const res = await execTool(tools, 'computer_screenshot', {});
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('COMPUTER_UNAVAILABLE');
    expect(res.error?.message).toMatch(/windows/i);
  });

  it('computer_click fails with COMPUTER_UNAVAILABLE on Linux', async () => {
    const tools = createComputerTools(new NutJsComputerProvider());
    const res = await execTool(tools, 'computer_click', { button: 'left' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('COMPUTER_UNAVAILABLE');
  });

  it('browser_open fails with BROWSER_UNAVAILABLE when Playwright is missing', async () => {
    const provider = new PlaywrightBrowserProvider();
    const cap = await provider.checkAvailability();
    if (cap.available) return; // genuinely available here — nothing to prove
    const tools = createBrowserTools(provider);
    const res = await execTool(tools, 'browser_open', { headless: true });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('BROWSER_UNAVAILABLE');
  });

  it('browser_navigate fails with BROWSER_NOT_OPEN when the browser is closed', async () => {
    const tools = createBrowserTools(new PlaywrightBrowserProvider());
    const res = await execTool(tools, 'browser_navigate', { url: 'https://example.com' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('BROWSER_NOT_OPEN');
  });

  it('terminal_run fails with UNSUPPORTED_PLATFORM on Linux', async () => {
    const res = await execTool(terminalTools, 'terminal_run', { command: 'echo hi' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('UNSUPPORTED_PLATFORM');
    expect(res.error?.message).toMatch(/windows/i);
  });

  it('aborted tools report ABORTED, not success', async () => {
    const tools = createComputerTools(new NutJsComputerProvider());
    const tool = tools.find((t) => t.definition.name === 'computer_screenshot');
    if (!tool) throw new Error('computer_screenshot not registered');
    const controller = new AbortController();
    controller.abort();
    const res = await tool.execute(
      {},
      { signal: controller.signal, emit: () => undefined, timeoutMs: 30_000 },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('ABORTED');
  });
});
