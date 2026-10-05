# KiroSight — Project Structure

> **Decided:** KiroSight is a single monorepo. The extension and backend are not split into separate repositories. The layout below is settled for the MVP; refine within it as code is added, but keep the extension/backend separation and the small-module principle intact.

## Top-level layout

```
KiroSight/
├── .kiro/
│   └── steering/          # This directory — always-on project context for Kiro sessions
├── extension/              # TypeScript VS Code/Kiro extension — all IDE-facing code lives here
│   ├── src/
│   │   ├── extension.ts    # Activation entry point
│   │   ├── commands/       # VS Code command registrations (palette commands, keybindable entry points)
│   │   ├── context/        # Gathering IDE/editor state: current file, selection, diagnostics, git, terminal
│   │   ├── actions/        # Allow-listed action handlers (openFile, goToDiagnostic, runTests, ...)
│   │   ├── voice/           # Voice interaction layer: push-to-talk capture, STT/TTS client wiring, typed-text fallback routing
│   │   ├── backend/         # WebSocket client connecting to the local Python backend (connection lifecycle, send/receive)
│   │   ├── protocol/        # TypeScript types for the extension<->backend protocol (shared contract)
│   │   └── webview/         # Accessible side panel + push-to-talk UI: plain HTML/CSS/TS, webview host + message bridge
│   ├── test/                # Vitest tests for deterministic modules (context formatting, action validation, protocol validation, intent routing, diagnostic selection)
│   ├── package.json         # Extension manifest (contributes, activation events, commands)
│   └── tsconfig.json        # strict: true
├── backend/                 # Python FastAPI + WebSocket backend — all AI/voice-provider code lives here
│   ├── app/
│   │   ├── main.py          # FastAPI app, WebSocket route
│   │   ├── protocol/        # Pydantic models mirroring extension/src/protocol
│   │   ├── agent/           # Bedrock orchestration behind an interface, prompt construction, tool/action dispatch
│   │   ├── speech/          # Deepgram Nova-2 (STT) and Aura (TTS) integration
│   │   └── allowlist.py     # Single source of truth for allow-listed actions + risk classification
│   ├── tests/                # pytest: protocol validation, allow-list enforcement, summarization, agent logic with Bedrock mocked
│   ├── requirements.txt / pyproject.toml
│   └── .env.example          # Documented required env vars, no real secrets
├── docs/                     # (optional) architecture notes, protocol spec, demo script
├── .gitignore                # Must exclude .env, build output, __pycache__, node_modules, etc.
└── README.md
```

Notes on the extension layout:

- `commands/` is where VS Code command registrations live — the thin glue between a command ID/keybinding and the logic in `context/`, `actions/`, or `voice/`. Keep this layer thin.
- `context/` replaces what might otherwise be called `state/`: it's responsible for reading IDE/editor/git/terminal state via VS Code APIs and formatting it into plain data structures. Pure formatting logic here (e.g. "turn a `Diagnostic[]` into a summary") should be written so it's testable without a live `vscode` instance where possible, so it can be covered by Vitest.
- `voice/` is an interface layer only: it owns push-to-talk capture and STT/TTS plumbing, but every capability it exposes must also be reachable through typed text input, routed through the same intent-handling path. Nothing user-facing should be voice-exclusive.
- `backend/` (inside `extension/src/`) is the WebSocket *client* talking to the Python backend; don't confuse it with the top-level `backend/` directory, which is the Python *server*.

## Naming and organization conventions

- One concern per module: a file that gathers diagnostics should not also format speech output or manage the WebSocket connection.
- Group by responsibility (`state/`, `actions/`, `protocol/`) rather than by technical type (`utils/`, `helpers/`) wherever possible — this keeps the allow-list and state-gathering code auditable.
- Shared protocol types are the contract between `extension/` and `backend/`. Changes to protocol shapes should be made deliberately and reflected on both sides in the same change.
- Keep the webview UI code (HTML/CSS/JS or framework of choice for the panel) under `extension/src/webview/`, separate from the extension-host TypeScript that talks to VS Code APIs — webview code runs in a different context (no direct `vscode` API access) and should not be mixed with extension-host logic.
- Test files live alongside their respective component (`extension/test/`, `backend/tests/`), mirroring the source layout.

## When adding new code

- New IDE-state capability → `extension/src/context/`.
- New command/keybinding entry point → `extension/src/commands/`, delegating to `context/`, `actions/`, or `voice/` for actual logic.
- New voice-triggerable action that changes IDE/workspace state → `extension/src/actions/` on the extension side, plus a corresponding allow-list entry in `backend/app/allowlist.py`. Never add a generic "run this string as a command" action — see `security.md`.
- New voice/text-input handling (capture, intent routing, STT/TTS wiring) → `extension/src/voice/`, and ensure the same capability is reachable via typed text, not just speech.
- New protocol message → add to `extension/src/protocol/` and the mirrored Pydantic model in `backend/app/protocol/`, documented together. Every message needs `version` and `type` fields (see `tech.md`).
- New AI reasoning/summarization behavior → `backend/app/agent/`, behind the Bedrock interface so it can be mocked in tests.
- New speech integration behavior → `backend/app/speech/`.
