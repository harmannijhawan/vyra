/**
 * SessionContext — short-term, in-memory working memory for the current
 * conversation: recent turns, the active task id, and a summary of what's
 * on screen. No persistence by design: session state dies with the process
 * (or on clear()), while durable facts live in SQLiteMemory.
 */

export type SessionRole = 'user' | 'assistant' | 'system';

export interface SessionTurn {
  role: SessionRole;
  text: string;
  timestamp: string;
}

export class SessionContext {
  private turns: SessionTurn[] = [];
  private taskId: string | null = null;
  private screenSummary: string | null = null;

  constructor(private readonly maxTurns: number = 50) {
    if (!Number.isFinite(maxTurns) || maxTurns <= 0) {
      throw new Error('[VYRA session] maxTurns must be a positive number.');
    }
  }

  addTurn(role: SessionRole, text: string): void {
    this.turns.push({ role, text, timestamp: new Date().toISOString() });
    while (this.turns.length > this.maxTurns) {
      this.turns.shift();
    }
  }

  /** The n most recent turns, oldest-first. */
  getRecent(n: number): SessionTurn[] {
    if (n <= 0) return [];
    return this.turns.slice(-n);
  }

  getTurnCount(): number {
    return this.turns.length;
  }

  setTaskContext(taskId: string | null): void {
    this.taskId = taskId;
  }

  getTaskContext(): string | null {
    return this.taskId;
  }

  setScreenContext(summary: string | null): void {
    this.screenSummary = summary;
  }

  getScreenContext(): string | null {
    return this.screenSummary;
  }

  /** Drop all session state. */
  clear(): void {
    this.turns = [];
    this.taskId = null;
    this.screenSummary = null;
  }
}
