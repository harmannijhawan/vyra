# VYRA — Your PC. Your Voice. Your AI.

VYRA is a personal AI computer-control app for **Windows 10/11**. Talk to your
PC in plain language — VYRA sees your screen, understands what you want, and
drives your computer to do it: clicking, typing, opening apps, browsing the
web, running terminal commands, and managing files. Everything runs locally on
your machine; your API keys never leave it.

## Features

- 🎙️ **Voice-first control** — push-to-talk, wake word, and continuous
  listening with interruptible speech output.
- 🖥️ **Real computer use** — mouse, keyboard, screenshots, windows and
  processes via nut-js on Windows.
- 🌐 **Browser automation** — Playwright-driven tabs, navigation, forms and
  page reading.
- 🧠 **Pluggable AI backends** — OpenAI, Anthropic, Google, or a local Ollama
  server. Swappable STT/TTS and vision providers.
- 👁️ **Screen understanding** — vision models describe the screen and locate
  UI elements as normalized coordinates.
- 💾 **Local memory** — SQLite-backed remember/recall/update/forget that
  persists across sessions.
- 🛡️ **Safety-first** — every tool call is classified allow / confirm / deny;
  destructive actions need your explicit approval, and dangerous commands
  (e.g. `rm -rf /`, deleting `C:\Windows`) are hard-denied.
- 📝 **Observable** — structured JSONL logs with automatic secret redaction,
  queryable from the app.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  apps/desktop (Electron main + preload + React renderer)      │
│  main: Task Engine · IPC handlers · settings · tray           │
│  renderer: chat UI · live activity feed · log panel · settings│
└───────────────┬──────────────────────────────────────────────┘
                │  @vyra/shared contracts only
┌───────────────▼──────────────────────────────────────────────┐
│  packages/agent-core   Brain · Task Engine · Tool Registry    │
│  packages/tools        computer · browser · terminal · fs ·    │
│                        git · github                           │
│  packages/voice        STT/TTS · VAD · wake word · push-to-talk│
│  packages/memory       SQLite memory (remember/recall/…)      │
│  packages/providers    ProviderRegistry · AI/vision adapters  │
│  packages/observability JSONL logging + secret redaction      │
│  packages/safety       allow/confirm/deny policy engine       │
│  packages/shared       tools · tasks · providers · voice ·    │
│                        events · IPC allowlist (no deps)        │
└──────────────────────────────────────────────────────────────┘
```

Cross-package imports always go through `@vyra/shared` contracts — packages
never reach into each other's internals. Provider availability is honest:
`probeAll()` reports `{ available: false, reason }` for anything that can't
run here (missing key, unsupported OS, no microphone), and the UI shows it.

## System requirements

- **Windows 10 (21H2+) or Windows 11**, x64 — the packaged app target.
- Node.js 20–24 and npm 10+ for development.
- A microphone for voice input; speakers for voice output.
- One AI provider: an API key (OpenAI / Anthropic / Google) **or** a local
  [Ollama](https://ollama.com) server (no key needed).

## Installation

**End users (Windows):** download `VYRA-Setup-<version>.exe` from the
releases page and run it. The installer lets you choose the install
directory and optionally creates a desktop shortcut named **VYRA**.

> The `.exe` must be built on Windows. The Linux build machine / CI can only
> validate the packaging config (`electron-builder.yml`); it cannot produce
> the NSIS installer.

**From source:**

```powershell
git clone <repo-url> vyra
cd vyra
npm install
copy .env.example .env   # then fill in your keys (see below)
npm run dev              # starts the Electron app in development mode
```

## Development

```bash
npm install        # install all workspaces
npm run dev        # run the desktop app (apps/desktop)
npm run typecheck  # tsc --noEmit across the repo (TS 5.9, strict)
npm run test       # vitest across all packages
npm run build      # build all workspaces
npm run dist       # package the Windows installer (run on Windows)
```

Per-package: `npm run test --workspace @vyra/safety`, etc.

## Environment variables

Copy `.env.example` to `.env`. Never commit `.env`.

| Variable | Description | Default |
|---|---|---|
| `VYRA_AI_PROVIDER` | AI backend: `openai` \| `anthropic` \| `google` \| `ollama` | `openai` |
| `VYRA_AI_MODEL` | Model name for the selected AI backend | backend default |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `GOOGLE_GENERATIVE_AI_KEY` | Google Generative AI key | — |
| `OLLAMA_BASE_URL` | Local Ollama server URL | `http://localhost:11434` |
| `VYRA_STT_PROVIDER` | Speech-to-text provider id | `system` |
| `VYRA_TTS_PROVIDER` | Text-to-speech provider id | `system` |
| `VYRA_VISION_PROVIDER` | Vision backend: `openai` \| `anthropic` \| `google` | `openai` |
| `GITHUB_TOKEN` | GitHub token (for the GitHub tools) | — |
| `VYRA_DATA_DIR` | Local data dir (logs, memory DB) | `~/.vyra` |
| `VYRA_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | `info` |
| `VYRA_PTT_HOTKEY` | Push-to-talk hotkey | `Ctrl+Space` |
| `VYRA_WAKE_WORD_ENABLED` | Enable wake-word listening | `false` |

`loadEnvConfig()` (in `@vyra/providers`) returns these as a typed object
with **secret presence flags only** (`hasOpenAiKey`, …) — secret values are
never included, never logged, and never sent to the renderer.

## Voice setup

1. Set `VYRA_STT_PROVIDER` / `VYRA_TTS_PROVIDER` (or pick them in Settings →
   Providers; unavailable providers show an honest reason).
2. Grant Windows microphone permission when prompted.
3. Hold the push-to-talk hotkey (`Ctrl+Space` by default) and speak, or enable
   the wake word in settings. Say "stop" / press the hotkey again to interrupt
   VYRA mid-speech.

## Computer-use setup

Computer control uses nut-js against the Win32 API and only works on the
Windows build. On first run, VYRA probes the `nutjs-computer` provider and
shows its status in Settings → Providers. If it reports unavailable (e.g.
non-Windows dev machine), computer tools are disabled rather than faked.

## Browser setup

Browser automation uses Playwright with a bundled Chromium. On first use
VYRA installs the browser binaries (`npx playwright install chromium` is run
automatically by the desktop app's setup step). Tabs run headed by default so
you can watch VYRA work.

## Memory

VYRA remembers things across sessions in a local SQLite database
(`<dataDir>/memory.db` via better-sqlite3):

- "Remember that my standup is at 10am" → stored with a category.
- "What do you remember about my standup?" → recalled semantically.
- "Forget my old address" → deleted permanently.

Nothing leaves your machine; there is no cloud sync.

## Testing

```bash
npm run test          # all packages (vitest workspace)
npm run test --workspace @vyra/providers
```

Tests are real vitest suites: provider routing + honest availability,
AI tool-call mapping from canned responses (no network), secret redaction,
JSONL logging, the safety policy (including fail-closed confirmation
timeouts), and the `electron-builder.yml` packaging contract.

## Security

- **Safety confirmations.** The safety policy classifies every tool call as
  `allow` (safe/normal risk), `confirm` (destructive — deletes, publishes,
  shutdowns), or `deny` (unknown tools, deny-listed tools, deleting system
  roots like `C:\Windows` / `/`, destructive shell like `rm -rf /`).
  Confirmations surface as `safety.confirm.request` events in the UI;
  unanswered requests **time out to deny** after 60s.
- **Secret redaction.** All log records pass through `redactSecrets()`:
  API-key-like values (`sk-…`, `ghp_…`, `xoxb-…`, Bearer tokens, PEM blocks,
  AWS keys) and any `*key/*token/*secret/*password` field become
  `[REDACTED]` before reaching disk or the live log panel.
- **No renderer secrets.** API keys live in the main process / `.env` only.
  The IPC allowlist (`@vyra/shared` `INVOKE_CHANNELS`) has no channel that
  carries secrets, and `vyra:providers:status` reports only availability +
  honest reasons.
- **Fail closed.** Unknown tools, unknown risk levels, crashed probes, and
  unparseable model output all resolve to "not available / denied" — VYRA
  never hallucinates a capability or a tool call.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "OPENAI_API_KEY is not set" in Providers | Add the key to `.env` and restart; or switch `VYRA_AI_PROVIDER` to `ollama` and run `ollama serve`. |
| Ollama shows unavailable | Start Ollama (`ollama serve`); check `OLLAMA_BASE_URL`. |
| Voice does nothing | Check Windows microphone privacy settings; verify the STT provider status. |
| Computer tools disabled | Expected on non-Windows dev machines; they only run in the Windows build. |
| Installer won't build on Linux | By design — run `npm run dist` on Windows to produce `VYRA-Setup-<version>.exe`. |
| Confirmation dialog never resolves | Requests time out to **deny** after 60s; answer in the UI or re-run the task. |

## Roadmap

- [ ] Multi-monitor computer control and per-app targeting
- [ ] Offline-first STT/TTS (Whisper + Piper bundled)
- [ ] Task scheduling ("every weekday at 9am, summarize my inbox")
- [ ] Plugin system for community tools (sandboxed, deny-by-default)
- [ ] macOS/Linux builds

## Screenshots / demo

> Real screenshots go here — captured from the Windows build once the
> renderer lands. Placeholders until then:
>
> - `docs/screenshots/chat.png` — voice chat with live activity feed
> - `docs/screenshots/computer-view.png` — live computer preview frame
> - `docs/screenshots/safety-confirm.png` — destructive-action confirmation
> - `docs/demo.mp4` — end-to-end voice-driven task demo
