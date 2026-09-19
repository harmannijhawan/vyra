/**
 * Logs view — live terminal (from 'log' events) plus history queried
 * through vyra:logs:query with level / task filters.
 */
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import type { StructuredLog } from '@vyra/shared';
import { invoke, VyraError } from '../api';
import { TerminalPanel } from '../components/TerminalPanel';

interface LogsViewProps {
  liveLogs: StructuredLog[];
}

const LEVELS = ['all', 'debug', 'info', 'warn', 'error'] as const;

export function LogsView({ liveLogs }: LogsViewProps): JSX.Element {
  const [level, setLevel] = useState<string>('all');
  const [taskId, setTaskId] = useState('');
  const [history, setHistory] = useState<StructuredLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const shown = history ?? liveLogs;

  const queryHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<StructuredLog[]>('vyra:logs:query', {
        level: level === 'all' ? undefined : level,
        taskId: taskId.trim() || undefined,
        limit: 500,
      });
      setHistory(result);
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not query logs.');
    } finally {
      setLoading(false);
    }
  }, [level, taskId]);

  useEffect(() => {
    // While watching the live stream, clear any stale history.
    setHistory(null);
  }, [liveLogs.length]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      <div className="flex flex-none flex-wrap items-center gap-3">
        <h1 className="text-xl font-light text-slate-100">Logs</h1>
        <select
          value={level}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => setLevel(e.target.value)}
          className="rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-sm text-slate-200 focus:border-vyra-accent focus:outline-none"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l === 'all' ? 'All levels' : l}
            </option>
          ))}
        </select>
        <input
          value={taskId}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setTaskId(e.target.value)}
          placeholder="Filter by task id…"
          className="rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-vyra-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void queryHistory()}
          disabled={loading}
          className="rounded-lg border border-white/15 px-4 py-1.5 text-sm text-slate-200 transition hover:bg-white/5 disabled:opacity-50"
        >
          {loading ? 'Querying…' : 'Query history'}
        </button>
        {history && (
          <button
            type="button"
            onClick={() => setHistory(null)}
            className="rounded-lg border border-white/15 px-4 py-1.5 text-sm text-slate-400 transition hover:bg-white/5"
          >
            Back to live
          </button>
        )}
      </div>

      {error && (
        <div className="flex-none rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <TerminalPanel logs={shown} />
      </div>
    </div>
  );
}
