/**
 * electron-builder.yml packaging contract tests.
 *
 * Validates the installer config without needing electron-builder:
 * required keys are asserted against the raw YAML text, and — when
 * js-yaml happens to be installed — the file is additionally parsed
 * as real YAML for structural checks.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const configPath = fileURLToPath(
  new URL('../../../apps/desktop/electron-builder.yml', import.meta.url),
);
const raw = readFileSync(configPath, 'utf8');

function tryParseYaml(text: string): Record<string, unknown> | undefined {
  try {
    const require = createRequire(import.meta.url);
    const yaml = require('js-yaml') as {
      load: (t: string) => Record<string, unknown>;
    };
    return yaml.load(text);
  } catch {
    return undefined; // js-yaml not installed — raw-text assertions still run
  }
}

describe('electron-builder.yml', () => {
  it('identifies the app as VYRA', () => {
    expect(raw).toMatch(/^appId:\s*["']?com\.vyra\.app["']?/m);
    expect(raw).toMatch(/^productName:\s*["']?VYRA["']?/m);
  });

  it('names installer artifacts VYRA-Setup-<version>.<ext>', () => {
    expect(raw).toMatch(/artifactName:.*VYRA-Setup-\$\{version\}\.\$\{ext\}/);
  });

  it('targets NSIS (x64) for Windows', () => {
    expect(raw).toMatch(/target:\s*nsis/);
    expect(raw).toMatch(/arch:\s*\n?\s*-\s*x64/);
  });

  it('bundles the built main, preload and renderer output', () => {
    for (const dir of ['dist/main', 'dist/preload', 'dist/renderer']) {
      expect(raw).toContain(dir);
    }
  });

  it('configures a user-friendly NSIS installer', () => {
    expect(raw).toMatch(/oneClick:\s*false/);
    expect(raw).toMatch(/allowToChangeInstallationDirectory:\s*true/);
    expect(raw).toMatch(/createDesktopShortcut:\s*true/);
    expect(raw).toMatch(/shortcutName:\s*["']?VYRA["']?/);
  });

  it('writes artifacts to the release directory', () => {
    expect(raw).toMatch(/output:\s*["']?release["']?/);
  });

  it('parses as valid YAML with the expected top-level keys (when js-yaml is present)', () => {
    const parsed = tryParseYaml(raw);
    if (!parsed) {
      console.warn('js-yaml not installed; skipping structural YAML check');
      return;
    }
    expect(parsed.appId).toBe('com.vyra.app');
    expect(parsed.productName).toBe('VYRA');
    expect(String(parsed.artifactName)).toContain('VYRA-Setup-');
    const win = parsed.win as Record<string, unknown> | undefined;
    expect(win).toBeDefined();
  });
});
