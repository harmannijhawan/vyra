/**
 * SafetyPolicy — the gate every tool call passes through.
 *
 * evaluate(toolName, args) returns one of:
 * - 'allow'   — safe or normal-risk tools with benign arguments.
 * - 'confirm' — destructive-risk tools; the UI must show a
 *               'safety.confirm.request' AgentEvent (carrying requestId,
 *               question, tool, args) and await requestConfirmation().
 * - 'deny'    — never allowed. Fail closed: unknown tools, the deny list,
 *               and argument-based denials (deleting system roots,
 *               destructive shell commands) all land here.
 *
 * Confirmation lifecycle:
 * - requestConfirmation() emits the request event and returns a
 *   Promise<boolean> resolved by the UI's 'safety.confirm.response'
 *   (handled via handleResponse(requestId, approved)).
 * - Timeouts (default 60s) resolve to FALSE — deny by default, fail closed.
 *
 * Tools never exposed: the deny list is empty by default. Deny-by-default
 * for specific tools is a deployment decision: pass denyList to the
 * constructor (e.g. an enterprise build could deny 'terminal_run').
 */
import type { AgentEvent } from '@vyra/shared';

export type PolicyDecision = 'allow' | 'confirm' | 'deny';

export interface SafetyConfirmRequest {
  requestId: string;
  question: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface SafetyPolicyOptions {
  /** Confirmation timeout in ms. Default 60_000. Times out to DENY. */
  confirmTimeoutMs?: number;
  /** Tool names that are never exposed. Empty by default (documented). */
  denyList?: string[];
}

const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;

/** Filesystem roots that must never be deleted, recursively or not. */
const PROTECTED_ROOTS = [
  'c:/windows',
  '/', // POSIX root
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/boot',
];

/** Matches a bare Windows drive root like "c:" (normalized form of C:\). */
const DRIVE_ROOT_PATTERN = /^[a-z]:$/;

/** Destructive shell commands — always denied, never confirmed. */
const DESTRUCTIVE_COMMAND_PATTERN =
  /(rm\s+-rf\s+\/|format\s+[a-z]:|shutdown\s+\/s|mkfs(\.[a-z0-9]+)?\s|:\(\)\s*{\s*:\|:\s*&\s*}\s*;?\s*:|dd\s+if=\S+\s+of=\/dev\/)/i;

function normalizePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase().replace(/\\/g, '/');
  if (trimmed === '') return undefined;
  // Keep a single "/" for the POSIX root; strip other trailing slashes.
  return trimmed === '/' ? '/' : trimmed.replace(/\/+$/, '');
}

function isProtectedRoot(path: unknown): boolean {
  const normalized = normalizePath(path);
  if (!normalized) return false;
  // The drive root itself (C:\, C:/) — but not anything beneath it.
  if (DRIVE_ROOT_PATTERN.test(normalized)) return true;
  return PROTECTED_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(root + '/'),
  );
}

/** Names of tools whose "delete everything" arguments must be blocked. */
const DELETE_LIKE_TOOLS = new Set([
  'filesystem_delete',
  'file_delete',
  'delete_file',
  'remove_file',
  'fs_delete',
]);

const TERMINAL_LIKE_TOOLS = new Set([
  'terminal_run',
  'shell_run',
  'run_command',
  'exec',
]);

export class SafetyPolicy {
  private readonly denyList: Set<string>;
  private readonly confirmTimeoutMs: number;
  private readonly pending = new Map<string, (approved: boolean) => void>();
  private requestSeq = 0;

  /**
   * @param toolDefinitions tool name → definition (must include risk).
   * @param emit emits AgentEvents (e.g. 'safety.confirm.request') to the UI.
   */
  constructor(
    private readonly toolDefinitions: Map<string, { risk: string }>,
    private readonly emit: (event: Omit<AgentEvent, 'timestamp'>) => void,
    opts: SafetyPolicyOptions = {},
  ) {
    this.denyList = new Set(opts.denyList ?? []);
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  }

  /**
   * Classify a proposed tool call. Pure (no side effects, no I/O).
   * Unknown tools are denied — fail closed.
   */
  evaluate(toolName: string, args: Record<string, unknown>): PolicyDecision {
    if (this.denyList.has(toolName)) return 'deny';

    const definition = this.toolDefinitions.get(toolName);
    if (!definition) return 'deny'; // unknown tool → fail closed

    if (this.isArgBasedDenial(toolName, args)) return 'deny';

    switch (definition.risk) {
      case 'safe':
      case 'normal':
        return 'allow';
      case 'destructive':
        return 'confirm';
      default:
        return 'deny'; // unknown risk classification → fail closed
    }
  }

  /**
   * Argument-based denials — specific argument shapes that are never
   * allowed regardless of the tool's risk classification.
   */
  private isArgBasedDenial(
    toolName: string,
    args: Record<string, unknown>,
  ): boolean {
    // Never delete system roots / the whole drive.
    if (DELETE_LIKE_TOOLS.has(toolName)) {
      const target = args.path ?? args.target ?? args.dir;
      if (isProtectedRoot(target)) return true;
    }

    // Never run known-destructive shell commands.
    if (TERMINAL_LIKE_TOOLS.has(toolName)) {
      const command = args.command ?? args.cmd ?? args.script;
      if (
        typeof command === 'string' &&
        DESTRUCTIVE_COMMAND_PATTERN.test(command)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Ask the user to confirm a destructive action. Emits
   * 'safety.confirm.request' and resolves true only when the UI answers
   * approved via handleResponse(). Times out to false (DENY).
   */
  requestConfirmation(
    tool: string,
    args: Record<string, unknown>,
    question?: string,
  ): Promise<boolean> {
    const requestId = `safety-${Date.now()}-${++this.requestSeq}`;
    const payload: SafetyConfirmRequest = {
      requestId,
      question: question ?? `Allow VYRA to run "${tool}"?`,
      tool,
      args,
    };
    this.emit({
      type: 'safety.confirm.request',
      payload: {
        ...payload,
        risk: 'destructive' as const,
      },
    });
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false); // timeout → deny (fail closed)
      }, this.confirmTimeoutMs);
      // Don't let a pending confirmation keep the process alive on its own.
      const nodeTimer = timer as unknown as { unref?: () => void };
      if (typeof nodeTimer.unref === 'function') nodeTimer.unref();
      this.pending.set(requestId, (approved: boolean) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(approved);
      });
    });
  }

  /**
   * Resolve a pending confirmation from the UI's
   * 'safety.confirm.response'. Returns false when the requestId is
   * unknown (already resolved, timed out, or never existed).
   */
  handleResponse(requestId: string, approved: boolean): boolean {
    const resolve = this.pending.get(requestId);
    if (!resolve) return false;
    resolve(approved);
    return true;
  }

  /** Number of confirmations currently awaiting a UI answer. */
  pendingCount(): number {
    return this.pending.size;
  }
}
