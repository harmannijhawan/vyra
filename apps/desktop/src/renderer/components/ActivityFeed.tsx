/**
 * Live activity feed — renders 'activity' AgentEvents newest-first.
 * Every line comes from a real event; there is no simulated sequence.
 */
import type { ActivityPayload, AgentEvent } from '@vyra/shared';
import { formatClockTime } from '../lib/format';

const LEVEL_STYLES: Record<ActivityPayload['level'], string> = {
  info: 'border-vyra-accent/30',
  success: 'border-emerald-400/40',
  warning: 'border-amber-400/40',
  error: 'border-red-400/40',
};

const LEVEL_DOT: Record<ActivityPayload['level'], string> = {
  info: 'bg-vyra-accent',
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  error: 'bg-red-400',
};

export function ActivityFeed({ events }: { events: Array<AgentEvent<ActivityPayload>> }): JSX.Element {
  if (events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center">
        <p className="text-sm text-slate-400">No activity yet — ask VYRA to do something.</p>
      </div>
    );
  }

  return (
    <div className="vyra-scroll flex h-full flex-col gap-2 overflow-y-auto pr-1">
      {events.map((event, index) => (
        <div
          key={`${event.timestamp}-${index}`}
          className={`rounded-lg border border-white/5 border-l-2 bg-white/[0.02] px-3 py-2 ${LEVEL_STYLES[event.payload.level]}`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="flex items-center gap-2 text-sm text-slate-100">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${LEVEL_DOT[event.payload.level]}`} />
              {event.payload.message}
            </p>
            <span className="flex-none text-[11px] tabular-nums text-slate-500">
              {formatClockTime(event.timestamp)}
            </span>
          </div>
          {event.payload.detail && (
            <p className="mt-1 pl-3.5 text-xs text-slate-400">{event.payload.detail}</p>
          )}
        </div>
      ))}
    </div>
  );
}
