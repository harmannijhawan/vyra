import { describe, expect, it, vi } from 'vitest';
import {
  NodeHotkeyRegistrar,
  WakeWordService,
  type WakeWordDetector,
} from '../src/index.js';

function stubDetector(): WakeWordDetector {
  return {
    name: 'stub-detector',
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

describe('WakeWordService', () => {
  it('reports unavailable with an honest reason when no detector is configured', async () => {
    const service = new WakeWordService();
    const cap = await service.checkAvailability();
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/no wake-word engine configured/i);
  });

  it('refuses to start listening without a detector (no fake listening)', async () => {
    const service = new WakeWordService();
    await expect(service.startListening(() => undefined)).rejects.toThrow(
      /no wake-word engine configured/i,
    );
    expect(service.isListening()).toBe(false);
  });

  it('becomes available once a real detector is plugged in', async () => {
    const detector = stubDetector();
    const service = new WakeWordService({ detector });
    expect(await service.checkAvailability()).toEqual({ available: true });

    const onWake = vi.fn();
    await service.startListening(onWake);
    expect(service.isListening()).toBe(true);
    expect(service.getPrivacyState()).toEqual({ listening: true, wakeWordEnabled: true });

    await service.stopListening();
    expect(service.isListening()).toBe(false);
    expect(service.getPrivacyState()).toEqual({ listening: false, wakeWordEnabled: true });
  });

  it('privacy state reflects enable/disable; disabling stops listening', async () => {
    const service = new WakeWordService({ detector: stubDetector() });
    await service.startListening(() => undefined);
    expect(service.getPrivacyState().listening).toBe(true);

    service.setEnabled(false);
    // stopListening is async; the flag flips synchronously via the void call.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.getPrivacyState()).toEqual({ listening: false, wakeWordEnabled: false });

    const cap = await service.checkAvailability();
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/disabled/i);

    service.setEnabled(true);
    expect(service.getPrivacyState()).toEqual({ listening: false, wakeWordEnabled: true });
  });

  it('setWakeWord normalizes and rejects empty phrases', () => {
    const service = new WakeWordService();
    service.setWakeWord('  Hey VYRA  ');
    expect(service.getWakeWord()).toBe('hey vyra');
    expect(() => service.setWakeWord('   ')).toThrow(/must not be empty/i);
  });

  it('hotkey registration outside Electron reports unavailable', () => {
    const registrar = new NodeHotkeyRegistrar();
    expect(registrar.isAvailable).toBe(false);
    expect(registrar.register('Ctrl+Alt+V', () => undefined)).toBe(false);

    const service = new WakeWordService();
    expect(service.registerHotkey('Ctrl+Alt+V', () => undefined)).toBe(false);
  });

  it('registerHotkey delegates to an available registrar', () => {
    const register = vi.fn(() => true);
    const service = new WakeWordService({
      hotkeyRegistrar: { isAvailable: true, register, unregister: vi.fn() },
    });
    const handler = () => undefined;
    expect(service.registerHotkey('Ctrl+Alt+V', handler)).toBe(true);
    expect(register).toHaveBeenCalledWith('Ctrl+Alt+V', handler);
  });
});
