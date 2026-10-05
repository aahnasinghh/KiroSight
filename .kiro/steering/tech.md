# KiroSight — Technology & Architecture

## High-level architecture

```
┌─────────────────────────────┐        WebSocket (local)        ┌───────────────────────────┐
│   KiroSight VS Code/Kiro     │ <------------------------------> │   Python backend          │
│   Extension (TypeScript)     │        typed JSON protocol       │   (FastAPI + WebSockets)  │
│                               │                                   │                           │
│ - VS Code Extension API      │                                   │ - Agent orchestration     │
│   (editor, diagnostics,      │                                   │ - Amazon Bedrock calls    │
│   files, selections,         │                                   │ - Deepgram Nova-2 (STT)   │
│   commands, terminals,       │                                   │ - Deepgram Aura (TTS)     │
│   workspace state)           │                                   │ - Allow-list enforcement  │
│ - Webview: accessible panel  │                                   │   for autonomous actions  │
│   + push-to-talk UI          │                                   │                           │
└─────────────────────────────┘                                   └───────────────────────────┘
```

The extension is the only component with direct access to Kiro/VS Code state. The Python backend is the only component that talks to AI/voice providers. They are separate processes communicating over a local WebSocket connection using a typed, documented protocol. Neither component should duplicate the other's responsibility.

## Core technology choices

- **Extension language:** TypeScript, strict mode enabled, targeting the VS Code Extension API (Kiro is VS Code-based, so standard `vscode` APIs apply).
- **UI:** VS Code Webview API for the accessible side panel and push-to-talk control, built with plain HTML, CSS, and TypeScript/JavaScript. **Decided: no frontend framework (no React, Svelte, Vue, etc.) for the MVP.** The panel is small, and avoiding a framework keeps the accessibility semantics (DOM structure, ARIA, focus management) direct and easy to reason about. Revisit only if the webview's complexity genuinely outgrows plain HTML/TS. The webview must be operable without a mouse and must not rely on visual-only cues.
- **Speech-to-text:** Deepgram Nova-2, streaming, invoked from the Python backend.
- **Text-to-speech:** Deepgram Aura, optimized for low latency, invoked from the Python backend.
- **Voice as an interface layer only:** every command and query must also work through typed text input. A Deepgram outage or STT/TTS failure must never make KiroSight unusable — it should degrade to text-only, not break.
- **Backend:** Python, FastAPI, WebSocket server, running locally alongside the IDE (not deployed as a remote service for the hackathon).
- **AI reasoning:** Amazon Bedrock is the **only** LLM provider for the MVP. Do not add Gemini, OpenAI, Anthropic's direct API, or any other provider as a fallback — not even "just in case." If a Bedrock call fails, surface a graceful, clearly-stated error to the user (spoken and in the transcript) rather than silently retrying against a different provider. Keep Bedrock access behind an interface/abstraction in `backend/app/agent/` so agent behavior can be mocked in tests without live Bedrock calls.
- **Transport:** Local WebSocket connection between extension and backend. Define and document the message schema (see Protocol below) rather than passing ad hoc JSON blobs.

## Development milestones

The MVP is built in stages so the deterministic, locally-verifiable core works before any external dependency is introduced:

1. **Milestone 1 — extension-only, no external dependencies.** A working Kiro/VS Code extension that can describe structured IDE state (current file, cursor/selection context, diagnostics, Git status) purely through VS Code Extension APIs. **No Bedrock, no Deepgram, no Python backend** at this stage. This is the first usable, demoable milestone and the one to get rock-solid before moving on.
2. **Milestone 2 — add the Python backend and protocol.** Introduce the local WebSocket connection and the typed protocol once the extension already has something real to report over it.
3. **Milestone 3 — add Bedrock.** Wire up agent reasoning/summarization against real IDE state gathered in milestone 1.
4. **Milestone 4 — add voice.** Layer Deepgram STT/TTS on top of a product that already works end-to-end via typed text.

Do not reorder this sequence to add voice or AI reasoning before the deterministic extension behavior is solid — external-service flakiness should never be the reason a core feature looks broken in the demo.

## IDE state over screenshots

Structured IDE/editor state (via VS Code Extension APIs) is the default and preferred source of truth for anything the API can expose:

- Current file, cursor position, selection, open editors — `vscode.window` APIs.
- Diagnostics/errors/warnings — `vscode.languages.getDiagnostics`.
- File contents and symbols — `vscode.workspace`, `vscode.workspace.openTextDocument`, document symbol providers.
- Git state — VS Code's built-in Git extension API (or `simple-git`/shell `git` as a fallback) rather than screenshotting the Source Control view.
- Terminal output — VS Code terminal APIs/shell integration, not screen capture.
- Commands/navigation — `vscode.commands.executeCommand` for built-in and extension-contributed commands.

Screenshot/vision-based analysis is a fallback only, used when a question is genuinely about visual-only information unavailable through any API (e.g. a rendered webview's visual layout, a third-party extension's custom UI with no API). Any vision fallback path should be clearly isolated in the code and clearly flagged in responses to the user (e.g. "I'm inferring this from a screenshot, not confirmed IDE state") since it's lower-confidence than structured state.

## Protocol between extension and backend

**Decided for the MVP:** manually maintain matching TypeScript types (`extension/src/protocol/`) and Python Pydantic models (`backend/app/protocol/`) by hand. Do not introduce schema-generation tooling (JSON Schema codegen, etc.) yet — but write the protocol so that generation could be layered on afterward without a redesign: keep message shapes flat and explicit, avoid TS-only or Python-only type tricks that don't map cleanly to JSON Schema, and keep one message type per concern rather than overloaded unions.

- Every message, in both directions, **must** include a `version` field and a `type` field. `type` is the discriminator both sides use to route the message; `version` exists from day one so the protocol can evolve without ambiguity later, even though the MVP will likely stay on a single version.
- Every message should have a discriminated `type` field so both sides can route it without guessing.
- Document request/response/event shapes as they're introduced — don't let the protocol grow implicitly.
- Validate every message on both sides: Pydantic models on the Python side give free validation on receipt; the TypeScript side should validate (not just type-assert) incoming messages too, since a type annotation alone doesn't check anything at runtime.

## Allow-listed autonomous actions

- The backend/agent may only invoke a fixed, explicit allow-list of actions against the extension (e.g. `openFile`, `goToDiagnostic`, `runTests`, `readSelection`). No open-ended "execute arbitrary command" capability.
- **Explicitly disallowed:** do not expose an action shaped like `RUN_COMMAND(command: string)` where the model supplies shell/command text. Instead, expose specific, named actions (e.g. `RUN_TESTS`) where the actual underlying command comes from trusted extension configuration (e.g. a configured test command, or VS Code's own test-running integration), never from model-generated text. See `security.md` for the full rationale.
- Each allow-listed action is implemented as a specific handler in the extension, not a generic passthrough to `vscode.commands.executeCommand` with an arbitrary command string.
- Actions classified as potentially destructive or state-changing (running tests, modifying files, git operations beyond read-only status, terminal commands) require explicit user confirmation before execution, surfaced through the accessible webview and/or voice prompt — never silently executed.
- The allow-list and its risk classification (safe / read-only vs. needs-confirmation) should live in one well-documented place in the backend so it's auditable.

## Secrets & configuration

- No secrets (Deepgram API keys, AWS credentials, Bedrock config) are committed to Git.
- Local secrets live in environment variables or the OS-level secure settings store (e.g. VS Code `SecretStorage` API on the extension side, `.env` loaded at runtime on the Python side — with `.env` git-ignored).
- Provide a `.env.example`/documented list of required environment variables without real values.

## Testing

- Add tests for deterministic logic: protocol message parsing/validation, allow-list enforcement, diagnostic/state summarization formatting, command-to-handler routing, intent routing, diagnostic selection.
- Non-deterministic pieces (actual STT/TTS audio, live Bedrock responses) should be tested via mocked/stubbed interfaces, not live calls, in automated tests.
- **TypeScript side: Vitest** is the test runner for deterministic modules — action validation, context formatting, protocol validation, intent routing, diagnostic selection, and anything else that doesn't require a live `vscode` extension host. **`@vscode/test-electron` (full extension-host integration tests) is explicitly not a blocker for the MVP** — it can be added later once the core product works, since it's heavier to set up and run than plain Vitest unit tests. Write business logic so it's decoupled from live `vscode` API calls where feasible, so it stays Vitest-testable.
- **Python side: `pytest`** for backend logic. Keep Bedrock behind an interface/abstraction (see "AI reasoning" above) specifically so agent orchestration logic can be tested with a mocked Bedrock client, not live calls. Mock WebSocket and Deepgram clients the same way.

## Build conventions

- TypeScript strict mode (`"strict": true` in `tsconfig.json`) across the extension.
- Keep modules small and single-purpose; avoid large files mixing IDE-state gathering, protocol handling, and UI logic.
- Document the extension/backend protocol as it evolves — treat the protocol as a contract, not an implementation detail.
