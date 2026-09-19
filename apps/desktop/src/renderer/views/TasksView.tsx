/**
 * Tasks view — list of tasks from vyra:task:list plus the TaskPanel for
 * the selected task. Refreshes on every task.* event from the engine.
 */
import { useCallback, useEffect, useState } from 'react';
import { type Task } from '@vyra/shared';
import { cancelTask, listTasks, VyraError } from '../api';
import { TaskPanel } from '../components/TaskPanel';
import { formatClockTime } from '../lib/format';

export function TasksView({ refreshSignal }: { refreshSignal: number }): JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const next = await listTasks(100, true);
      setTasks(next);
      if (next.length > 0 && !next.some((t) => t.id === selectedId)) {
        setSelectedId(next[0].id);
      }
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not load tasks.');
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshSignal]);

  const onCancel = async (taskId: string): Promise<void> => {
    setCancelling(true);
    setError(null);
    try {
      await cancelTask(taskId);
      await refresh();
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not cancel the task.');
    } finally {
      setCancelling(false);
    }
  };

  const selected = tasks.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      <h1 className="flex-none text-xl font-light text-slate-100">Tasks</h1>
      {error && (
        <div className="flex-none rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      {loading ? (
        <p className="text-sm text-slate-500">Loading tasks…</p>
      ) : tasks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center">
          <p className="text-sm text-slate-400">No tasks yet — give VYRA a goal from the Assistant view.</p>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-5">
          <div className="vyra-scroll space-y-2 overflow-y-auto pr-1 lg:col-span-2">
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => setSelectedId(task.id)}
                className={`w-full rounded-xl border p-3 text-left transition ${
                  task.id === selectedId
                    ? 'border-vyra-accent/60 bg-vyra-accent/10'
                    : 'border-white/5 bg-white/[0.02] hover:border-white/15'
                }`}
              >
                <p className="truncate text-sm font-medium text-slate-100">{task.goal}</p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {task.status} · {formatClockTime(task.updatedAt)}
                </p>
              </button>
            ))}
          </div>
          <div className="lg:col-span-3">
            <TaskPanel task={selected} onCancel={(id) => void onCancel(id)} cancelling={cancelling} />
          </div>
        </div>
      )}
    </div>
  );
}
