/**
 * Unit tests for the main-process SecretStore.
 * Uses a fake encryptor — Electron's safeStorage is never touched here.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SecretStore, type KeyEncryptor } from '../src/main/secrets.js';

function fakeEncryptor(): KeyEncryptor {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('corrupt');
      return s.slice(4);
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vyra-secrets-test-'));
  delete process.env.VYRA_TEST_SECRET_A;
});

describe('SecretStore', () => {
  it('round-trips a secret through the fake encryptor', () => {
    const store = new SecretStore(dir, fakeEncryptor());
    store.set('VYRA_TEST_SECRET_A', 'shhh');
    const raw = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as Record<string, string>;
    expect(raw.VYRA_TEST_SECRET_A.startsWith('vyra-enc:')).toBe(true);
    expect(raw.VYRA_TEST_SECRET_A).not.toContain('shhh');

    const reloaded = new SecretStore(dir, fakeEncryptor());
    expect(reloaded.get('VYRA_TEST_SECRET_A')).toBe('shhh');
  });

  it('migrates a legacy plaintext file to encrypted on load', () => {
    const plain = new SecretStore(dir, null);
    plain.set('VYRA_TEST_SECRET_A', 'legacy-plain');
    let raw = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as Record<string, string>;
    expect(raw.VYRA_TEST_SECRET_A).toBe('legacy-plain');

    const migrated = new SecretStore(dir, fakeEncryptor());
    expect(migrated.get('VYRA_TEST_SECRET_A')).toBe('legacy-plain');
    raw = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as Record<string, string>;
    expect(raw.VYRA_TEST_SECRET_A.startsWith('vyra-enc:')).toBe(true);
  });

  it('falls back to plaintext when no encryptor is available', () => {
    const store = new SecretStore(dir, null);
    store.set('VYRA_TEST_SECRET_A', 'plain-ok');
    const raw = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as Record<string, string>;
    expect(raw.VYRA_TEST_SECRET_A).toBe('plain-ok');
    expect(new SecretStore(dir, null).get('VYRA_TEST_SECRET_A')).toBe('plain-ok');
  });

  it('skips entries it cannot decrypt instead of crashing', () => {
    const store = new SecretStore(dir, fakeEncryptor());
    store.set('VYRA_TEST_SECRET_A', 'good');
    // Corrupt the blob on disk.
    const raw = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as Record<string, string>;
    raw.VYRA_TEST_SECRET_A = 'vyra-enc:!!!not-base64!!!';
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify(raw));
    const reloaded = new SecretStore(dir, fakeEncryptor());
    expect(reloaded.get('VYRA_TEST_SECRET_A')).toBeUndefined();
  });

  it('applyToEnv loads secrets into process.env without overwriting', () => {
    process.env.VYRA_TEST_SECRET_A = 'from-env';
    const store = new SecretStore(dir, null);
    store.set('VYRA_TEST_SECRET_A', 'from-disk');
    store.applyToEnv();
    expect(process.env.VYRA_TEST_SECRET_A).toBe('from-env');
    delete process.env.VYRA_TEST_SECRET_A;
    store.applyToEnv();
    expect(process.env.VYRA_TEST_SECRET_A).toBe('from-disk');
    delete process.env.VYRA_TEST_SECRET_A;
  });

  it('starts empty when no secrets file exists', () => {
    const store = new SecretStore(dir, fakeEncryptor());
    expect(store.get('MISSING')).toBeUndefined();
  });
});
