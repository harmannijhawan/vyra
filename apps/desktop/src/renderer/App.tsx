/**
 * VYRA app shell — sidebar nav, top status bar (real VoiceState phrase),
 * event routing from the multiplexed vyra:event channel, safety dialogs,
 * and the first-run onboarding gate.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PRODUCT_NAME,
  VoiceState,
  VOICE_STATE_PHRASES,
  type ActivityPayload,
  type AgentEvent,
  type SafetyConfirmRequestPayload,
  type StructuredLog,
  type VoiceStatePayload,
} from '@vyra/shared';
import { getOnboardingState, onEvent, VyraError } from './api';
import { useSpokenReplies } from './lib/useSpokenReplies';
import type { OnboardingState } from '../main/services.js';
import { AssistantView } from './views/AssistantView';
import { TasksView } from './views/TasksView';
import { MemoryView } from './views/MemoryView';
import { LogsView } from './views/LogsView';
import { SettingsView } from './views/SettingsView';
import { OnboardingView } from './views/OnboardingView';
import { SafetyDialog } from './components/SafetyDialog';

type ViewId = 'assistant' | 'tasks' | 'memory' | 'logs' | 'settings';

const NAV: Array<{ id: ViewId; label: string }> = [
  { id: 'assistant', label: 'Assistant' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'memory', label: 'Memory' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' },
];

const MAX_ACTIVITIES = 200;
const MAX_LOGS = 1000;

export function App(): JSX.Element {
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>('assistant');
  const [voiceState, setVoiceState] = useState<VoiceState>(VoiceState.IDLE);
  const [activities, setActivities] = useState<Array<AgentEvent<ActivityPayload>>>([]);
  const [logs, setLogs] = useState<StructuredLog[]>([]);
  const [taskRefresh, setTaskRefresh] = useState(0);
  const [safetyRequests, setSafetyRequests] = useState<SafetyConfirmRequestPayload[]>([]);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const onboardingLoaded = useRef(false);

  // VYRA reads task results aloud (Puter/ElevenLabs) when voice output is on.
  useSpokenReplies();

  const loadOnboarding = useCallback(async () => {
    try {
      setOnboarding(await getOnboardingState());
    } catch (err) {
      // If onboarding state can't load, don't trap the user — show the app.
      console.warn('[vyra] onboarding state unavailable:', err);
      setOnboarding({ completed: true, currentStep: '', completedSteps: [] });
    }
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = onEvent((event: AgentEvent) => {
        switch (event.type) {
          case 'voice.state': {
            const payload = event.payload as VoiceStatePayload;
            if (payload?.to) setVoiceState(payload.to);
            break;
          }
          case 'activity': {
            const activity = event as AgentEvent<ActivityPayload>;
            setActivities((prev) => [activity, ...prev].slice(0, MAX_ACTIVITIES));
            break;
          }
          case 'log': {
            const record = event.payload as StructuredLog;
            if (record?.action) setLogs((prev) => [...prev.slice(-(MAX_LOGS - 1)), record]);
            break;
          }
          case 'task.created':
          case 'task.status':
          case 'task.step.start':
          case 'task.step.end':
            setTaskRefresh((n) => n + 1);
            break;
          case 'safety.confirm.request': {
            const req = event.payload as SafetyConfirmRequestPayload;
            if (req?.requestId) {
              setSafetyRequests((prev) =>
                prev.some((r) => r.requestId === req.requestId) ? prev : [...prev, req],
              );
            }
            break;
          }
          case 'safety.confirm.response': {
            const res = event.payload as { requestId?: string };
            if (res?.requestId) {
              setSafetyRequests((prev) => prev.filter((r) => r.requestId !== res.requestId));
            }
            break;
          }
          default:
            break;
        }
      });
    } catch (err) {
      setBridgeError(err instanceof VyraError ? err.message : 'Could not connect to VYRA.');
    }

    if (!onboardingLoaded.current) {
      onboardingLoaded.current = true;
      void loadOnboarding();
    }

    return () => {
      unsubscribe?.();
    };
  }, [loadOnboarding]);

  if (bridgeError) {
    return (
      <div className="flex h-full items-center justify-center bg-vyra-bg p-8 text-center">
        <div>
          <p className="text-xl font-light text-slate-100">{PRODUCT_NAME} could not start.</p>
          <p className="mt-2 text-sm text-slate-400">{bridgeError}</p>
        </div>
      </div>
    );
  }

  if (onboarding === null) {
    return (
      <div className="flex h-full items-center justify-center bg-vyra-bg">
        <p className="text-sm text-slate-500">Starting VYRA…</p>
      </div>
    );
  }

  if (!onboarding.completed) {
    return (
      <div className="h-full bg-vyra-bg">
        <OnboardingView initial={onboarding} onDone={() => void loadOnboarding()} />
      </div>
    );
  }

  return (
    <div className="flex h-full bg-vyra-bg text-slate-100">
      {/* Sidebar */}
      <aside className="flex w-52 flex-none flex-col border-r border-white/5 bg-black/30">
        <div className="px-5 pb-6 pt-6">
          <p className="text-lg font-semibold tracking-[0.25em] text-slate-100">{PRODUCT_NAME}</p>
          <p className="mt-1 text-[11px] text-slate-500">Your PC. Your Voice. Your AI.</p>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                view === item.id
                  ? 'bg-vyra-accent/15 text-slate-100'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="px-5 py-4">
          <p className="flex items-center gap-2 text-[11px] text-slate-500">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                voiceState === VoiceState.ERROR ? 'bg-red-400' : 'bg-emerald-400'
              }`}
            />
            {VOICE_STATE_PHRASES[voiceState]}
          </p>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-none items-center justify-between border-b border-white/5 px-6 py-3">
          <p className="text-sm text-slate-300" aria-live="polite">
            {VOICE_STATE_PHRASES[voiceState]}
          </p>
          <p className="text-[11px] uppercase tracking-widest text-slate-600">{view}</p>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          {view === 'assistant' && (
            <AssistantView
              voiceState={voiceState}
              activities={activities}
              visible={view === 'assistant'}
              onTaskStarted={() => {
                setTaskRefresh((n) => n + 1);
                setView('tasks');
              }}
            />
          )}
          {view === 'tasks' && <TasksView refreshSignal={taskRefresh} />}
          {view === 'memory' && <MemoryView />}
          {view === 'logs' && <LogsView liveLogs={logs} />}
          {view === 'settings' && <SettingsView />}
        </main>
      </div>

      {/* Safety confirmations */}
      {safetyRequests.map((req) => (
        <SafetyDialog
          key={req.requestId}
          request={req}
          onResolved={(id) =>
            setSafetyRequests((prev) => prev.filter((r) => r.requestId !== id))
          }
        />
      ))}
    </div>
  );
}
