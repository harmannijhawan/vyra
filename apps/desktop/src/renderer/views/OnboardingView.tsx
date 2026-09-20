/**
 * First-run onboarding — VYRA's premium setup experience.
 *
 * Welcome (animated orb, brand, Get Started / Configure Later) →
 * Connect VYRA (real Gemini key test: Test Connection dry-run + Continue
 * that saves only after Google accepts the key and a model generates) →
 * optional steps (microphone, voice, computer, browser, memory, shortcuts).
 *
 * No secrets are ever displayed back and none are stored until the live
 * test succeeds — that guarantee lives in the main process.
 */
import { useState, type ChangeEvent } from 'react';
import { Orb } from '../components/Orb.js';
import { VoiceState } from '@vyra/shared';
import {
  completeOnboardingStep,
  openExternal,
  testGoogleConnection,
  VyraError,
} from '../api.js';
import type { OnboardingState } from '../../main/services.js';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@vyra/shared';

interface StepDef {
  id: string;
  title: string;
  description: string;
  fields?: Array<{ key: string; label: string; placeholder?: string; secret?: boolean }>;
}

const STEPS: StepDef[] = [
  { id: 'welcome', title: 'WELCOME TO VYRA', description: '' },
  {
    id: 'google-api-key',
    title: 'Connect VYRA',
    description:
      "VYRA's intelligence runs on Google's Gemini. Paste your free API key from Google AI Studio — VYRA tests it live with Google before continuing.",
  },
  {
    id: 'microphone',
    title: 'Microphone',
    description: 'VYRA listens through your microphone. Make sure it is plugged in and not muted.',
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

type KeyTestState = 'idle' | 'testing' | 'success' | 'failure';

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

  // Google key step state — the key is never displayed back after saving.
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<KeyTestState>('idle');
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const step = STEPS[index];
  const isLast = index === STEPS.length - 1;

  const complete = async (stepId: string, values?: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await completeOnboardingStep(stepId, values);
      if (isLast || next.completed) {
        setFinished(true);
      } else {
        setIndex((i) => Math.min(i + 1, STEPS.length - 1));
        setFieldValues({});
        setTestState('idle');
        setTestMessage(null);
      }
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not save that step.');
      if (stepId === 'google-api-key') setTestState('failure');
    } finally {
      setBusy(false);
    }
  };

  /** "Configure later" — finish onboarding now, leaving everything optional unset. */
  const configureLater = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      for (let i = index; i < STEPS.length; i++) {
        const next = await completeOnboardingStep(STEPS[i].id);
        if (next.completed) break;
      }
      setFinished(true);
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not finish setup.');
    } finally {
      setBusy(false);
    }
  };

  /** Dry-run: validate the key against Google's live API without saving anything. */
  const runTest = async (): Promise<void> => {
    const key = apiKey.trim();
    if (!key) {
      setError('Paste your API key first.');
      return;
    }
    setTestState('testing');
    setTestMessage(null);
    setError(null);
    try {
      const result = await testGoogleConnection(key, model.trim() || undefined);
      if (result.ok) {
        setTestState('success');
        setTestMessage(result.model);
      } else {
        setTestState('failure');
        setTestMessage(result.message);
      }
    } catch (err) {
      setTestState('failure');
      setTestMessage(
        err instanceof VyraError
          ? err.message
          : 'The test could not run. Check your connection and try again.',
      );
    }
  };

  const continueWithKey = (): void => {
    const key = apiKey.trim();
    if (!key) {
      setError('Paste your API key first — or skip for now.');
      return;
    }
    // The main process re-tests live and saves ONLY on success.
    const preferredModel = model.trim();
    void complete(
      'google-api-key',
      preferredModel ? { googleApiKey: key, preferredModel } : { googleApiKey: key },
    );
  };

  const onModelChange = (value: string): void => {
    setModel(value);
    // A changed model invalidates any earlier test result.
    if (testState === 'success' || testState === 'failure') {
      setTestState('idle');
      setTestMessage(null);
    }
  };

  const onApiKeyChange = (value: string): void => {
    setApiKey(value);
    // A changed key invalidates any earlier test result.
    if (testState === 'success' || testState === 'failure') {
      setTestState('idle');
      setTestMessage(null);
    }
  };

  const onContinue = (): void => {
    const values: Record<string, unknown> = {};
    for (const f of step.fields ?? []) {
      const v = fieldValues[f.key]?.trim();
      if (v) values[f.key] = v;
    }
    void complete(step.id, values);
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

  // --- Welcome -------------------------------------------------------------
  if (step.id === 'welcome') {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <Orb state={VoiceState.IDLE} size={200} />
        <h1 className="mt-10 text-5xl font-light tracking-[0.35em] text-slate-100">VYRA</h1>
        <p className="mt-4 text-sm tracking-wide text-slate-400">{PRODUCT_TAGLINE}</p>
        <p className="mt-2 text-sm text-slate-500">Your intelligent desktop companion.</p>
        <div className="mt-12 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => void complete('welcome')}
            disabled={busy}
            className="rounded-xl bg-vyra-accent px-12 py-3 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Starting…' : 'Get Started'}
          </button>
          <button
            type="button"
            onClick={() => void configureLater()}
            disabled={busy}
            className="px-4 py-2 text-sm text-slate-500 transition hover:text-slate-300 disabled:opacity-50"
          >
            Configure Later
          </button>
        </div>
        {error && <p className="mt-6 text-sm text-red-300">{error}</p>}
      </div>
    );
  }

  // --- Connect VYRA (Google AI Studio key) ---------------------------------
  if (step.id === 'google-api-key') {
    const testing = testState === 'testing';
    return (
      <div className="flex h-full flex-col items-center justify-center p-8">
        <div className="w-full max-w-lg">
          <div className="mb-8 flex items-center justify-center gap-2">
            {STEPS.slice(1).map((s, i) => (
              <span
                key={s.id}
                className={`h-1.5 flex-1 rounded-full transition ${
                  i < index ? 'bg-vyra-accent' : 'bg-white/10'
                }`}
              />
            ))}
          </div>

          <h1 className="text-center text-3xl font-light tracking-wide text-slate-100">
            Connect VYRA
          </h1>
          <p className="mx-auto mt-4 max-w-md text-center text-sm leading-relaxed text-slate-400">
            {step.description}
          </p>

          <div className="mx-auto mt-6 max-w-md">
            <label className="text-xs text-slate-400" htmlFor="vyra-api-key">
              Google AI Studio API key
            </label>
            <div className="relative mt-1">
              <input
                id="vyra-api-key"
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e: ChangeEvent<HTMLInputElement>) => onApiKeyChange(e.target.value)}
                placeholder="AIza…"
                disabled={testing || busy}
                className="w-full rounded-lg border border-white/10 bg-black/40 py-2 pl-3 pr-24 text-sm text-slate-100 placeholder:text-slate-600 focus:border-vyra-accent focus:outline-none disabled:opacity-60"
              />
              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                {apiKey.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onApiKeyChange('')}
                    disabled={testing || busy}
                    aria-label="Clear API key"
                    title="Clear"
                    className="rounded px-1.5 py-1 text-sm text-slate-500 transition hover:text-slate-200 disabled:opacity-50"
                  >
                    ✕
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  disabled={testing || busy}
                  className="rounded px-2 py-1 text-xs text-slate-400 transition hover:text-slate-200 disabled:opacity-50"
                >
                  {showKey ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void openExternal('https://aistudio.google.com')}
              className="mt-2 text-xs text-vyra-accent-soft transition hover:text-vyra-accent"
            >
              Get a free key at Google AI Studio ↗
            </button>

            <label
              htmlFor="vyra-model"
              className="mt-4 block text-xs font-medium text-slate-400"
            >
              Model <span className="font-normal text-slate-600">(optional)</span>
            </label>
            <input
              id="vyra-model"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={model}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onModelChange(e.target.value)}
              placeholder="Auto — VYRA picks a working model"
              disabled={testing || busy}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-vyra-accent focus:outline-none disabled:opacity-60"
            />
            <p className="mt-1 text-xs text-slate-600">
              e.g. gemini-3.5-flash-lite. Leave empty and VYRA picks one automatically.
            </p>

            {testState === 'testing' && (
              <div className="mt-4 flex items-center gap-3 rounded-lg border border-white/10 bg-black/30 px-4 py-3">
                <span className="h-4 w-4 flex-none animate-spin rounded-full border-2 border-vyra-accent border-t-transparent" />
                <p className="text-sm text-slate-300">Connecting to VYRA&apos;s intelligence…</p>
              </div>
            )}
            {testState === 'success' && (
              <div className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-4 py-3">
                <p className="text-sm text-emerald-200">Connection successful — VYRA is ready.</p>
                {testMessage && (
                  <p className="mt-1 text-xs text-emerald-200/70">Verified live with {testMessage}.</p>
                )}
              </div>
            )}
            {testState === 'failure' && (
              <div className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-3">
                <p className="text-sm text-red-200">{testMessage ?? 'The connection failed.'}</p>
                <button
                  type="button"
                  onClick={() => {
                    setTestState('idle');
                    setTestMessage(null);
                  }}
                  className="mt-2 text-xs text-red-200/80 underline transition hover:text-red-200"
                >
                  Try Again
                </button>
              </div>
            )}

            <p className="mt-3 text-xs leading-relaxed text-slate-500">
              Your key stays on this device, encrypted. It is only ever sent to Google.
            </p>
          </div>

          {error && <p className="mt-4 text-center text-sm text-red-300">{error}</p>}

          <div className="mt-8 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => setIndex((i) => i - 1)}
              disabled={testing || busy}
              className="rounded-xl border border-white/15 px-6 py-2.5 text-sm text-slate-300 transition hover:bg-white/5 disabled:opacity-50"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={testing || busy || apiKey.trim().length === 0}
              className="rounded-xl border border-vyra-accent/60 px-6 py-2.5 text-sm text-vyra-accent-soft transition hover:bg-vyra-accent/10 disabled:opacity-50"
            >
              Test Connection
            </button>
            <button
              type="button"
              onClick={continueWithKey}
              disabled={testing || busy}
              className="rounded-xl bg-vyra-accent px-8 py-2.5 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Continue'}
            </button>
            <button
              type="button"
              onClick={() => void complete('google-api-key')}
              disabled={testing || busy}
              className="px-4 py-2.5 text-sm text-slate-500 transition hover:text-slate-300 disabled:opacity-50"
            >
              Skip for now
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Generic optional steps ----------------------------------------------
  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      <div className="w-full max-w-lg">
        <div className="mb-8 flex items-center justify-center gap-2">
          {STEPS.slice(1).map((s, i) => (
            <span
              key={s.id}
              className={`h-1.5 flex-1 rounded-full transition ${
                i < index ? 'bg-vyra-accent' : 'bg-white/10'
              }`}
            />
          ))}
        </div>

        <h1 className="text-center text-3xl font-light tracking-wide text-slate-100">
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
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
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
              onClick={() => void complete(step.id)}
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
