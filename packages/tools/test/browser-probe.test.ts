/**
 * Probe tests for PlaywrightBrowserProvider.
 * checkAvailability() must never throw; methods must fail honestly when the
 * browser is not open.
 */
import { describe, expect, it } from 'vitest';
import { PlaywrightBrowserProvider } from '../src/browser/playwright-browser.js';

describe('PlaywrightBrowserProvider probe', () => {
  const provider = new PlaywrightBrowserProvider();

  it('has a stable identity', () => {
    expect(provider.id).toBe('playwright');
    expect(provider.displayName.length).toBeGreaterThan(0);
  });

  it('checkAvailability() never throws and is honest when unavailable', async () => {
    const cap = await provider.checkAvailability();
    expect(typeof cap.available).toBe('boolean');
    if (!cap.available) {
      expect(cap.reason).toBeTruthy();
      expect(cap.reason!.length).toBeGreaterThan(0);
    }
  });

  it('starts closed', () => {
    expect(provider.isOpen()).toBe(false);
  });

  it('methods fail honestly when the browser is not open', async () => {
    await expect(provider.navigate('https://example.com')).rejects.toThrow(/not open/i);
    await expect(provider.read()).rejects.toThrow(/not open/i);
    await expect(provider.screenshot()).rejects.toThrow(/not open/i);
    await expect(provider.newTab()).rejects.toThrow(/not open/i);
    await expect(provider.listTabs()).rejects.toThrow(/not open/i);
    await expect(provider.click('#x')).rejects.toThrow(/not open/i);
  });

  it('close() on a closed browser does not throw', async () => {
    await expect(provider.close()).resolves.toBeUndefined();
  });
});
