/**
 * Memory panel — recall list plus a remember form and per-item forget.
 * Everything is wired to the real memory IPC channels.
 */
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { forgetMemory, recallMemory, rememberMemory, VyraError } from '../api';
import type { MemoryEntry } from '../../main/services.js';
import { formatClockTime } from '../lib/format';

export function MemoryPanel(): JSX.Element {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setEntries(await recallMemory(query.trim() || undefined, undefined, 100));
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not load memories.');
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onRemember = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rememberMemory(key.trim(), value, category.trim() || undefined);
      setKey('');
      setValue('');
      setCategory('');
      await refresh();
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not save that memory.');
    } finally {
      setBusy(false);
    }
  };

  const onForget = async (entryKey: string): Promise<void> => {
    setError(null);
    try {
      await forgetMemory(entryKey);
      await refresh();
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not forget that memory.');
    }
  };

  return (
    <div className="flex h-full flex-col gap-4">
      {error && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <form onSubmit={onRemember} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <h3 className="text-sm font-medium text-slate-200">Remember something</h3>
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
          <input
            value={key}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setKey(e.target.value)}
            placeholder="Key (e.g. favorite-editor)"
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-vyra-accent focus:outline-none"
          />
          <input
            value={value}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
            placeholder="Value (e.g. VS Code)"
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-vyra-accent focus:outline-none"
          />
          <input
            value={category}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setCategory(e.target.value)}
            placeholder="Category (optional)"
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-vyra-accent focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={!key.trim() || busy}
          className="mt-3 rounded-lg bg-vyra-accent px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Remember'}
        </button>
      </form>

      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          placeholder="Search memories…"
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-vyra-accent focus:outline-none"
        />
      </div>

      <div className="vyra-scroll flex-1 space-y-2 overflow-y-auto pr-1">
        {entries.length === 0 ? (
          <p className="rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center text-sm text-slate-400">
            {query ? 'No memories match that search.' : 'VYRA has not remembered anything yet.'}
          </p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.key}
              className="flex items-start justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-100">
                  {entry.key}
                  {entry.category && (
                    <span className="ml-2 rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-slate-400">
                      {entry.category}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 break-words text-sm text-slate-300">{entry.value}</p>
                <p className="mt-1 text-[11px] text-slate-500">
                  Updated {formatClockTime(entry.updatedAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void onForget(entry.key)}
                className="flex-none rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition hover:border-red-400/40 hover:text-red-300"
              >
                Forget
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
