/**
 * PlaywrightBrowserProvider — real browser automation via Playwright (Chromium).
 *
 * The playwright module is lazy-loaded inside try/catch: importing this file
 * must NEVER throw. checkAvailability() reports { available: false } with an
 * honest reason when the module or the Chromium binary is missing.
 *
 * Popup handling: pages opened by the site (context "page" events) are tracked
 * as inactive tabs and surfaced through an onPopup callback. Popups never
 * silently steal the active tab.
 */
import type {
  BrowserProvider,
  BrowserTabInfo,
  ProviderCapability,
  Screenshot,
} from '@vyra/shared';
import type { Browser, BrowserContext, Page } from 'playwright';
import { access } from 'node:fs/promises';
import { errorMessage } from '../util.js';

type PlaywrightModule = typeof import('playwright');

/** Extra surface of this provider beyond the BrowserProvider contract. */
export interface PlaywrightBrowserExtras {
  /** True once open() has succeeded and close() has not been called. */
  isOpen(): boolean;
  /** Called (best-effort) whenever the page opens a popup/new window. */
  setOnPopup(cb: (tab: BrowserTabInfo) => void): void;
}

let cachedPw: PlaywrightModule | null = null;

async function loadPlaywright(): Promise<PlaywrightModule> {
  if (cachedPw) return cachedPw;
  try {
    cachedPw = await import('playwright');
  } catch (err) {
    throw new Error(
      `Playwright module is not installed: ${errorMessage(err)}. ` +
        'Install it (`npm install playwright`) and download a browser.',
    );
  }
  return cachedPw;
}

const NAV_TIMEOUT_MS = 30_000;

export class PlaywrightBrowserProvider implements BrowserProvider, PlaywrightBrowserExtras {
  readonly id = 'playwright';
  readonly displayName = 'Playwright (Chromium)';

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private tabs = new Map<string, Page>();
  private pageToId = new Map<Page, string>();
  private activeTabId: string | null = null;
  private tabSeq = 0;
  /** Set while open()/newTab() create their own page, so the "page" event is not mistaken for a popup. */
  private expectingOwnPage = false;
  private onPopup: ((tab: BrowserTabInfo) => void) | null = null;

  isOpen(): boolean {
    return this.browser !== null && this.context !== null;
  }

  setOnPopup(cb: (tab: BrowserTabInfo) => void): void {
    this.onPopup = cb;
  }

  async checkAvailability(): Promise<ProviderCapability> {
    let pw: PlaywrightModule;
    try {
      pw = await loadPlaywright();
    } catch (err) {
      return {
        available: false,
        reason:
          `Playwright module is not installed (${errorMessage(err)}). ` +
          'Install it and run `npx playwright install chromium`.',
      };
    }
    try {
      const exe = pw.chromium.executablePath();
      await access(exe);
      return { available: true };
    } catch {
      return {
        available: false,
        reason: 'Playwright browser binary not installed — run `npx playwright install chromium`.',
      };
    }
  }

  async open(opts: { headless?: boolean } = {}): Promise<void> {
    if (this.isOpen()) return; // idempotent
    const pw = await loadPlaywright();
    const cap = await this.checkAvailability();
    if (!cap.available) {
      throw new Error(cap.reason ?? 'Playwright is not available.');
    }
    const headless = opts.headless ?? true;
    let browser: Browser;
    try {
      browser = await pw.chromium.launch({ headless });
    } catch (err) {
      throw new Error(`Failed to launch Chromium: ${errorMessage(err)}`);
    }
    try {
      this.context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    } catch (err) {
      await browser.close().catch(() => undefined);
      throw new Error(`Failed to create a browser context: ${errorMessage(err)}`);
    }
    this.browser = browser;
    this.context.on('page', (page) => this.handleNewPage(page));
    // First tab becomes the active tab.
    this.expectingOwnPage = true;
    try {
      const page = await this.context.newPage();
      const id = this.pageToId.get(page) ?? this.registerTab(page);
      this.activeTabId = id;
    } finally {
      this.expectingOwnPage = false;
    }
  }

  async close(): Promise<void> {
    const context = this.context;
    const browser = this.browser;
    this.reset();
    // Close context first, then the browser; never throw from close().
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }

  async newTab(url?: string): Promise<BrowserTabInfo> {
    const context = this.requireContext();
    this.expectingOwnPage = true;
    let page: Page;
    try {
      page = await context.newPage();
    } finally {
      this.expectingOwnPage = false;
    }
    const id = this.pageToId.get(page) ?? this.registerTab(page);
    this.activeTabId = id;
    if (url) {
      await this.gotoPage(page, url);
    }
    return this.tabInfo(id, page);
  }

  async listTabs(): Promise<BrowserTabInfo[]> {
    this.requireContext();
    const infos: BrowserTabInfo[] = [];
    for (const [id, page] of this.tabs) {
      if (!page.isClosed()) {
        infos.push(await this.tabInfo(id, page));
      }
    }
    return infos;
  }

  async activateTab(id: string): Promise<void> {
    const page = this.tabs.get(id);
    if (!page || page.isClosed()) {
      throw new Error(`Unknown or closed tab: "${id}".`);
    }
    await page.bringToFront().catch(() => undefined);
    this.activeTabId = id;
  }

  async closeTab(id: string): Promise<void> {
    const page = this.tabs.get(id);
    if (!page) {
      throw new Error(`Unknown tab: "${id}".`);
    }
    await page.close().catch(() => undefined);
    this.forgetTab(id);
  }

  async navigate(url: string): Promise<void> {
    await this.gotoPage(this.activePage(), url);
  }

  async back(): Promise<void> {
    const page = this.activePage();
    try {
      // Returns null when there is no history — an honest no-op, not an error.
      await page.goBack({ timeout: 15_000 });
    } catch (err) {
      throw new Error(`back() failed: ${errorMessage(err)}`);
    }
  }

  async reload(): Promise<void> {
    const page = this.activePage();
    try {
      await page.reload({ timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      throw new Error(`reload() failed: ${errorMessage(err)}`);
    }
  }

  async click(selector: string): Promise<void> {
    const page = this.activePage();
    try {
      await page.click(selector, { timeout: 10_000 });
    } catch (err) {
      throw new Error(`click("${selector}") failed: ${errorMessage(err)}`);
    }
  }

  async type(selector: string, text: string, opts: { clear?: boolean } = {}): Promise<void> {
    const page = this.activePage();
    try {
      if (opts.clear) {
        await page.fill(selector, text, { timeout: 10_000 });
      } else {
        await page.click(selector, { timeout: 10_000 });
        await page.keyboard.type(text);
      }
    } catch (err) {
      throw new Error(`type("${selector}") failed: ${errorMessage(err)}`);
    }
  }

  async pressKey(key: string): Promise<void> {
    const page = this.activePage();
    try {
      await page.keyboard.press(key);
    } catch (err) {
      throw new Error(`pressKey("${key}") failed: ${errorMessage(err)}`);
    }
  }

  async scroll(opts: { x?: number; y?: number; selector?: string } = {}): Promise<void> {
    const page = this.activePage();
    const dx = opts.x ?? 0;
    const dy = opts.y ?? 0;
    try {
      await page.evaluate(
        ({ sel, deltaX, deltaY }) => {
          const el = sel ? document.querySelector(sel) : null;
          const target = el ?? document.scrollingElement ?? document.documentElement;
          target.scrollBy(deltaX, deltaY);
          return true;
        },
        { sel: opts.selector ?? null, deltaX: dx, deltaY: dy },
      );
    } catch (err) {
      throw new Error(`scroll failed: ${errorMessage(err)}`);
    }
  }

  async read(): Promise<{ title: string; url: string; text: string }> {
    const page = this.activePage();
    try {
      const title = await page.title().catch(() => '');
      const url = this.safeUrl(page);
      const text = await page
        .evaluate(() => (document.body ? document.body.innerText : ''))
        .catch(() => '');
      return { title, url, text };
    } catch (err) {
      throw new Error(`read() failed: ${errorMessage(err)}`);
    }
  }

  async screenshot(): Promise<Screenshot> {
    const page = this.activePage();
    try {
      const png = await page.screenshot({ type: 'png' });
      const vp = page.viewportSize();
      return {
        png: Buffer.from(png),
        width: vp?.width ?? 0,
        height: vp?.height ?? 0,
      };
    } catch (err) {
      throw new Error(`screenshot failed: ${errorMessage(err)}`);
    }
  }

  async waitFor(
    state: 'load' | 'domcontentloaded' | 'networkidle',
    timeoutMs = 10_000,
  ): Promise<boolean> {
    const page = this.activePage();
    try {
      await page.waitForLoadState(state, { timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  async waitForSelector(selector: string, timeoutMs = 10_000): Promise<boolean> {
    const page = this.activePage();
    try {
      await page.waitForSelector(selector, { timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private requireContext(): BrowserContext {
    if (!this.context) {
      throw new Error('The browser is not open — call browser_open first.');
    }
    return this.context;
  }

  private activePage(): Page {
    this.requireContext();
    const id = this.activeTabId;
    const page = id ? this.tabs.get(id) : undefined;
    if (!page || page.isClosed()) {
      if (id) this.forgetTab(id);
      throw new Error('There is no active browser tab. Open the browser and create a tab first.');
    }
    return page;
  }

  private async gotoPage(page: Page, url: string): Promise<void> {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      throw new Error(`Navigation to ${url} failed: ${errorMessage(err)}`);
    }
  }

  /** Register a page and return its new tab id. */
  private registerTab(page: Page): string {
    const id = `tab-${++this.tabSeq}`;
    this.tabs.set(id, page);
    this.pageToId.set(page, id);
    page.on('close', () => this.forgetTab(id));
    return id;
  }

  /**
   * Fired by Playwright for every new page in the context — including the ones
   * we create ourselves. Own pages are claimed silently; genuine popups are
   * tracked as inactive tabs and reported via onPopup, never made active.
   */
  private handleNewPage(page: Page): void {
    if (this.pageToId.has(page)) return;
    const id = this.registerTab(page);
    if (this.expectingOwnPage) {
      // Our own page — open()/newTab() will activate it below.
      return;
    }
    const info: BrowserTabInfo = { id, title: '', url: this.safeUrl(page), active: false };
    try {
      this.onPopup?.(info);
    } catch {
      // A failing callback must never break the provider.
    }
  }

  private forgetTab(id: string): void {
    const page = this.tabs.get(id);
    this.tabs.delete(id);
    if (page) this.pageToId.delete(page);
    if (this.activeTabId === id) {
      // Activate another tab rather than leaving a dangling active id.
      const next = this.tabs.keys().next();
      this.activeTabId = next.done ? null : next.value;
    }
  }

  private async tabInfo(id: string, page: Page): Promise<BrowserTabInfo> {
    const title = await page.title().catch(() => '');
    return { id, title, url: this.safeUrl(page), active: id === this.activeTabId };
  }

  private safeUrl(page: Page): string {
    try {
      return page.url();
    } catch {
      return '';
    }
  }

  private reset(): void {
    this.tabs.clear();
    this.pageToId.clear();
    this.activeTabId = null;
    this.expectingOwnPage = false;
    this.browser = null;
    this.context = null;
  }
}
