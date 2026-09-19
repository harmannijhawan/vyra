/**
 * Terminal panel — renders 'log' AgentEvents (StructuredLog records) as a
 * monospace terminal with auto-scroll. Only real log records appear.
 */
import { useEffect, useRef } from 'react';
import type { StructuredLog } from '@vyra/shared';
import { formatClockTime } from '../lib/format';

const LEVEL_COLORS: Record<StructuredLog['level'], string> = {
  debug: 'text-slate-500',
  info: 'text-slate-300',
  warn: 'text-amber-300',
  error: 'text-red-300',
};

export function TerminalPanel({ logs }: { logs: StructuredLog[] }): JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Auto-scroll only if the user is already near the bottom.
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [logs.length]);

  if (logs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-white/5 bg-black/40 p-8 text-center">
        <p className="vyra-terminal text-slate-500">// no log output yet</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="vyra-terminal vyra-scroll h-full overflow-y-auto rounded-xl border border-white/5 bg-black/40 p-4"
    >
      {logs.map((log, i) => (
        <div key={`${log.timestamp}-${i}`} className="whitespace-pre-wrap break-words">
          <span className="text-slate-600">[{formatClockTime(log.timestamp)}]</span>{' '}
          <span className={LEVEL_COLORS[log.level]}>{log.level.toUpperCase().padEnd(5)}</span>{' '}
          <span className="text-vyra-accent-soft">{log.component}</span>{' '}
          <span className="text-slate-200">{log.action}</span>
          {log.result && <span className="text-slate-400"> — {log.result}</span>}
          {log.error && (
            <span className="text-red-300">
              {' '}
              ✕ [{log.error.code}] {log.error.message}
            </span>
          )}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
