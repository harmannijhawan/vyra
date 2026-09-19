/**
 * Assistant view — the heart of VYRA: orb, status line, task input,
 * voice controls, live activity feed and the computer preview.
 */
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { VoiceState, VOICE_STATE_PHRASES, type ActivityPayload, type AgentEvent } from '@vyra/shared';
import { Orb } from '../components/Orb';
import { ActivityFeed } from '../components/ActivityFeed';
import { ComputerPreview } from '../components/ComputerPreview';
import { interruptSpeech, pushToTalk, startTask, voiceStart, voiceStop, VyraError } from '../api';

interface AssistantViewProps {
  voiceState: VoiceState;
  activities: Array<AgentEvent<ActivityPayload>>;
  visible: boolean;
  onTaskStarted: () => void;
}

export function AssistantView({ voiceState, activities, visible, onTaskStarted }: AssistantViewProps): JSX.Element {
  const [goal, setGoal] = useState('');
  const [starting, setStarting] = useState(false);
  const [pttHeld, setPttHeld] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listening = voiceState === VoiceState.LISTENING;
  const speaking = voiceState === VoiceState.SPEAKING;

  const submitGoal = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = goal.trim();
    if (!trimmed || starting) return;
    setStarting(true);
    setError(null);
    try {
      await startTask(trimmed);
      setGoal('');
      onTaskStarted();
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not start that task.');
    } finally {
      setStarting(false);
    }
  };

  const toggleListening = async (): Promise<void> => {
    setError(null);
    try {
      if (listening) await voiceStop();
      else await voiceStart();
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Voice control failed.');
    }
  };

  const setPtt = (active: boolean) => async (): Promise<void> => {
    setPttHeld(active);
    try {
      await pushToTalk(active);
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Push-to-talk failed.');
      setPttHeld(false);
    }
  };

  const interrupt = async (): Promise<void> => {
    try {
      await interruptSpeech();
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not interrupt speech.');
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      {error && (
        <div className="flex-none rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid flex-none grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Orb + controls */}
        <div className="flex flex-col items-center rounded-xl border border-white/5 bg-white/[0.02] p-6">
          <Orb state={voiceState} size={200} />
          <p className="mt-4 text-center text-lg font-light text-slate-100" aria-live="polite">
            {VOICE_STATE_PHRASES[voiceState]}
          </p>

          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void toggleListening()}
              title={listening ? 'Stop listening' : 'Start listening'}
              className={`flex h-12 w-12 items-center justify-center rounded-full border transition ${
                listening
                  ? 'border-vyra-accent bg-vyra-accent/20 text-vyra-accent-soft'
                  : 'border-white/15 bg-white/5 text-slate-200 hover:border-vyra-accent/60'
              }`}
            >
              <MicIcon />
            </button>

            <button
              type="button"
              onPointerDown={setPtt(true)}
              onPointerUp={setPtt(false)}
              onPointerLeave={() => {
                if (pttHeld) void setPtt(false)();
              }}
              onContextMenu={(e: { preventDefault(): void }) => e.preventDefault()}
              title="Hold to talk"
              className={`flex h-14 select-none items-center gap-2 rounded-full border px-5 text-sm font-medium transition ${
                pttHeld
                  ? 'border-vyra-accent bg-vyra-accent text-white'
                  : 'border-white/15 bg-white/5 text-slate-200 hover:border-vyra-accent/60'
              }`}
            >
              <PttIcon />
              {pttHeld ? 'Talking…' : 'Hold to talk'}
            </button>

            {speaking && (
              <button
                type="button"
                onClick={() => void interrupt()}
                title="Interrupt VYRA"
                className="flex h-12 w-12 items-center justify-center rounded-full border border-amber-400/40 bg-amber-500/10 text-amber-300 transition hover:bg-amber-500/20"
              >
                <StopIcon />
              </button>
            )}
          </div>

          <form onSubmit={submitGoal} className="mt-5 w-full">
            <div className="flex gap-2">
              <input
                value={goal}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setGoal(e.target.value)}
                placeholder="Tell VYRA what to do…"
                className="w-full rounded-lg border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-vyra-accent focus:outline-none"
              />
              <button
                type="submit"
                disabled={!goal.trim() || starting}
                className="flex-none rounded-lg bg-vyra-accent px-4 py-2.5 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {starting ? '…' : 'Go'}
              </button>
            </div>
          </form>
        </div>

        {/* Computer preview */}
        <div className="min-h-0">
          <ComputerPreview active={visible} />
        </div>
      </div>

      {/* Activity feed */}
      <div className="min-h-0 flex-1">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
          Activity
        </h2>
        <div className="h-[calc(100%-1.75rem)]">
          <ActivityFeed events={activities} />
        </div>
      </div>
    </div>
  );
}

function MicIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function PttIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z" />
      <path d="M19 10a7 7 0 0 1-14 0H3a9 9 0 0 0 8 8.94V21h2v-2.06A9 9 0 0 0 21 10h-2z" />
    </svg>
  );
}

function StopIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
