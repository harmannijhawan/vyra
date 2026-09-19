/**
 * Current-task panel: goal, color-coded status badge, per-step progress,
 * and a cancel button. Renders only real Task objects from the engine.
 */
import { TaskStatus, TERMINAL_STATUSES, type StepStatus, type Task } from '@vyra/shared';

const STATUS_STYLES: Record<TaskStatus, string> = {
  [TaskStatus.QUEUED]: 'bg-slate-500/15 text-slate-300 border-slate-400/30',
  [TaskStatus.PLANNING]: 'bg-vyra-accent/15 text-vyra-accent-soft border-vyra-accent/40',
  [TaskStatus.RUNNING]: 'bg-blue-500/15 text-blue-300 border-blue-400/30',
  [TaskStatus.WAITING]: 'bg-amber-500/15 text-amber-300 border-amber-400/30',
  [TaskStatus.VERIFYING]: 'bg-cyan-500/15 text-cyan-300 border-cyan-400/30',
  [TaskStatus.RECOVERING]: 'bg-orange-500/15 text-orange-300 border-orange-400/30',
  [TaskStatus.COMPLETED]: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30',
  [TaskStatus.FAILED]: 'bg-red-500/15 text-red-300 border-red-400/30',
  [TaskStatus.CANCELLED]: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
};

const STEP_DOT: Record<StepStatus, string> = {
  PENDING: 'bg-slate-600',
  RUNNING: 'bg-blue-400 animate-pulse',
  VERIFYING: 'bg-cyan-400 animate-pulse',
  DONE: 'bg-emerald-400',
  FAILED: 'bg-red-400',
  SKIPPED: 'bg-slate-700',
};

interface TaskPanelProps {
  task: Task | null;
  onCancel: (taskId: string) => void;
  cancelling: boolean;
}

export function TaskPanel({ task, onCancel, cancelling }: TaskPanelProps): JSX.Element {
  if (!task) {
    return (
      <div className="flex h-full min-h-[160px] items-center justify-center rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center">
        <p className="text-sm text-slate-400">No active task. Give VYRA a goal to get started.</p>
      </div>
    );
  }

  const terminal = TERMINAL_STATUSES.has(task.status);
  const doneSteps = task.steps.filter((s) => s.status === 'DONE').length;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">Current task</p>
          <h3 className="mt-1 truncate text-base font-medium text-slate-100" title={task.goal}>
            {task.goal}
          </h3>
        </div>
        <span
          className={`flex-none rounded-full border px-3 py-1 text-xs font-medium ${STATUS_STYLES[task.status]}`}
        >
          {task.status}
        </span>
      </div>

      {task.steps.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
            <span>Steps</span>
            <span className="tabular-nums">
              {doneSteps}/{task.steps.length}
            </span>
          </div>
          <div className="vyra-scroll max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {task.steps.map((step, i) => (
              <div key={step.id} className="flex items-center gap-2.5 text-sm">
                <span className={`h-2 w-2 flex-none rounded-full ${STEP_DOT[step.status]}`} />
                <span className="flex-none tabular-nums text-slate-500">{i + 1}.</span>
                <span className="truncate text-slate-200" title={step.label}>
                  {step.label}
                </span>
                <span className="ml-auto flex-none text-[11px] uppercase tracking-wide text-slate-500">
                  {step.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {task.waitingFor && (
        <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Waiting: {task.waitingFor}
        </p>
      )}

      {!terminal && (
        <button
          type="button"
          onClick={() => onCancel(task.id)}
          disabled={cancelling}
          className="mt-4 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {cancelling ? 'Cancelling…' : 'Cancel task'}
        </button>
      )}
    </div>
  );
}
