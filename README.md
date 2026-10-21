# KiroSight

KiroSight is an accessibility agent for blind and low-vision software developers who use the Kiro IDE. It answers questions about the state of the IDE (the current file, errors, test results) and carries out a small set of navigation and test actions, through typed text or push-to-talk voice. Every answer is grounded in real editor state read through the VS Code extension API.

**KiroSight supplements your screen reader. It does not replace NVDA, JAWS or VoiceOver.** It adds IDE-aware answers on top of them, and it keeps a full text transcript so that you can always read the result with your own screen reader.

> **Project status: MVP under development, version 0.0.1.** The typed, local features are implemented and covered by automated tests. Voice (Deepgram) and reasoning (Amazon Bedrock) are implemented but **have not been verified end to end against the live services**. Manual screen reader and keyboard testing has **not** been done yet. See [Status and verification](#status-and-verification).

## Contents

- [What it does](#what-it-does)
- [Status and verification](#status-and-verification)
- [Commands you can use](#commands-you-can-use)
- [Offline versus live-service features](#offline-versus-live-service-features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Setup (Windows)](#setup-windows)
- [Activating KiroSight](#activating-kirosight-with-and-without-a-keybinding)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Voice and typed input](#voice-and-typed-input)
- [Running the tests](#running-the-tests)
- [Running the demo](#running-the-demo)
- [Limits and non-goals](#limits-and-non-goals)
- [Troubleshooting](#troubleshooting)
- [Accessibility](#accessibility)
- [Project layout and further documentation](#project-layout-and-further-documentation)

## What it does

- **Describes IDE state.** Where you are (file, line, column, enclosing function when the editor can name it), the errors and warnings in the workspace, and the last test run.
- **Navigates.** Go to the first, second or third error, next and previous error, a line number, or a file by name, and move focus back to the editor.
- **Runs your tests, only after you confirm.** KiroSight can run one command, the one you configured in `kirosight.testCommand`. It states the exact command and waits for you to confirm or decline.
- **Explains errors and summarizes test failures** through the local backend and Amazon Bedrock (live verification pending, see below).
- **Accepts voice or text.** Push-to-talk speech goes through the same path as typed text, so nothing is voice-only. Spoken replies are optional and the text is always shown first.

## Status and verification

| Area | State |
|---|---|
| Typed local commands (where am I, errors, navigation, run tests with confirmation, help) | Implemented. Covered by the automated extension tests. |
| Accessible webview panel (transcript, status, confirmation, push-to-talk control) | Implemented. Structure, focus and announcements covered by jsdom tests. |
| Local backend, WebSocket protocol and allow-list | Implemented. Covered by the automated backend and extension tests, including shared protocol fixtures. |
| Amazon Bedrock reasoning ("explain this error", failure summaries) | Implemented behind a mockable client. **Not verified live**: the development account's Bedrock inference quota was zero and throttled, so Task 7.14 (the live checkpoint) is still open. The offline stub is the default. |
| Deepgram speech-to-text and text-to-speech | Implemented behind interfaces. **Not verified live in an end-to-end demo.** |
| Microphone capture | The backend records from the default microphone, because the Kiro webview denied the microphone in Spike D. Real-device behavior needs a manual check. |
| NVDA, JAWS or VoiceOver pass, keyboard walkthrough, high-contrast and contrast measurements | **Not tested.** [docs/accessibility-checklist.md](docs/accessibility-checklist.md) is written but every result is NOT TESTED. |
| WCAG conformance | **Not claimed.** Full validation needs testing with assistive technology and expert review. |

The automated suites are Vitest (extension) and pytest (backend). Run them yourself, see [Running the tests](#running-the-tests).

## Commands you can use

Type these into the panel's Command field, or say them with push-to-talk. Matching is on the whole normalized phrase.

| You say or type | What happens | Needs |
|---|---|---|
| "where am I", "what file am I in", "what file is this" | Names the file, line, column and enclosing function if available | Extension only |
| "what function am I in", "read the current function", "current function" | Names the function at the cursor | Extension only. Depends on the editor's symbol provider. |
| "read the selection" | Reads the selected text | Extension only |
| "what errors are there", "list errors", "what problems are there" | Lists workspace errors with severity, file, line, function when known, and message | Extension only |
| "what errors are in this file", "errors in this file" | Same, for the current file | Extension only |
| "go to the first error" (also second, third, or "go to the 1 error") | Moves the cursor to that error | Extension only |
| "next error", "previous error" | Moves between errors | Extension only |
| "go to line 40", "line 40" | Moves to that line | Extension only |
| "open auth.ts" | Opens a file by workspace-relative path or file name | Extension only |
| "focus editor", "back to editor" | Returns focus to the editor | Extension only |
| "run my tests", "run tests", "run the tests" | Asks for confirmation, then runs `kirosight.testCommand` | Extension only. A written failure summary also needs the backend and Bedrock. |
| "confirm", "decline", "cancel", "repeat" | Answers a pending confirmation | Extension only |
| "summarize the test failures", "list all failures" | Reads the stored last test result | Extension only |
| "help", "what can you do" | Lists the supported commands | Extension only |
| "explain this error", and other phrases starting with "explain", "why", "what does", "how do" or "summarize" | Sent to the backend agent | Backend. A real answer needs Bedrock. |

Anything the local rules do not recognize is also sent to the backend agent. If the backend is not running, KiroSight says so in the transcript and the local commands keep working.

The Command Palette entries are: `KiroSight: Activate`, `Where Am I`, `Describe Errors`, `Next Error`, `Previous Error`, `Ask`, `Run Tests`, `Show Test Output`, `Start Backend`, `Set Backend Token` and `Stop Speaking`.

## Offline versus live-service features

| Works with only the extension (no backend, no network) | Needs the local backend (still no cloud) | Needs a live service |
|---|---|---|
| Every local command in the table above, the panel, the transcript, confirmation, running the configured test command | The connection status, the offline stub reasoning client | **Amazon Bedrock:** "explain this error", written test failure summaries. **Deepgram:** speech-to-text, spoken replies. **Microphone:** push-to-talk recording. |

A Deepgram or Bedrock failure never disables typed commands. KiroSight states the failure in the transcript and carries on.

## Architecture

```
 Kiro / VS Code (Extension Development Host)
 ┌───────────────────────────────────────────┐          local WebSocket (127.0.0.1 only)
 │ KiroSight extension (TypeScript)          │  <────────────────────────────────────────>  ┌─────────────────────────────┐
 │  - IDE state: editor, diagnostics, files  │         versioned, validated JSON            │ Python backend (FastAPI)    │
 │  - Intent router, allow-list, confirmation│                                              │  - Agent behind a mockable  │
 │  - Test runner (trusted setting only)     │                                              │    LLM client (Bedrock)     │
 │  - Webview: accessible panel + audio      │                                              │  - Deepgram STT / TTS       │
 └───────────────────────────────────────────┘                                              │  - Local microphone capture │
                                                                                            └──────────────┬──────────────┘
                                                                                               Amazon Bedrock, Deepgram
```

- The **extension** is the only component that touches the IDE. It reads state through the VS Code API (not screenshots), validates every action against the allow-list, and executes it.
- The **backend** is the only component that talks to Bedrock and Deepgram. It never executes anything; it proposes actions as data.
- The two communicate over a **local WebSocket** using the typed protocol in [docs/protocol.md](docs/protocol.md). Messages are validated on both sides.
- The **webview** (plain HTML, CSS and JavaScript, no framework) is separate from the extension host. It talks to the host through a small closed message set and never opens a network connection.
- **Amazon Bedrock** is the only reasoning provider. There is no fallback provider. The default client is an offline stub.

## Prerequisites

- Windows. All development and manual checks so far were done on Windows. macOS and Linux have not been tested.
- Kiro (or a VS Code-compatible IDE recent enough for the `vscode` engine range in `extension/package.json`, currently `^1.125.0`).
- Node.js 22.12.0 or later, with `npm.cmd` available in PowerShell.
- Python 3 for the backend. The exact minimum version has not been recorded; use a recent 3.x supported by the pinned packages in `backend/requirements.txt`.
- Git.
- Optional, for live features only: a Deepgram API key and an AWS account with Amazon Bedrock inference access. Neither is needed for the typed, local demo.

## Setup (Windows)

Run these in PowerShell from the repository root. Real credentials never go on a command line or in a committed file.

### 1. Build the extension

```powershell
Set-Location extension
npm.cmd ci
npm.cmd run compile
Set-Location ..
```

`compile` writes `extension/dist/`, which the launch configuration uses.

### 2. Set up the backend

```powershell
Set-Location backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Set-Location ..
```

`requirements.txt` pins the runtime and test packages, including `sounddevice` for backend microphone capture (the Windows wheel includes PortAudio).

### 3. Configure the backend (optional)

The backend works without any configuration: it listens on `127.0.0.1:8765` and uses the offline stub. To use live services, copy the template and fill in only what you need:

```powershell
Copy-Item backend\.env.example backend\.env
```

Edit `backend\.env` in your editor. `.env` files are ignored by Git. Never commit one, and never paste its contents into issues or logs. The variable names and meanings are in [docs/env-vars.md](docs/env-vars.md).

### 4. Start the backend

```powershell
Set-Location backend
.\.venv\Scripts\python.exe -m app.main
```

Leave this terminal open. In another terminal, check it:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8765/health
```

Expect `status` to be `ok`. `KiroSight: Start Backend` can start it for you, but only if the user setting `kirosight.backendCommand` is configured.

### 5. Launch the Extension Development Host

1. Open the repository root in Kiro.
2. Open Run and Debug, choose **Run KiroSight Extension** and start it. This opens a second window, the Extension Development Host, with KiroSight loaded.
3. In that window use File, Open Folder and open **`demo-project`** (or your own project). Trust the folder if asked, after reading its `.vscode/settings.json`.
4. Run `KiroSight: Activate`.

## Activating KiroSight with and without a keybinding

`kirosight.activate` is the canonical entry point and **works without any keybinding**:

- **Without a keybinding:** open the Command Palette and run `KiroSight: Activate`. This is the only method on macOS.
- **With the default keybinding:** `Ctrl+Alt+K` on Windows and Linux. It was checked on one machine with a US keyboard layout and no other installed extensions (Spike A). **There is no default keybinding on macOS.**
- **Your own keybinding:** the default is rebindable. Open Keyboard Shortcuts, search for `KiroSight: Activate`, and assign any key. If `Ctrl+Alt` produces characters on your keyboard layout (it acts as AltGr on some), assign a different key or use the palette.

`KiroSight: Activate` opens or focuses the panel and puts focus in the Command field. It starts listening only when voice is already known to be ready, and it never records at startup.

## Configuration

### VS Code settings

| Setting | Default | Meaning |
|---|---|---|
| `kirosight.testCommand` | empty | The only command KiroSight will run for "run my tests". Restricted: ignored in an untrusted workspace. |
| `kirosight.testTimeoutSeconds` | 300 | Longest a test run may take. |
| `kirosight.backendCommand` | empty | Optional command for `KiroSight: Start Backend`. Machine scope, restricted in untrusted workspaces. Set it as a user setting. |
| `kirosight.backendUrl` | `ws://127.0.0.1:8765/ws` | Backend WebSocket. Only loopback hosts are accepted. Reload the window after changing it. |
| `kirosight.voice.enabled` | `true` | Turns the voice layer off when `false`. Typed input always works. Reload the window after changing it. |

### Environment variables (backend)

Defined in [docs/env-vars.md](docs/env-vars.md) and listed by name, with no values, in `.env.example` and `backend/.env.example`. The main ones:

| Purpose | Names |
|---|---|
| Backend address | `KIROSIGHT_HOST`, `KIROSIGHT_PORT` (loopback only) |
| Reasoning client | `KIROSIGHT_LLM` (`stub` by default, or `bedrock`), `BEDROCK_MODEL_ID` |
| Amazon Bedrock credentials and region | `AWS_BEARER_TOKEN_BEDROCK`, or `AWS_ACCESS_KEY_ID` with `AWS_SECRET_ACCESS_KEY`; `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_DEFAULT_REGION` |
| Deepgram | `DEEPGRAM_API_KEY`, `DEEPGRAM_STT_MODEL`, `DEEPGRAM_TTS_MODEL` |
| Optional handshake token | `KIROSIGHT_AUTH_TOKEN` (store the extension's copy with `KiroSight: Set Backend Token`) |

## Security model

- **Loopback only.** The backend binds to a loopback address and refuses any other. A WebSocket connection with an `Origin` header is rejected. The extension refuses a non-loopback `kirosight.backendUrl`.
- **A closed action list.** The agent can propose only eight actions: `NO_ACTION`, `GO_TO_DIAGNOSTIC`, `NEXT_DIAGNOSTIC`, `PREVIOUS_DIAGNOSTIC`, `OPEN_FILE`, `GO_TO_LINE`, `FOCUS_EDITOR` and `RUN_TESTS`. There is no "run this command" action. The extension re-validates every proposed action against its own registry before doing anything.
- **Tests run a trusted command only.** `RUN_TESTS` takes no parameters. The command comes from `kirosight.testCommand`, never from a message or from model output.
- **Confirmation.** Running tests always asks first, naming the exact command, and waits for "confirm", "decline", "cancel" or "repeat" (or the Confirm and Decline buttons). Saying "just do it" does not authorize something that is not pending.
- **Workspace trust.** `kirosight.testCommand` and `kirosight.backendCommand` are restricted settings. In an untrusted workspace they are ignored. Only trust a folder after reading its `.vscode/settings.json`, because that file can set the test command.
- **Secrets.** No secret is committed. Backend secrets live in the environment or an ignored `backend/.env`. The optional token lives in VS Code `SecretStorage`. The webview never receives credentials. The code is written not to log credentials, audio or file contents, and the repository hygiene tests check the extension source and webview assets for credential patterns. That is a pattern check, not proof that no secret exists.
- **What leaves your machine.** With Bedrock enabled, a request sends your question and a bounded IDE context: workspace-relative paths (never absolute paths), up to 25 diagnostics, and up to 6,000 characters of nearby code. With Deepgram enabled, recorded audio and the text of spoken replies go to Deepgram. Neither is sent when the offline stub is used and voice is off.

## Voice and typed input

Typed text is the primary, always-available path. Voice is an additive layer on top of it.

- **Typed:** type in the Command field and press Enter. The panel and the transcript work with the keyboard alone.
- **Voice:** press the push-to-talk control. It is a toggle, press again to stop. Recording also ends at 60 seconds, on Escape, or if the connection is lost. The recognized text appears in the transcript, marked as spoken, and is handled exactly like typed text, including confirmation.
- **Spoken replies:** replies to requests made by voice are spoken after their text appears in the transcript. Typed requests are not spoken, so they do not compete with your screen reader. Escape, or `KiroSight: Stop Speaking`, stops speech.
- **When voice is unavailable:** the push-to-talk control stays in the Tab order, says that voice is unavailable and why, and starts nothing. The panel status line reports which of Bedrock, speech recognition, speech output and microphone are available.

## Running the tests

Extension (Vitest), from `extension`:

```powershell
Set-Location extension
npm.cmd test
npm.cmd run typecheck
npm.cmd run compile
```

Backend (pytest), from `backend`:

```powershell
Set-Location backend
.\.venv\Scripts\python.exe -m pytest -q
```

The tests make no AWS or Deepgram requests. Credentials from your environment are isolated away from the test run. Live behavior is **not** covered by automated tests.

## Running the demo

`demo-project/` is a small TypeScript project with one deliberate type error (`TS2322` in `src/cart.ts`) and one deliberately failing test. Expect **6 passed and 1 failed**.

1. Install its dependencies once: `Set-Location demo-project; npm.cmd ci`.
2. Run the pre-flight check from the repository root:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\preflight.ps1 -OfflineOnly
   ```

   Drop `-OfflineOnly` to include the backend `/health` check and the live-service name checks. If your backend virtual environment is `backend\.venv`, add `-PythonPath .\backend\.venv\Scripts\python.exe`. If the backend uses a port other than 8765, add `-Port <number>`. The script never prints environment variable values and does not open `backend\.env` unless you add `-InspectDotenv`.
3. Follow [docs/demo-script.md](docs/demo-script.md) for the step-by-step journey, the recovery steps and the reset steps.

More about the fixture, including why its test command goes through PowerShell on Windows, is in [demo-project/README.md](demo-project/README.md).

## Limits and non-goals

**Not a goal**
- It is not a screen reader and does not reimplement generic text or UI navigation.
- It is not a general chatbot. Answers come from IDE state.
- It is not a code-editing agent. "Fix this error" and "make this change" are out of scope for the MVP.
- It is not vision-first. There is no screenshot analysis.

**Known limits**
- **Not supported:** Git status questions, symbol navigation (go to a function by name), and code edits.
- **Function names may be missing.** In the Kiro environment tested, the document symbol provider returned nothing (Spike B). KiroSight then reports the file, line and a short excerpt without a function name.
- **Windows test command.** On the development machine, running `npm test` directly inside the Extension Development Host failed to start Vitest, for a cause that was not found. The demo project's setting works around it with a PowerShell wrapper. See [demo-project/README.md](demo-project/README.md).
- **Missing-command detection is heuristic** on Windows (Spike C). A test command that does not exist is recognized from the English `cmd.exe` message, so another display language may show a generic failure instead.
- **One workspace folder.** The test command runs in the first workspace folder.
- **Live services unverified.** See [Status and verification](#status-and-verification).
- **Platforms.** Only Windows has been exercised.
- **Spike code removed.** The throwaway harnesses from the five spikes were deleted in Task 10.9. Their findings and decisions are in [docs/spike-results.md](docs/spike-results.md).

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| "No test command is configured" | The workspace is not trusted, or `kirosight.testCommand` is not set in the opened folder. Trust the folder and check `.vscode/settings.json`. |
| Status line says the backend is disconnected | The backend is not running, or the URL or port differs. Start it, then `Invoke-RestMethod http://127.0.0.1:8765/health`. Reload the window after changing `kirosight.backendUrl`. |
| Handshake refused (unauthorized) | The backend has `KIROSIGHT_AUTH_TOKEN` set. Run `KiroSight: Set Backend Token` with the same value. |
| "Bedrock unavailable" in the status line | `KIROSIGHT_LLM` is not `bedrock` (the offline stub is active), or no credential is set. |
| "Explain this error" says the reasoning service failed | Bedrock rejected or throttled the request, or the account has no inference quota. Local commands still work. Retry once at most. |
| Speech recognition or speech output unavailable | `DEEPGRAM_API_KEY` is not set or Deepgram could not be reached. Type instead. |
| Microphone unavailable or denied | Check Windows Settings, Privacy and security, Microphone. The status line says `Mic unavailable` or `Mic denied`. |
| Tests report "Cannot find module 'vitest'" in the demo | Run `npm.cmd ci` in `demo-project`. |
| Vitest fails to start inside the Development Host | Use the PowerShell wrapper command from `demo-project/.vscode/settings.json`. |
| No error is listed | Open the file. The TypeScript service reports problems for open files. |
| `Ctrl+Alt+K` types a character | Your layout uses Ctrl+Alt as AltGr. Use the palette or assign another key. |

## Accessibility

- The panel uses semantic HTML, a live transcript (`role="log"`), a status line with text labels for every state, visible focus outlines (3 px), and high-contrast and forced-colors styles. State is never conveyed by color alone.
- The transcript is always available, even while text is being spoken.
- Automated tests check structure, Tab order, focus movement, that each change is announced once, and that screen reader keys are not intercepted. **These tests cannot show what a screen reader says.**
- **Not done yet:** the manual NVDA or JAWS or VoiceOver pass, the keyboard-only walkthrough, and the focus contrast measurements. The checklist is in [docs/accessibility-checklist.md](docs/accessibility-checklist.md) and every item there is currently NOT TESTED.
- No WCAG conformance is claimed. Full validation needs testing with assistive technology and review by an accessibility expert.

## Project layout and further documentation

```
KiroSight/
├── extension/       TypeScript extension (src/, media/ webview assets, test/ Vitest)
├── backend/         Python FastAPI backend (app/, tests/, .env.example)
├── demo-project/    Demo fixture: one type error, one failing test
├── docs/            Detailed documentation
├── scripts/         preflight.ps1
└── .kiro/           Steering and the MVP spec (requirements, design, tasks)
```

| Document | Contents |
|---|---|
| [docs/env-vars.md](docs/env-vars.md) | Every environment variable, the stub versus Bedrock choice, voice setup |
| [docs/protocol.md](docs/protocol.md) | The extension to backend message contract |
| [docs/spike-results.md](docs/spike-results.md) | All five technical spikes and the decisions taken |
| [docs/demo-script.md](docs/demo-script.md) | Demo journey, pre-flight, recovery and reset |
| [docs/accessibility-checklist.md](docs/accessibility-checklist.md) | Manual accessibility review checklist (not yet performed) |
| [demo-project/README.md](demo-project/README.md) | The demo fixture |
