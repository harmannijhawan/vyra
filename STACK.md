# VYRA — locked stack (verified 2026-09-20 via `npm view`)

| Package | Locked version | Notes |
|---|---|---|
| electron | ^44.4.3 | Desktop runtime (Windows 10/11 target) |
| react / react-dom | 18.3.1 | Per product spec (not latest 19.x) |
| typescript | ^5.9.3 | Pinned to 5.x for tooling compatibility |
| vite | ^8.3.0 | Renderer bundler |
| @vitejs/plugin-react | latest 4.x/5.x at install | React Fast Refresh for Vite |
| tailwindcss | ^4.3.3 | v4 — CSS-first config via `@import "tailwindcss"` |
| @tailwindcss/vite | matching 4.x | Vite plugin for Tailwind v4 |
| electron-builder | ^26.15.3 | NSIS installer → `VYRA-Setup.exe` |
| vitest | ^5.0.1 | Unit tests (per-package configs, workspace aggregate) |
| better-sqlite3 | ^13.0.3 | Local memory DB |
| @nut-tree-fork/nut-js | ^4.2.6 | Real Win32 computer control (Windows only at runtime) |
| playwright | ^1.63.0 | Real browser automation |
| ws | ^8.21.3 | Streaming / IPC helpers |
| zod | ^4.6.5 | IPC payload + tool-arg validation |
| @types/node | ^22.10.0 | Node typings |

Node engine: >=20 <25 (build machine runs Node v24.20.0, npm 10.9.4).

## Layout

```
vyra/
  apps/desktop/          # Electron main + preload + React renderer (agent 4)
  packages/
    shared/              # contracts (done — Phase 1)
    agent-core/          # Brain, Task Engine, Tool Registry, Recovery (agent 1)
    tools/               # computer / browser / terminal / fs / git / github (agent 2)
    voice/               # STT/TTS, VAD, wake word, push-to-talk (agent 3)
    memory/              # SQLite memory: remember/recall/update/forget (agent 3)
    providers/           # provider registry + concrete adapters (agent 5)
    observability/       # JSONL structured logging (agent 5)
    safety/              # safety policy engine (agent 5)
  electron-builder.yml   # agent 5
  README.md              # agent 5
```

All cross-package imports go through `@vyra/shared` contracts only.
