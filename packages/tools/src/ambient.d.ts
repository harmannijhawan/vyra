/**
 * Ambient declarations for VYRA's optional native dependencies.
 *
 * @nut-tree-fork/nut-js and playwright are lazy-loaded at runtime inside
 * try/catch (see the providers) so that importing @vyra/tools NEVER crashes
 * on a host where they are missing. The declarations below describe only the
 * API surface VYRA actually uses; they were verified against the published
 * type definitions of @nut-tree-fork/nut-js@4.2.6 and the Playwright 1.x API.
 */

declare module '@nut-tree-fork/nut-js' {
  export interface NutPoint {
    x: number;
    y: number;
  }

  export interface NutRegion {
    left: number;
    top: number;
    width: number;
    height: number;
  }

  /** Numeric key ids; member names match the published Key enum. */
  export const Key: { readonly [name: string]: number };

  export const Button: {
    readonly LEFT: number;
    readonly MIDDLE: number;
    readonly RIGHT: number;
  };

  export const FileType: {
    readonly PNG: string;
    readonly JPG: string;
  };

  export interface MouseClass {
    getPosition(): Promise<NutPoint>;
    setPosition(target: NutPoint): Promise<unknown>;
    move(path: NutPoint[] | Promise<NutPoint[]>): Promise<unknown>;
    leftClick(): Promise<unknown>;
    rightClick(): Promise<unknown>;
    click(btn: number): Promise<unknown>;
    doubleClick(btn: number): Promise<unknown>;
    pressButton(btn: number): Promise<unknown>;
    releaseButton(btn: number): Promise<unknown>;
    drag(path: NutPoint[] | Promise<NutPoint[]>): Promise<unknown>;
    scrollUp(amount: number): Promise<unknown>;
    scrollDown(amount: number): Promise<unknown>;
    scrollLeft(amount: number): Promise<unknown>;
    scrollRight(amount: number): Promise<unknown>;
    config: { autoDelayMs: number; mouseSpeed: number };
  }

  export interface KeyboardClass {
    type(...input: Array<string | number>): Promise<unknown>;
    pressKey(...keys: number[]): Promise<unknown>;
    releaseKey(...keys: number[]): Promise<unknown>;
    config: { autoDelayMs: number };
  }

  export interface ScreenClass {
    width(): Promise<number>;
    height(): Promise<number>;
    /**
     * Capture the main display to a PNG/JPG file; resolves with the file path.
     */
    capture(
      fileName: string,
      fileFormat?: string,
      filePath?: string,
      fileNamePrefix?: string,
      fileNamePostfix?: string,
    ): Promise<string>;
  }

  export interface NutWindow {
    readonly title: Promise<string>;
    readonly region: Promise<NutRegion>;
    getTitle(): Promise<string>;
    getRegion(): Promise<NutRegion>;
    focus(): Promise<boolean>;
  }

  export const mouse: MouseClass;
  export const keyboard: KeyboardClass;
  export const screen: ScreenClass;
  export function getWindows(): Promise<NutWindow[]>;
  export function getActiveWindow(): Promise<NutWindow>;
}

declare module 'playwright' {
  export type LoadState = 'load' | 'domcontentloaded' | 'networkidle';

  export interface ViewportSize {
    width: number;
    height: number;
  }

  export interface PageKeyboard {
    press(key: string): Promise<void>;
    type(text: string): Promise<void>;
  }

  export interface Page {
    goto(url: string, opts?: { waitUntil?: LoadState; timeout?: number }): Promise<unknown>;
    goBack(opts?: { timeout?: number }): Promise<unknown>;
    reload(opts?: { timeout?: number }): Promise<unknown>;
    click(selector: string, opts?: { timeout?: number }): Promise<void>;
    fill(selector: string, text: string, opts?: { timeout?: number }): Promise<void>;
    bringToFront(): Promise<void>;
    isClosed(): boolean;
    title(): Promise<string>;
    url(): string;
    viewportSize(): ViewportSize | null;
    keyboard: PageKeyboard;
    evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
    evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
    screenshot(opts?: { type?: 'png' | 'jpeg' }): Promise<Buffer>;
    waitForLoadState(state?: LoadState, opts?: { timeout?: number }): Promise<void>;
    waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
    close(): Promise<void>;
    on(event: 'close', listener: () => void): this;
  }

  export interface BrowserContext {
    newPage(): Promise<Page>;
    pages(): Page[];
    close(): Promise<void>;
    on(event: 'page', listener: (page: Page) => void): this;
  }

  export interface Browser {
    newContext(opts?: { viewport?: ViewportSize }): Promise<BrowserContext>;
    close(): Promise<void>;
    isConnected(): boolean;
  }

  export const chromium: {
    launch(opts?: { headless?: boolean }): Promise<Browser>;
    /** Throws when the browser binary has not been downloaded. */
    executablePath(): string;
  };
}
