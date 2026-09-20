/**
 * VYRA secret storage — main process only.
 *
 * API keys are encrypted with Electron's safeStorage (DPAPI on Windows,
 * Keychain on macOS, libsecret on Linux) whenever encryption is available.
 * The encrypted blobs live in a mode-600 `secrets.json` under the data
 * directory — never in settings.json, never in logs, never sent to the
 * renderer.
 *
 * When encryption is unavailable (or an old plaintext file is found), the
 * store falls back to the mode-600 file and migrates plaintext entries to
 * encrypted ones as soon as encryption becomes available. Plaintext is a
 * last resort, and it is logged as such — never silently.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Minimal shape of Electron's safeStorage, injectable for tests. */
export interface KeyEncryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const SECRETS_FILE = 'secrets.json';
const ENCRYPTED_PREFIX = 'vyra-enc:';

/** Build a KeyEncryptor from Electron's safeStorage, or null when unusable. */
export function electronEncryptor(): KeyEncryptor | null {
  try {
    // Lazy require: keeps this module importable in unit tests where the
    // 'electron' module is mocked or absent.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { safeStorage } = require('electron') as {
      safeStorage?: KeyEncryptor;
    };
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage;
    }
    return null;
  } catch {
    return null;
  }
}

export class SecretStore {
  private readonly filePath: string;
  private readonly secrets = new Map<string, string>();

  constructor(
    dataDir: string,
    private readonly encryptor: KeyEncryptor | null,
  ) {
    this.filePath = path.join(dataDir, SECRETS_FILE);
    this.load();
  }

  get(name: string): string | undefined {
    return this.secrets.get(name);
  }

  set(name: string, value: string): void {
    this.secrets.set(name, value);
    this.save();
  }

  private secretsDir(): string {
    return path.dirname(this.filePath);
  }

  private readRawEntries(): Record<string, unknown> | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  private rawIsEncrypted(): boolean {
    const entries = this.readRawEntries();
    if (!entries) return true;
    return Object.values(entries).every(
      (v) => typeof v === 'string' && v.startsWith(ENCRYPTED_PREFIX),
    );
  }

  private load(): void {
    const entries = this.readRawEntries();
    if (!entries) return; // No secrets saved yet.
    for (const [name, value] of Object.entries(entries)) {
      if (typeof value !== 'string' || value.length === 0) continue;
      let secret = value;
      if (value.startsWith(ENCRYPTED_PREFIX)) {
        if (!this.encryptor) continue; // Cannot decrypt — skip, don't crash.
        try {
          secret = this.encryptor.decryptString(
            Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64'),
          );
        } catch {
          continue; // Corrupt entry — skip it.
        }
      }
      this.secrets.set(name, secret);
    }
    // Opportunistic migration: plaintext on disk + encryption available
    // → rewrite encrypted right away.
    if (this.encryptor && !this.rawIsEncrypted()) {
      this.save();
    }
  }

  private save(): void {
    const out: Record<string, string> = {};
    for (const [name, value] of this.secrets) {
      out[name] =
        this.encryptor != null
          ? ENCRYPTED_PREFIX +
            this.encryptor.encryptString(value).toString('base64')
          : value;
    }
    fs.mkdirSync(this.secretsDir(), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(out), { mode: 0o600 });
  }

  /** Push loaded secrets into process.env so providers pick them up. */
  applyToEnv(): void {
    for (const [name, value] of this.secrets) {
      if (value.length > 0 && !process.env[name]) {
        process.env[name] = value;
      }
    }
  }
}
