/**
 * Contract tests: every registered tool has a unique snake_case name, a
 * description, a valid parameter schema and a risk classification — and
 * validateToolArgs rejects bad input.
 */
import { describe, expect, it } from 'vitest';
import { validateToolArgs, type RegisteredTool } from '@vyra/shared';
import { PlaywrightBrowserProvider } from '../src/browser/playwright-browser.js';
import { NutJsComputerProvider } from '../src/computer/nut-computer.js';
import { registerAllTools } from '../src/index.js';

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;
const RISKS = ['safe', 'normal', 'destructive'] as const;

const EXPECTED_TOOLS = [
  // computer (13)
  'computer_screenshot',
  'computer_move',
  'computer_click',
  'computer_right_click',
  'computer_double_click',
  'computer_drag',
  'computer_scroll',
  'computer_type',
  'computer_key',
  'computer_hotkey',
  'computer_launch',
  'computer_windows',
  'computer_processes',
  // browser (9)
  'browser_open',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_read',
  'browser_screenshot',
  'browser_tabs',
  'browser_wait',
  'browser_close',
  // terminal (1)
  'terminal_run',
  // filesystem (4)
  'filesystem_read',
  'filesystem_write',
  'filesystem_edit',
  'filesystem_delete',
  // git (5)
  'git_status',
  'git_diff',
  'git_commit',
  'git_branch',
  'git_push',
  // github (3)
  'github_repository',
  'github_issue',
  'github_pull_request',
];

function collectTools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  registerAllTools(
    {
      register: (definition, execute) => {
        registered.push({ definition, execute });
      },
    },
    { computer: new NutJsComputerProvider(), browser: new PlaywrightBrowserProvider() },
  );
  return registered;
}

const tools = collectTools();
const byName = new Map(tools.map((t) => [t.definition.name, t.definition]));

describe('tools contract', () => {
  it('registers the full expected tool set', () => {
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('every tool has a unique snake_case name', () => {
    const seen = new Set<string>();
    for (const { definition } of tools) {
      expect(definition.name).toMatch(SNAKE_CASE);
      expect(seen.has(definition.name)).toBe(false);
      seen.add(definition.name);
    }
  });

  it('every tool has a non-empty description, parameter schema and risk level', () => {
    for (const { definition, execute } of tools) {
      expect(definition.description.trim().length, definition.name).toBeGreaterThan(0);
      expect(typeof definition.parameters, definition.name).toBe('object');
      for (const [key, param] of Object.entries(definition.parameters)) {
        expect(param.type, `${definition.name}.${key}`).toMatch(
          /^(string|number|integer|boolean|array|object)$/,
        );
        expect(param.description?.trim().length, `${definition.name}.${key}`).toBeGreaterThan(0);
      }
      expect(RISKS, definition.name).toContain(definition.risk);
      expect(typeof definition.sideEffecting, definition.name).toBe('boolean');
      expect(typeof execute, definition.name).toBe('function');
    }
  });

  it('spot-checks risk classifications', () => {
    expect(byName.get('computer_screenshot')?.risk).toBe('safe');
    expect(byName.get('computer_windows')?.risk).toBe('safe');
    expect(byName.get('computer_processes')?.risk).toBe('safe');
    expect(byName.get('browser_read')?.risk).toBe('safe');
    expect(byName.get('filesystem_delete')?.risk).toBe('destructive');
    expect(byName.get('terminal_run')?.risk).toBe('normal');
    expect(byName.get('computer_click')?.risk).toBe('normal');
    expect(byName.get('git_push')?.risk).toBe('normal');
  });

  it('validateToolArgs accepts good input and applies defaults', () => {
    const def = byName.get('computer_click');
    if (!def) throw new Error('computer_click not registered');
    const result = validateToolArgs(def, {});
    expect(result.valid).toBe(true);
    expect(result.normalized).toMatchObject({ button: 'left' });
  });

  it('validateToolArgs rejects bad input', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['computer_click', { button: 'banana' }, 'enum'],
      ['browser_navigate', {}, 'missing url'],
      ['terminal_run', {}, 'missing command'],
      ['filesystem_write', { path: '/tmp/x' }, 'missing content'],
      ['git_commit', {}, 'missing message'],
      ['computer_move', { x: 1.5, y: 2 }, 'non-integer'],
      ['browser_wait', { timeoutMs: 999_999 }, 'schema-level check passes (executor validates range)'],
    ];
    for (const [name, args, why] of cases) {
      const def = byName.get(name);
      if (!def) throw new Error(`${name} not registered`);
      const result = validateToolArgs(def, args);
      if (name === 'browser_wait') {
        // timeoutMs range is enforced by the executor, not the schema.
        expect(result.valid, `${name}: ${why}`).toBe(true);
      } else {
        expect(result.valid, `${name}: ${why}`).toBe(false);
        expect(result.errors.length, `${name}: ${why}`).toBeGreaterThan(0);
      }
    }
  });

  it('validateToolArgs rejects unknown parameters', () => {
    const def = byName.get('terminal_run');
    if (!def) throw new Error('terminal_run not registered');
    const result = validateToolArgs(def, { command: 'echo hi', bogus: true });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unknown parameter/i);
  });
});
