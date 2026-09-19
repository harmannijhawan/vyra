/**
 * Probe tests for NutJsComputerProvider on this Linux build host.
 * The provider must report itself unavailable honestly and its methods must
 * reject — never fake success.
 */
import { describe, expect, it } from 'vitest';
import { NutJsComputerProvider } from '../src/computer/nut-computer.js';

describe('NutJsComputerProvider probe (Linux host)', () => {
  const provider = new NutJsComputerProvider();

  it('has a stable identity', () => {
    expect(provider.id).toBe('nutjs-computer');
    expect(provider.displayName.length).toBeGreaterThan(0);
  });

  it('checkAvailability() reports unavailable with an honest reason', async () => {
    const cap = await provider.checkAvailability();
    expect(cap.available).toBe(false);
    expect(cap.reason).toBeTruthy();
    expect(cap.reason).toMatch(/windows/i);
  });

  it('every method rejects instead of faking success', async () => {
    await expect(provider.screenshot()).rejects.toThrow(/windows/i);
    await expect(provider.getCursorPosition()).rejects.toThrow(/windows/i);
    await expect(provider.move(10, 10)).rejects.toThrow(/windows/i);
    await expect(provider.click()).rejects.toThrow(/windows/i);
    await expect(provider.click('right')).rejects.toThrow(/windows/i);
    await expect(provider.doubleClick()).rejects.toThrow(/windows/i);
    await expect(provider.drag(0, 0, 10, 10)).rejects.toThrow(/windows/i);
    await expect(provider.scroll(0, 3)).rejects.toThrow(/windows/i);
    await expect(provider.type('hello')).rejects.toThrow(/windows/i);
    await expect(provider.key('Enter', ['ctrl'])).rejects.toThrow(/windows/i);
    await expect(provider.hotkey(['ctrl', 'c'])).rejects.toThrow(/windows/i);
    await expect(provider.launchApp('notepad')).rejects.toThrow(/windows/i);
    await expect(provider.listWindows()).rejects.toThrow(/windows/i);
    await expect(provider.listProcesses()).rejects.toThrow(/windows/i);
  });
});
