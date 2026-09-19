/**
 * Secret redaction for VYRA's observability layer.
 *
 * `redactSecrets(value)` deep-clones any value and replaces anything that
 * looks like a secret with "[REDACTED]":
 * - values of object keys named like *key / *token / *secret / *password /
 *   *auth / *credential / *private* (case-insensitive),
 * - string values matching known secret shapes: sk-… (OpenAI), ghp_/gho_/
 *   ghu_/ghs_/ghr_… (GitHub), xoxb-/xoxp-/xoxa-/xoxs-… (Slack),
 *   "Bearer <token>" headers, AWS access-key ids (AKIA…), and PEM
 *   "-----BEGIN … PRIVATE KEY-----" blocks.
 *
 * Pure function: it never mutates its input. Circular references are
 * preserved as "[Circular]" rather than recursing forever.
 */
export const REDACTED = '[REDACTED]';

const SECRET_KEY_PATTERN =
  /(api[_-]?key|secret|token|password|passwd|pwd|auth|credential|private[_-]?key|access[_-]?key|session[_-]?key|bearer|client[_-]?secret)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g, // OpenAI-style
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /AIza[A-Za-z0-9_-]{8,}/g, // Google
  /gh[pousr]_[A-Za-z0-9_]{10,}/g, // GitHub
  /github_pat_[A-Za-z0-9_]{10,}/g, // GitHub fine-grained
  /xox[bpas]-[A-Za-z0-9-]{8,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, // PEM blocks
  /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi, // Bearer tokens
];

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactDeep(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object' || value === null) return value;

  if (seen.has(value)) return '[Circular]';

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(redactDeep(item, seen));
    return clone;
  }

  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (!isPlainObject(value)) {
    // Class instances, Buffers, Maps, etc.: leave the reference untouched.
    // (Log records should be plain data; exotic values are rare there.)
    return value;
  }

  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      clone[key] = REDACTED;
    } else {
      clone[key] = redactDeep(child, seen);
    }
  }
  return clone;
}

/**
 * Deep-clone `value`, replacing anything secret-looking with "[REDACTED]".
 * The input is never mutated.
 */
export function redactSecrets<T>(value: T): T {
  return redactDeep(value, new WeakMap()) as T;
}
