/**
 * First-run onboarding — "WELCOME TO VYRA" through setup steps to
 * "VYRA is ready." Progress persists through the onboarding IPC channels.
 */
import { useState, type ChangeEvent } from 'react';
import { completeOnboardingStep, VyraError } from '../api';
import type { OnboardingState } from '../../main/services.js';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@vyra/shared';

interface StepDef {
  id: string;
  title: string;
  description: string;
  fields?: Array<{ key: string; label: string; placeholder?: string }>;
}

const STEPS: StepDef[] = [
  {
    id: 'welcome',
    title: 'WELCOME TO VYRA',
    description: `${PRODUCT_TAGLINE} Let's get you set up — this takes about a minute.`,
  },
  {
    id: 'microphone',
    title: 'Microphone',
    description: 'VYRA listens through your microphone. Make sure it is plugged in and not muted.',
  },
  {
    id: 'ai-provider',
    title: 'AI provider',
    description: 'Choose the brain behind VYRA. You can change this any time in Settings.',
    fields: [{ key: 'aiProviderId', label: 'Provider id', placeholder: 'e.g. openai' }],
  },
  {
    id: 'voice',
    title: 'Voice',
    description: 'Pick how you summon VYRA: hold the push-to-talk hotkey, or say the wake word.',
    fields: [
      { key: 'pushToTalkHotkey', label: 'Push-to-talk hotkey', placeholder: 'CommandOrControl+Shift+V' },
      { key: 'wakeWord', label: 'Wake word', placeholder: 'hey vyra' },
    ],
  },
  {
    id: 'computer-permissions',
    title: 'Computer permissions',
    description: 'On first launch Windows will ask for screen-capture and accessibility access so VYRA can see and drive your PC. Grant both when prompted.',
  },
  {
    id: 'browser',
    title: 'Browser',
    description: 'VYRA can drive a real browser for you — researching, filling forms, clicking through pages.',
  },
  {
    id: 'memory',
    title: 'Memory',
    description: 'VYRA can remember facts about you across sessions. Anything it remembers, you can review or forget in the Memory view.',
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    description: 'One shortcut to rule them all. You can remap these later in Settings.',
    fields: [{ key: 'pushToTalkHotkey', label: 'Push-to-talk hotkey', placeholder: 'CommandOrControl+Shift+V' }],
  },
];

interface OnboardingViewProps {
  initial: OnboardingState;
  onDone: () => void;
}

export function OnboardingView({ initial, onDone }: OnboardingViewProps): JSX.Element {
  const startIndex = Math.max(
    0,
    STEPS.findIndex((s) => s.id === initial.currentStep),
  );
  const [index, setIndex] = useState(startIndex === -1 ? 0 : startIndex);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);

  const step = STEPS[index];
  const isLast = index === STEPS.length - 1;

  const complete = async (values?: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await completeOnboardingStep(step.id, values);
      if (isLast || next.completed) {
        setFinished(true);
      } else {
        setIndex((i) => Math.min(i + 1, STEPS.length - 1));
        setFieldValues({});
      }
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not save that step.');
    } finally {
      setBusy(false);
    }
  };

  const onContinue = (): void => {
    const values: Record<string, unknown> = {};
    for (const f of step.fields ?? []) {
      const v = fieldValues[f.key]?.trim();
      if (v) values[f.key] = v;
    }
    void complete(values);
  };

  if (finished) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
        <p className="text-3xl font-light tracking-wide text-slate-100">VYRA is ready.</p>
        <p className="max-w-md text-sm text-slate-400">
          Hold the push-to-talk hotkey and tell {PRODUCT_NAME} what to do — or just type it.
        </p>
        <button
          type="button"
          onClick={onDone}
          className="rounded-xl bg-vyra-accent px-8 py-3 text-sm font-medium text-white transition hover:brightness-110"
        >
          Start using VYRA
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      <div className="w-full max-w-lg">
        <div className="mb-8 flex items-center justify-center gap-2">
          {STEPS.map((s, i) => (
            <span
              key={s.id}
              className={`h-1.5 flex-1 rounded-full transition ${
                i <= index ? 'bg-vyra-accent' : 'bg-white/10'
              }`}
            />
          ))}
        </div>

        <p className="text-center text-[11px] font-semibold uppercase tracking-[0.3em] text-vyra-accent-soft">
          Step {index + 1} of {STEPS.length}
        </p>
        <h1 className="mt-3 text-center text-3xl font-light tracking-wide text-slate-100">
          {step.title}
        </h1>
        <p className="mx-auto mt-4 max-w-md text-center text-sm leading-relaxed text-slate-400">
          {step.description}
        </p>

        {step.fields && (
          <div className="mx-auto mt-6 max-w-md space-y-3">
            {step.fields.map((f) => (
              <div key={f.key}>
                <label className="text-xs text-slate-400">{f.label}</label>
                <input
                  value={fieldValues[f.key] ?? ''}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setFieldValues((prev) => ({ ...prev, [f.key]: e.target.value }))
                  }
                  placeholder={f.placeholder}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-vyra-accent focus:outline-none"
                />
              </div>
            ))}
          </div>
        )}

        {error && <p className="mt-4 text-center text-sm text-red-300">{error}</p>}

        <div className="mt-8 flex items-center justify-center gap-3">
          {index > 0 && (
            <button
              type="button"
              onClick={() => setIndex((i) => i - 1)}
              disabled={busy}
              className="rounded-xl border border-white/15 px-6 py-2.5 text-sm text-slate-300 transition hover:bg-white/5 disabled:opacity-50"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={onContinue}
            disabled={busy}
            className="rounded-xl bg-vyra-accent px-8 py-2.5 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Saving…' : isLast ? 'Finish' : 'Continue'}
          </button>
          {!isLast && (
            <button
              type="button"
              onClick={() => void complete()}
              disabled={busy}
              className="px-4 py-2.5 text-sm text-slate-500 transition hover:text-slate-300 disabled:opacity-50"
            >
              Skip
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
