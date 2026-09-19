/**
 * Settings section metadata driving views/SettingsView.tsx.
 *
 * Each section reads/writes via vyra:settings:get/set. A field may bind to
 * a different settings section via `bindSection` (used by Keyboard
 * Shortcuts, which edits voice.* keys).
 */
export type SettingFieldType = 'text' | 'number' | 'boolean' | 'select' | 'password' | 'color';

export interface SettingField {
  key: string;
  label: string;
  type: SettingFieldType;
  description?: string;
  options?: string[];
  placeholder?: string;
  /** Read/write this key in a different settings section. */
  bindSection?: string;
  sensitive?: boolean;
}

export interface SettingsSectionMeta {
  id: string;
  title: string;
  description: string;
  fields: SettingField[];
  /** Rendered by a custom component instead of generic fields. */
  custom?: 'providers' | 'about' | 'permissions';
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  {
    id: 'general',
    title: 'General',
    description: 'Startup behavior and app basics.',
    fields: [
      { key: 'launchOnStartup', label: 'Launch on startup', type: 'boolean', description: 'Start VYRA when Windows signs in.' },
      { key: 'minimizeToTray', label: 'Minimize to tray', type: 'boolean', description: 'Keep VYRA running in the tray when the window closes.' },
    ],
  },
  {
    id: 'voice',
    title: 'Voice',
    description: 'Speech input, output and the push-to-talk hotkey.',
    fields: [
      { key: 'sttProvider', label: 'Speech-to-text provider', type: 'text', placeholder: 'e.g. whisper-local', description: 'Provider id for transcription.' },
      { key: 'ttsProvider', label: 'Text-to-speech provider', type: 'text', placeholder: 'e.g. piper-local', description: 'Provider id for spoken replies.' },
      { key: 'microphoneId', label: 'Microphone', type: 'text', placeholder: 'Default system microphone', description: 'Device id; blank uses the system default.' },
      { key: 'pushToTalkEnabled', label: 'Push-to-talk enabled', type: 'boolean' },
      { key: 'pushToTalkHotkey', label: 'Push-to-talk hotkey', type: 'text', placeholder: 'CommandOrControl+Shift+V', description: 'Global shortcut. Takes effect immediately after saving.' },
      { key: 'wakeWordEnabled', label: 'Wake word enabled', type: 'boolean' },
      { key: 'wakeWord', label: 'Wake word', type: 'text', placeholder: 'hey vyra' },
      { key: 'interruptibleSpeech', label: 'Interruptible speech', type: 'boolean', description: 'Talk over VYRA to stop it speaking.' },
      { key: 'speechRate', label: 'Speech rate', type: 'number', description: '1.0 is normal speed.' },
    ],
  },
  {
    id: 'ai-providers',
    title: 'AI Providers',
    description: 'Reasoning, vision and speech providers. Unavailable providers show their reason — VYRA never pretends a missing provider works.',
    fields: [],
    custom: 'providers',
  },
  {
    id: 'models',
    title: 'Models',
    description: 'Defaults for the reasoning model.',
    fields: [
      { key: 'defaultModel', label: 'Default model', type: 'text', placeholder: 'e.g. gpt-4o-mini', description: 'Model id for the selected AI provider.' },
      { key: 'temperature', label: 'Temperature', type: 'number', description: '0 = deterministic, higher = more creative.' },
      { key: 'maxTokens', label: 'Max tokens', type: 'number' },
    ],
  },
  {
    id: 'computer',
    title: 'Computer Control',
    description: 'How VYRA sees and drives your PC.',
    fields: [
      { key: 'enabled', label: 'Computer control enabled', type: 'boolean' },
      { key: 'screenshotIntervalMs', label: 'Screenshot interval (ms)', type: 'number', description: 'How often VYRA captures the screen while working.' },
      { key: 'requireConfirmation', label: 'Confirm risky actions', type: 'boolean', description: 'Ask before destructive computer actions.' },
    ],
  },
  {
    id: 'browser',
    title: 'Browser',
    description: 'Built-in browser automation.',
    fields: [
      { key: 'enabled', label: 'Browser automation enabled', type: 'boolean' },
      { key: 'headless', label: 'Headless mode', type: 'boolean', description: 'Run the controlled browser without a visible window.' },
    ],
  },
  {
    id: 'memory',
    title: 'Memory',
    description: 'What VYRA remembers about you.',
    fields: [
      { key: 'enabled', label: 'Memory enabled', type: 'boolean' },
      { key: 'retentionDays', label: 'Retention (days)', type: 'number', description: 'How long memories are kept. 0 = keep forever.' },
    ],
  },
  {
    id: 'security',
    title: 'Security',
    description: 'Guardrails for agentic actions.',
    fields: [
      { key: 'confirmDestructiveActions', label: 'Confirm destructive actions', type: 'boolean', description: 'VYRA asks before deleting, overwriting or sending anything.' },
      { key: 'allowRemoteAccess', label: 'Allow remote access', type: 'boolean', description: 'Keep off unless you know what you are doing.' },
    ],
  },
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Look and feel.',
    fields: [
      { key: 'accentColor', label: 'Accent color', type: 'color' },
      { key: 'reduceMotion', label: 'Reduce motion', type: 'boolean', description: 'Calm the orb animations.' },
    ],
  },
  {
    id: 'shortcuts',
    title: 'Keyboard Shortcuts',
    description: 'Global hotkeys. Saved straight into the voice settings.',
    fields: [
      { key: 'pushToTalkHotkey', label: 'Push-to-talk', type: 'text', bindSection: 'voice' },
      { key: 'pushToTalkEnabled', label: 'Push-to-talk enabled', type: 'boolean', bindSection: 'voice' },
    ],
  },
  {
    id: 'permissions',
    title: 'Permissions',
    description: 'OS-level permissions VYRA needs. These are granted in Windows Settings — VYRA reports what it can detect, honestly.',
    fields: [],
    custom: 'permissions',
  },
  {
    id: 'logs',
    title: 'Logs',
    description: 'Diagnostics.',
    fields: [
      { key: 'level', label: 'Log level', type: 'select', options: ['debug', 'info', 'warn', 'error'] },
      { key: 'persistToDisk', label: 'Persist logs to disk', type: 'boolean' },
    ],
  },
  {
    id: 'about',
    title: 'About',
    description: 'VYRA — Your PC. Your Voice. Your AI.',
    fields: [],
    custom: 'about',
  },
];
