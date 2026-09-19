/**
 * Settings view — every section from lib/settings.ts, each reading and
 * writing through vyra:settings:get/set. The AI Providers section reports
 * real availability from vyra:providers:status; unavailable providers show
 * their honest reason, never a fake "connected".
 */
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import {
  getAppVersion,
  getProvidersStatus,
  getSettings,
  selectProvider,
  setSettings,
  VyraError,
} from '../api';
import type { ProviderStatusInfo } from '../../main/services.js';
import { SETTINGS_SECTIONS, type SettingField } from '../lib/settings';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@vyra/shared';

export function SettingsView(): JSX.Element {
  const [activeSection, setActiveSection] = useState(SETTINGS_SECTIONS[0].id);
  const [values, setValues] = useState<Record<string, Record<string, unknown>>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [savedTick, setSavedTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings()
      .then(setValues)
      .catch((err) => setError(err instanceof VyraError ? err.message : 'Could not load settings.'));
  }, []);

  const sectionValues = useCallback(
    (sectionId: string): Record<string, unknown> => values[sectionId] ?? {},
    [values],
  );

  const updateField = (sectionId: string, key: string, value: unknown): void => {
    setValues((prev) => ({
      ...prev,
      [sectionId]: { ...(prev[sectionId] ?? {}), [key]: value },
    }));
    setDirty((prev) => ({ ...prev, [sectionId]: true }));
  };

  const saveSection = async (sectionId: string): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      // Fields may bind to a different section (e.g. shortcuts → voice).
      const section = SETTINGS_SECTIONS.find((s) => s.id === sectionId);
      const grouped: Record<string, Record<string, unknown>> = {};
      for (const field of section?.fields ?? []) {
        const target = field.bindSection ?? sectionId;
        grouped[target] = grouped[target] ?? {};
        grouped[target][field.key] = sectionValues(target)[field.key];
      }
      for (const [target, vals] of Object.entries(grouped)) {
        await setSettings(target, vals);
      }
      setDirty((prev) => ({ ...prev, [sectionId]: false }));
      setSavedTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  };

  const active = SETTINGS_SECTIONS.find((s) => s.id === activeSection) ?? SETTINGS_SECTIONS[0];

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      <h1 className="flex-none text-xl font-light text-slate-100">Settings</h1>
      {error && (
        <div className="flex-none rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-4">
        <nav className="vyra-scroll space-y-1 overflow-y-auto pr-1 lg:col-span-1">
          {SETTINGS_SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => setActiveSection(section.id)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                section.id === activeSection
                  ? 'bg-vyra-accent/15 text-slate-100'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
              }`}
            >
              {section.title}
              {dirty[section.id] && <span className="ml-2 text-vyra-accent-soft">•</span>}
            </button>
          ))}
        </nav>

        <div className="vyra-scroll min-h-0 overflow-y-auto rounded-xl border border-white/5 bg-white/[0.02] p-6 lg:col-span-3">
          <h2 className="text-base font-medium text-slate-100">{active.title}</h2>
          <p className="mt-1 text-sm text-slate-400">{active.description}</p>

          {active.custom === 'providers' ? (
            <ProvidersSection />
          ) : active.custom === 'about' ? (
            <AboutSection />
          ) : active.custom === 'permissions' ? (
            <PermissionsSection />
          ) : (
            <div className="mt-5 space-y-4">
              {active.fields.map((field) => (
                <FieldRow
                  key={field.key}
                  field={field}
                  value={sectionValues(field.bindSection ?? active.id)[field.key]}
                  onChange={(v) => updateField(field.bindSection ?? active.id, field.key, v)}
                />
              ))}
              {dirty[active.id] && (
                <button
                  type="button"
                  onClick={() => void saveSection(active.id)}
                  disabled={saving}
                  className="rounded-lg bg-vyra-accent px-5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              )}
              {savedTick > 0 && !dirty[active.id] && (
                <p className="text-xs text-emerald-300">Saved.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: SettingField;
  value: unknown;
  onChange: (v: unknown) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm text-slate-200">{field.label}</label>
      {field.description && <p className="text-xs text-slate-500">{field.description}</p>}
      {field.type === 'boolean' ? (
        <button
          type="button"
          role="switch"
          aria-checked={value === true}
          onClick={() => onChange(value !== true)}
          className={`relative h-6 w-11 flex-none rounded-full transition ${
            value === true ? 'bg-vyra-accent' : 'bg-white/10'
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
              value === true ? 'left-[22px]' : 'left-0.5'
            }`}
          />
        </button>
      ) : field.type === 'select' ? (
        <select
          value={String(value ?? '')}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
          className="max-w-md rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 focus:border-vyra-accent focus:outline-none"
        >
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : field.type === 'color' ? (
        <input
          type="color"
          value={typeof value === 'string' ? value : '#6d5cff'}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          className="h-9 w-16 cursor-pointer rounded border border-white/10 bg-black/40"
        />
      ) : (
        <input
          type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={field.placeholder}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)
          }
          autoComplete="off"
          spellCheck={false}
          className="max-w-md rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-vyra-accent focus:outline-none"
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ProvidersSection(): JSX.Element {
  const [providers, setProviders] = useState<ProviderStatusInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProvidersStatus()
      .then(setProviders)
      .catch((err) =>
        setError(err instanceof VyraError ? err.message : 'Could not load provider status.'),
      );
  }, []);

  const onSelect = async (kind: string, id: string): Promise<void> => {
    setError(null);
    try {
      await selectProvider(kind, id);
      setProviders(await getProvidersStatus());
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not select provider.');
    }
  };

  if (error) return <p className="mt-4 text-sm text-red-300">{error}</p>;
  if (!providers) return <p className="mt-4 text-sm text-slate-500">Checking providers…</p>;

  const byKind = new Map<string, ProviderStatusInfo[]>();
  for (const p of providers) {
    const list = byKind.get(p.kind) ?? [];
    list.push(p);
    byKind.set(p.kind, list);
  }

  return (
    <div className="mt-5 space-y-5">
      {[...byKind.entries()].map(([kind, list]) => (
        <div key={kind}>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-500">{kind}</h3>
          <div className="mt-2 space-y-2">
            {list.map((p) => (
              <div
                key={`${p.kind}:${p.id}`}
                className="flex items-start justify-between gap-3 rounded-lg border border-white/5 bg-black/30 p-3"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm text-slate-200">
                    <span
                      className={`h-2 w-2 flex-none rounded-full ${p.available ? 'bg-emerald-400' : 'bg-slate-600'}`}
                    />
                    {p.displayName}
                    {p.selected && (
                      <span className="rounded-full bg-vyra-accent/20 px-2 py-0.5 text-[11px] text-vyra-accent-soft">
                        selected
                      </span>
                    )}
                  </p>
                  {!p.available && p.reason && (
                    <p className="mt-1 text-xs text-slate-500">{p.reason}</p>
                  )}
                </div>
                {!p.selected && (
                  <button
                    type="button"
                    onClick={() => void onSelect(p.kind, p.id)}
                    className="flex-none rounded-lg border border-white/15 px-3 py-1 text-xs text-slate-300 transition hover:bg-white/5"
                  >
                    Select
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AboutSection(): JSX.Element {
  const [version, setVersion] = useState<string>('…');

  useEffect(() => {
    getAppVersion()
      .then(setVersion)
      .catch(() => setVersion('unknown'));
  }, []);

  return (
    <div className="mt-5 space-y-2 text-sm text-slate-300">
      <p className="text-2xl font-light tracking-wide text-slate-100">{PRODUCT_NAME}</p>
      <p className="text-slate-400">{PRODUCT_TAGLINE}</p>
      <p className="pt-2 text-slate-500">Version {version}</p>
      <p className="text-slate-500">Built for Windows 10/11.</p>
    </div>
  );
}

function PermissionsSection(): JSX.Element {
  const items = [
    {
      name: 'Microphone',
      description: 'Needed for voice input and push-to-talk. Grant it in Windows Settings → Privacy & security → Microphone.',
    },
    {
      name: 'Screen recording / capture',
      description: 'Needed for the computer preview and screen analysis. Windows prompts on first use.',
    },
    {
      name: 'Accessibility / UI automation',
      description: 'Needed for VYRA to click, type and drive apps on your behalf.',
    },
  ];
  return (
    <div className="mt-5 space-y-3">
      {items.map((item) => (
        <div key={item.name} className="rounded-lg border border-white/5 bg-black/30 p-4">
          <p className="text-sm font-medium text-slate-200">{item.name}</p>
          <p className="mt-1 text-xs text-slate-500">{item.description}</p>
          <p className="mt-2 text-[11px] uppercase tracking-wider text-slate-600">
            Status: managed by Windows — VYRA cannot detect this from here
          </p>
        </div>
      ))}
    </div>
  );
}
