/**
 * Live computer preview — polls vyra:computer:latest-frame every 2s while
 * the Assistant view is visible and renders the real screenshot frame.
 * No frame → honest empty state, never a placeholder image.
 */
import { useEffect, useRef, useState } from 'react';
import { getProvidersStatus, latestComputerFrame, VyraError } from '../api';
import type { ComputerFrame } from '../../main/services.js';
import { timeAgo } from '../lib/format';

const POLL_MS = 2000;

export function ComputerPreview({ active }: { active: boolean }): JSX.Element {
  const [frame, setFrame] = useState<ComputerFrame | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      if (timer.current !== null) {
        window.clearInterval(timer.current);
        timer.current = null;
      }
      return;
    }

    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const next = await latestComputerFrame();
        if (!cancelled) {
          setFrame(next);
          setFailed(false);
          setNow(Date.now());
          if (!next) {
            // No frame — surface the REAL reason instead of a generic message.
            try {
              const statuses = await getProvidersStatus();
              const computer = statuses.find((s) => s.kind === 'computer');
              if (!cancelled) {
                setUnavailableReason(
                  computer && !computer.available
                    ? (computer.reason ?? 'Computer control is unavailable.')
                    : null,
                );
              }
            } catch {
              if (!cancelled) setUnavailableReason(null);
            }
          } else {
            setUnavailableReason(null);
          }
        }
      } catch (err) {
        // A missing engine surfaces here — show the honest empty state.
        if (!cancelled && err instanceof VyraError) {
          setFailed(true);
        }
      }
    };

    void poll();
    timer.current = window.setInterval(() => void poll(), POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 5000);

    return () => {
      cancelled = true;
      if (timer.current !== null) window.clearInterval(timer.current);
      window.clearInterval(clock);
      timer.current = null;
    };
  }, [active]);

  if (!frame || failed) {
    return (
      <div className="flex h-full min-h-[220px] items-center justify-center rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center">
        <div>
          <p className="text-sm text-slate-300">
            {failed ? 'Computer preview unavailable.' : 'No computer preview available.'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {unavailableReason ?? 'VYRA will show the live screen here while it works on your computer.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black">
      <img
        src={frame.dataUrl}
        alt="Live view of the computer screen"
        className="block max-h-[420px] w-full object-contain"
        draggable={false}
      />
      <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 backdrop-blur">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-slate-200">Live</span>
      </div>
      <div className="absolute bottom-3 right-3 rounded-full bg-black/70 px-3 py-1 text-[11px] tabular-nums text-slate-300 backdrop-blur">
        Updated {timeAgo(frame.capturedAt, now)}
      </div>
    </div>
  );
}
