# KiroSight — Security & Safety

## Allow-listed autonomous actions

- KiroSight's agent may only trigger a fixed, explicit set of allow-listed actions against the IDE (e.g. open file, go to diagnostic, run tests, read selection). There is no generic "run arbitrary command/code" capability exposed to the agent.
- **Explicitly forbidden:** an action shaped like `RUN_COMMAND(command: string)` that lets the model supply arbitrary shell/command text. This is a direct path to arbitrary code execution via prompt injection or model error and must never be added, even as a convenience or for debugging.
- Instead, every shell/process-invoking capability is a specific, named, allow-listed action (e.g. `RUN_TESTS`) whose actual underlying command comes from **trusted extension configuration** (e.g. a user-configured test command, package.json script, or VS Code's own test-running integration) — never from model-generated text. The model can request "run the tests"; it cannot specify *how*.
- The allow-list and each action's risk classification (safe/read-only vs. requires confirmation) must live in one documented location (see `backend/app/allowlist.py` in `structure.md`) so it can be audited at a glance.
- Adding a new autonomous action means adding it to the allow-list deliberately, with an explicit risk classification — never by widening an existing generic handler to accept new inputs.

## Confirmation for destructive actions

- Any action that changes files, runs code, modifies git state beyond read-only inspection, or runs terminal commands requires explicit user confirmation before execution, every time, regardless of how the request was phrased.
- Confirmation cannot be bypassed by voice command alone (e.g. a user saying "just do it" should not retroactively authorize a destructive action that wasn't already pending confirmation) — follow the explicit confirmation flow, don't infer blanket consent.

## Secrets management

- No secrets (Deepgram API keys, AWS/Bedrock credentials, any tokens) are ever committed to Git, in code, config, or test fixtures.
- Local secrets are stored in environment variables (Python backend, loaded via `.env` which is git-ignored) or secure settings storage (VS Code `SecretStorage` API on the extension side). Never hardcode credentials or embed them in the webview (webview JS is inspectable).
- Maintain a `.env.example` (or equivalent) listing required variable names with placeholder/no values, so secrets setup is documented without exposing real values.
- `.gitignore` must exclude `.env`, local credential files, build artifacts, and dependency directories (`node_modules/`, `__pycache__/`, `.venv/`, etc.).
- If a secret is ever accidentally committed, treat it as compromised: rotate/revoke it, don't just remove it from the latest commit (history still contains it).

## Local-only trust boundary

- The extension and Python backend communicate over a local WebSocket. Do not expose the backend's WebSocket server beyond localhost for the hackathon build — no binding to `0.0.0.0` or exposing it over the network without explicit discussion, since the allow-listed action handlers are a direct bridge to IDE control.
- Treat all data flowing from the backend to the extension as something to validate against the typed protocol schema before acting on it — don't trust unvalidated JSON into action handlers.

## External AI/voice providers

- Audio and IDE-state data sent to Deepgram (STT/TTS) and Amazon Bedrock are leaving the local machine. Be deliberate about what IDE state/code context is included in prompts sent to Bedrock — send what's needed to answer the question, not entire files or project trees by default, especially if source code sensitivity is a concern for the user's project.
- Don't log raw audio, full file contents, or credentials in any debug/console logging path by default.

## Vision/screenshot fallback

- If a screenshot-based fallback is ever implemented, treat captured screenshots as potentially sensitive (they may contain code, credentials visible in terminals, etc.). Don't persist screenshots beyond the immediate request/response cycle, and don't send them to external services unless strictly necessary for the fallback to work.

## Review posture for this project

- Because this agent can navigate, read, and (eventually) modify a developer's real codebase on their behalf, treat any change to the allow-list, confirmation flow, or action-handler code as security-sensitive and worth extra scrutiny — not just a normal feature change.
