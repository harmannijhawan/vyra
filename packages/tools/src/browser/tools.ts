/**
 * @vyra/tools — browser_* tool definitions + executors against a BrowserProvider.
 */
import type {
  BrowserProvider,
  BrowserTabInfo,
  RegisteredTool,
  ToolContext,
  ToolDefinition,
} from '@vyra/shared';
import { runTool, ToolRuntimeError, truncateText, type ToolBody } from '../util.js';
import type { PlaywrightBrowserExtras } from './playwright-browser.js';

type BrowserDeps = BrowserProvider & Partial<PlaywrightBrowserExtras>;

function define(definition: ToolDefinition, body: ToolBody): RegisteredTool {
  return { definition, execute: (args, ctx: ToolContext) => runTool(definition, args, ctx, body) };
}

function ensureOpen(browser: BrowserDeps): void {
  if (typeof browser.isOpen === 'function' && !browser.isOpen()) {
    throw new ToolRuntimeError('BROWSER_NOT_OPEN', 'The browser is not open. Call browser_open first.', {
      recoverable: true,
    });
  }
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolRuntimeError('INVALID_ARGS', `${name} must be a non-empty string.`, {
      recoverable: false,
    });
  }
  return value;
}

function validHttpUrl(raw: string): string {
  const value = nonEmpty(raw, 'url');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ToolRuntimeError('INVALID_URL', `"${value}" is not a valid URL.`, { recoverable: false });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolRuntimeError('INVALID_URL', 'Only http(s) URLs can be opened in the browser.', {
      recoverable: false,
    });
  }
  return value;
}

const MAX_TEXT_CHARS = 20_000;

export function createBrowserTools(browser: BrowserDeps): RegisteredTool[] {
  return [
    define(
      {
        name: 'browser_open',
        description: 'Open the automated Chromium browser (headless by default). Idempotent — safe to call when already open.',
        parameters: {
          headless: { type: 'boolean', description: 'Run without a visible window.', default: true },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        const cap = await browser.checkAvailability();
        if (!cap.available) {
          throw new ToolRuntimeError('BROWSER_UNAVAILABLE', cap.reason ?? 'Browser automation is not available.', {
            recoverable: true,
            recoveryHint: 'Install Playwright and run `npx playwright install chromium`.',
          });
        }
        const headless = args.headless as boolean;
        await browser.open({ headless });
        return { open: true, headless };
      },
    ),

    define(
      {
        name: 'browser_navigate',
        description: 'Navigate the active tab to an http(s) URL and wait for the page to load.',
        parameters: {
          url: { type: 'string', description: 'The http(s) URL to navigate to.', required: true },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        ensureOpen(browser);
        const url = validHttpUrl(args.url as string);
        await browser.navigate(url);
        return { url, navigated: true };
      },
    ),

    define(
      {
        name: 'browser_click',
        description: 'Click the element matching a CSS selector in the active tab.',
        parameters: {
          selector: { type: 'string', description: 'CSS selector of the element to click.', required: true },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        ensureOpen(browser);
        const selector = nonEmpty(args.selector, 'selector');
        await browser.click(selector);
        return { selector, clicked: true };
      },
    ),

    define(
      {
        name: 'browser_type',
        description: 'Type text into the element matching a CSS selector. Set clear:true to replace existing content first.',
        parameters: {
          selector: { type: 'string', description: 'CSS selector of the input element.', required: true },
          text: { type: 'string', description: 'Text to type.', required: true },
          clear: { type: 'boolean', description: 'Clear existing content before typing.', default: false },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        ensureOpen(browser);
        const selector = nonEmpty(args.selector, 'selector');
        const text = args.text as string;
        const clear = args.clear as boolean;
        await browser.type(selector, text, { clear });
        return { selector, chars: text.length, cleared: clear };
      },
    ),

    define(
      {
        name: 'browser_read',
        description: 'Read the active tab: page title, URL and visible text (truncated to 20000 chars).',
        parameters: {},
        sideEffecting: false,
        risk: 'safe',
      },
      async () => {
        ensureOpen(browser);
        const page = await browser.read();
        const { text, truncated } = truncateText(page.text, MAX_TEXT_CHARS);
        return { title: page.title, url: page.url, text, truncated };
      },
    ),

    define(
      {
        name: 'browser_screenshot',
        description: 'Capture the active tab as a PNG image. Returns base64-encoded PNG bytes plus dimensions.',
        parameters: {},
        sideEffecting: false,
        risk: 'safe',
      },
      async () => {
        ensureOpen(browser);
        const shot = await browser.screenshot();
        return {
          imageBase64: shot.png.toString('base64'),
          mimeType: 'image/png',
          width: shot.width,
          height: shot.height,
          bytes: shot.png.length,
        };
      },
    ),

    define(
      {
        name: 'browser_tabs',
        description:
          'Manage browser tabs. Actions: list (default), new (optional url), activate (tabId), close (tabId). Popups opened by pages appear in the list as inactive tabs.',
        parameters: {
          action: {
            type: 'string',
            description: 'Tab operation to perform.',
            enum: ['list', 'new', 'activate', 'close'],
            default: 'list',
          },
          url: { type: 'string', description: 'URL to open when action is "new".' },
          tabId: { type: 'string', description: 'Tab id for "activate" and "close" (see list output).' },
        },
        sideEffecting: true,
        risk: 'normal',
      },
      async (args) => {
        ensureOpen(browser);
        const action = args.action as string;
        switch (action) {
          case 'list': {
            const tabs = await browser.listTabs();
            return { tabs, count: tabs.length };
          }
          case 'new': {
            const url = args.url === undefined ? undefined : validHttpUrl(args.url as string);
            const tab: BrowserTabInfo = await browser.newTab(url);
            return { tab };
          }
          case 'activate': {
            const tabId = nonEmpty(args.tabId, 'tabId');
            await browser.activateTab(tabId);
            return { tabId, active: true };
          }
          case 'close': {
            const tabId = nonEmpty(args.tabId, 'tabId');
            await browser.closeTab(tabId);
            return { tabId, closed: true };
          }
          default:
            throw new ToolRuntimeError('INVALID_ARGS', `Unknown action: "${action}".`, {
              recoverable: false,
            });
        }
      },
    ),

    define(
      {
        name: 'browser_wait',
        description: 'Wait for a page load state or for a CSS selector to appear. Returns whether the condition was reached in time.',
        parameters: {
          waitFor: {
            type: 'string',
            description: 'What to wait for.',
            enum: ['load', 'domcontentloaded', 'networkidle', 'selector'],
            default: 'load',
          },
          selector: { type: 'string', description: 'CSS selector (required when waitFor is "selector").' },
          timeoutMs: {
            type: 'integer',
            description: 'Timeout in milliseconds (max 60000).',
            default: 10_000,
          },
        },
        sideEffecting: false,
        risk: 'safe',
      },
      async (args) => {
        ensureOpen(browser);
        const waitFor = args.waitFor as string;
        const timeoutMs = args.timeoutMs as number;
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
          throw new ToolRuntimeError('INVALID_ARGS', 'timeoutMs must be an integer between 1 and 60000.', {
            recoverable: false,
          });
        }
        if (waitFor === 'selector') {
          const selector = nonEmpty(args.selector, 'selector');
          const reached = await browser.waitForSelector(selector, timeoutMs);
          return { waitFor, selector, timeoutMs, reached };
        }
        const reached = await browser.waitFor(waitFor as 'load' | 'domcontentloaded' | 'networkidle', timeoutMs);
        return { waitFor, timeoutMs, reached };
      },
    ),

    define(
      {
        name: 'browser_close',
        description: 'Close the automated browser and all its tabs.',
        parameters: {},
        sideEffecting: true,
        risk: 'normal',
      },
      async () => {
        await browser.close();
        return { closed: true };
      },
    ),
  ];
}
