import { describe, expect, it } from 'vitest';
import {
  canTransition,
  createTask,
  TASK_TRANSITIONS,
  TaskStatus,
  TERMINAL_STATUSES,
} from '../src/tasks.js';
import {
  toolFail,
  toolOk,
  validateToolArgs,
  type ToolDefinition,
} from '../src/tools.js';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  INVOKE_PAYLOAD_SCHEMAS,
} from '../src/ipc.js';
import { PRODUCT_NAME, VYRA_PHRASES } from '../src/product.js';

const def: ToolDefinition = {
  name: 'computer_click',
  description: 'Click',
  parameters: {
    button: {
      type: 'string',
      description: 'button',
      enum: ['left', 'right'],
      default: 'left',
    },
    x: { type: 'integer', description: 'x', required: true },
  },
  sideEffecting: true,
  risk: 'normal',
};

describe('validateToolArgs', () => {
  it('accepts valid args and applies defaults', () => {
    const r = validateToolArgs(def, { x: 10 });
    expect(r.valid).toBe(true);
    expect(r.normalized).toEqual({ x: 10, button: 'left' });
  });

  it('rejects missing required params', () => {
    const r = validateToolArgs(def, {});
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Missing required parameter: x/);
  });

  it('rejects wrong types and non-integers', () => {
    expect(validateToolArgs(def, { x: 'a' }).valid).toBe(false);
    expect(validateToolArgs(def, { x: 1.5 }).valid).toBe(false);
  });

  it('rejects enum violations and unknown keys', () => {
    expect(validateToolArgs(def, { x: 1, button: 'middle' }).valid).toBe(false);
    const r = validateToolArgs(def, { x: 1, nope: 2 });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Unknown parameter: nope/);
  });
});

describe('toolOk / toolFail', () => {
  it('builds honest success results', () => {
    const r = toolOk({ a: 1 }, 12);
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBe(12);
    expect(r.timestamp).toBeTruthy();
  });

  it('builds honest failure results (never success on failure)', () => {
    const r = toolFail('E_X', 'broke', 5, { recoverable: false });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('E_X');
    expect(r.error?.recoverable).toBe(false);
  });
});

describe('task transitions', () => {
  it('allows the happy path', () => {
    expect(canTransition(TaskStatus.QUEUED, TaskStatus.PLANNING)).toBe(true);
    expect(canTransition(TaskStatus.PLANNING, TaskStatus.RUNNING)).toBe(true);
    expect(canTransition(TaskStatus.RUNNING, TaskStatus.VERIFYING)).toBe(true);
    expect(canTransition(TaskStatus.VERIFYING, TaskStatus.COMPLETED)).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition(TaskStatus.QUEUED, TaskStatus.COMPLETED)).toBe(false);
    expect(canTransition(TaskStatus.COMPLETED, TaskStatus.RUNNING)).toBe(false);
    expect(canTransition(TaskStatus.FAILED, TaskStatus.QUEUED)).toBe(false);
  });

  it('terminal statuses have no outgoing transitions', () => {
    for (const s of TERMINAL_STATUSES) {
      expect(TASK_TRANSITIONS[s].size).toBe(0);
    }
  });

  it('createTask starts QUEUED with sane defaults', () => {
    const t = createTask('open chrome');
    expect(t.status).toBe(TaskStatus.QUEUED);
    expect(t.goal).toBe('open chrome');
    expect(t.retries).toBe(0);
    expect(t.maxRetries).toBeGreaterThan(0);
  });
});

describe('IPC allowlist security', () => {
  it('contains no wildcards or empty channels', () => {
    for (const c of [...INVOKE_CHANNELS, ...EVENT_CHANNELS]) {
      expect(c).toBeTruthy();
      expect(c).not.toMatch(/[*?]/);
    }
  });

  it('every invoke channel has a payload schema entry', () => {
    for (const c of INVOKE_CHANNELS) {
      expect(INVOKE_PAYLOAD_SCHEMAS[c]).toBeTruthy();
    }
  });

  it('all channels are namespaced to vyra:', () => {
    for (const c of INVOKE_CHANNELS) {
      expect(c.startsWith('vyra:')).toBe(true);
    }
  });
});

describe('product identity', () => {
  it('is branded VYRA everywhere', () => {
    expect(PRODUCT_NAME).toBe('VYRA');
    expect(VYRA_PHRASES.ready).toMatch(/^VYRA/);
  });
});
