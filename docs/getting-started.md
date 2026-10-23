# Getting started with KiroSight

This guide takes you from a fresh clone to a working KiroSight session, then explains every command, the optional voice and Amazon Bedrock features, and what to do when something goes wrong. The commands are written for **Windows PowerShell**, because Windows is the only platform that has been exercised.

Back to the [project README](../README.md).

## Contents

- [A. Prerequisites](#a-prerequisites)
- [B. Clone and install](#b-clone-and-install)
- [C. Launch the KiroSight extension](#c-launch-the-kirosight-extension)
- [D. Python backend setup](#d-python-backend-setup)
- [E. Voice input and output](#e-voice-input-and-output)
- [F. Amazon Bedrock](#f-amazon-bedrock)
- [G. How to use KiroSight](#g-how-to-use-kirosight)
- [H. Troubleshooting](#h-troubleshooting)
- [I. Testing and accessibility](#i-testing-and-accessibility)

**What you can skip.** The typed, local features need only sections A to C. The backend (D) adds the connection status and the reasoning client. Voice (E) and Bedrock (F) are optional and need accounts with those services.

---

## A. Prerequisites

| Requirement | Version | Where this comes from |
|---|---|---|
| Operating system | Windows. macOS and Linux are untested. | The only platform used for development and manual checks (see [spike-results.md](spike-results.md)). |
| Kiro IDE | A build whose VS Code engine is at least `1.125.0`. | `engines.vscode` is `^1.125.0` in `extension/package.json`. The Kiro build used for the spikes was `1.2.4` (Spike A). |
| Node.js | `22.12.0` or later. | `engines.node` is `>=22.12.0` in `extension/package.json`. The Windows process checks in Spike C ran on Node `v24.14.1`. |
| npm | Whatever ships with that Node.js. Use `npm.cmd` in PowerShell. | No separate npm version is declared. |
| Python | Python 3. **No minimum version is declared in the repository.** | `backend/requirements.txt` pins the packages but there is no `pyproject.toml`, `.python-version` or similar. Use a current Python 3 release that has wheels for the pinned packages. A specific minimum has not been verified. |
| Git | Any recent version. | Needed to clone. |
| Deepgram API key | Optional. | Only for speech recognition and spoken replies ([section E](#e-voice-input-and-output)). |
| AWS account with Amazon Bedrock inference access | Optional. | Only for live "explain this error" answers ([section F](#f-amazon-bedrock)). |

The TypeScript compiler (`typescript` 7.0.2), Vitest and the other JavaScript dependencies are pinned in `extension/package-lock.json` and installed by `npm.cmd ci`. The Python packages are pinned in `backend/requirements.txt`. You do not install them by hand.

Check your tools:

```powershell
node --version
npm.cmd --version
python --version
git --version
```

---

## B. Clone and install

Run these in PowerShell, in the folder where you keep your projects.

```powershell
git clone https://github.com/aahnasinghh/KiroSight.git
Set-Location KiroSight
```

Install the extension's dependencies and compile it. `dist/` is ignored by Git, so a fresh clone **must** be compiled before the extension can load.

```powershell
Set-Location extension
npm.cmd ci
npm.cmd run compile
Set-Location ..
```

`npm.cmd run compile` runs `tsc -p tsconfig.json` and writes `extension/dist/`. The launch configuration loads `extension/dist/extension.js`. **Pressing F5 does not compile for you** (the launch configuration has no pre-launch build step), so run `npm.cmd run compile` again after you change any extension source.

Install the demo project's dependencies once. You need them to run its tests (not for the first "where am I" command):

```powershell
Set-Location demo-project
npm.cmd ci
Set-Location ..
```

If `npm.cmd ci` reports that `package-lock.json` is missing in `demo-project`, run `npm.cmd install` there instead. That is the command `demo-project/README.md` documents.

---

## C. Launch the KiroSight extension

### The two windows

You will work with two Kiro windows. Do not confuse them.

| Window | What it is | What you do there |
|---|---|---|
| **Main Kiro window** | The window where you open the **KiroSight repository root**. It holds the source code and the Run and Debug view. | Start the launch configuration. Edit code. Nothing in this window runs KiroSight. |
| **Extension Development Host** | A second, separate Kiro window that opens when you press F5. It is a normal Kiro window with the KiroSight extension loaded from `extension/`. | Open `demo-project` here. Run `KiroSight: Activate` here. Use the KiroSight panel here. |

`KiroSight: Activate` and every other KiroSight command exist **only in the Extension Development Host**. If the Command Palette in the main window says the command was not found, you are in the wrong window (see [Troubleshooting](#kirosightactivate-not-found)).

### Steps

1. **Open the repository root in Kiro.** Use File, Open Folder, and choose the `KiroSight` folder you cloned (the folder that contains `extension/`, `backend/` and `demo-project/`).
2. **Select the launch configuration.** Open the Run and Debug view (`Ctrl+Shift+D`). In the drop-down at the top, choose **Run KiroSight Extension**. This is the only configuration in `.vscode/launch.json`. It is of type `extensionHost` and passes `--extensionDevelopmentPath=${workspaceFolder}/extension`.
3. **Press F5.** Press it while the **Run KiroSight Extension** configuration is selected, and preferably while a TypeScript file (not a Markdown file) is the active editor. A second window opens: the Extension Development Host. If Kiro offers to debug Markdown instead, see [Troubleshooting](#kiro-tries-to-debug-markdown).
4. **Open `demo-project` in that new window.** In the Extension Development Host, choose File, Open Folder, and select the `demo-project` folder inside your clone. Open it as the **only** folder. Do not add it to a multi-root workspace, because KiroSight runs the test command in the first workspace folder.
5. **Trust the demo workspace.** When Kiro asks whether you trust the authors, read `demo-project/.vscode/settings.json` first. It contains two settings: `kirosight.testCommand` (`powershell.exe -NoProfile -Command "npm.cmd test"`) and `kirosight.testTimeoutSeconds` (120). If you are happy with them, choose to trust the folder. Do not turn workspace security off. `kirosight.testCommand` is a restricted setting, so in an untrusted workspace Kiro ignores it and "run my tests" cannot work.
6. **Open `src/cart.ts`.** Use `Ctrl+P`, type `cart.ts` and press Enter. The TypeScript service reports problems only for open files, so the demo's deliberate type error appears in the Problems list once this file is open.
7. **Activate KiroSight.** Either:
   - open the Command Palette (`Ctrl+Shift+P`) and run **KiroSight: Activate**, or
   - press **`Ctrl+Alt+K`** (the default on Windows and Linux; there is no default on macOS).

   The panel opens or takes focus, with the cursor in the **Command** field.

The keybinding was checked on one machine with a US layout and no other extensions (Spike A). If `Ctrl+Alt+K` types a character on your keyboard layout, use the Command Palette or assign another key in Keyboard Shortcuts.

If you do not start the backend (section D), everything in the local command table in [section G](#g-how-to-use-kirosight) still works. The panel's status line will read `Backend: disconnected`.

---

## D. Python backend setup

The backend is optional for the local commands. It supplies the connection status, the offline stub reasoning client, and the paths to Deepgram and Bedrock. It listens on loopback only.

All commands below run from the **repository root** unless they say otherwise.

### 1. Go to `backend/`

```powershell
Set-Location backend
```

### 2. Create a virtual environment

```powershell
python -m venv .venv
```

`.venv/` is ignored by Git.

### 3. Activate it

```powershell
.\.venv\Scripts\Activate.ps1
```

If PowerShell refuses with an execution-policy error, you do not have to change your policy. Skip activation and call the interpreter directly in every command below, replacing `python` with `.\.venv\Scripts\python.exe`.

### 4. Install the dependencies

```powershell
python -m pip install -r requirements.txt
```

This installs the pinned runtime and test packages, including `sounddevice` for backend microphone capture (the Windows wheel includes PortAudio).

### 5. Configure offline stub mode

**Offline stub mode is the default and needs no configuration.** Do not create `backend\.env`. Make sure no variable in your PowerShell session or system environment selects something else:

```powershell
Remove-Item Env:KIROSIGHT_LLM -ErrorAction SilentlyContinue
```

With `KIROSIGHT_LLM` unset (or set to `stub`) the backend makes no network calls and answers agent requests with the fixed text "KiroSight backend is connected." The panel will show `Bedrock unavailable`, which is expected. Process environment variables win over `backend\.env`, so a leftover `KIROSIGHT_LLM=bedrock` in your environment would override a `.env` file too.

### 6. Start the FastAPI backend

Still in `backend/`:

```powershell
python -m app.main
```

This runs `app.main.run()`, which starts uvicorn on the host and port from the configuration: `127.0.0.1` and `8765` by default. Leave this terminal open. The backend writes its log lines here. It refuses any non-loopback `KIROSIGHT_HOST`, and it stops at startup if `KIROSIGHT_LLM` has an unknown value.

### 7. Verify `GET /health`

Open a **second** PowerShell window:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8765/health
```

Expect an object whose `status` is `ok`. If you changed `KIROSIGHT_PORT`, use that port instead. Then open (or look at) the KiroSight panel in the Extension Development Host. Within a moment the status line should read `Backend: connected · Bedrock unavailable · STT unavailable · TTS unavailable · Mic available` or similar. Which parts say `available` depends on your configuration (see [Voice](#e-voice-input-and-output) and [Bedrock](#f-amazon-bedrock)).

### 8. Shut it down cleanly

Click into the terminal that is running the backend and press **`Ctrl+C`**. Uvicorn closes open connections and exits. Then, if you activated the virtual environment:

```powershell
deactivate
```

The panel's status line returns to `Backend: disconnected` and the local commands keep working. Start the backend again and the panel reconnects.

### Authentication token (optional)

The backend works without an authentication token, and so does the extension. If you want the WebSocket handshake to require a shared token:

1. Choose a secret value. Set it as `KIROSIGHT_AUTH_TOKEN` in the backend's environment or in `backend\.env` (copy `backend\.env.example` to `backend\.env` first; the file is ignored by Git). Restart the backend.
2. In the Extension Development Host run **KiroSight: Set Backend Token** and enter the same value in the masked box. The extension stores it in VS Code `SecretStorage`.

If the backend has a token and the extension does not (or the values differ), the handshake is refused with an unauthorized error and the status line will not show `connected`. This was checked against `backend/app/main.py`: the token is compared with `hmac.compare_digest`, and the backend reads it per connection after `.env` is loaded. Never put a real token in a command line, a screenshot or a commit.

### Other backend settings

| Variable | Default | Purpose |
|---|---|---|
| `KIROSIGHT_HOST` | `127.0.0.1` | Loopback addresses only. |
| `KIROSIGHT_PORT` | `8765` | If you change it, also change `kirosight.backendUrl` in your **user** settings and reload the window. |

The full list is in [env-vars.md](env-vars.md). The extension setting `kirosight.backendUrl` defaults to `ws://127.0.0.1:8765/ws` and accepts only loopback hosts.

---

## E. Voice input and output

Voice is optional. Typed input always works, and a voice failure never disables it.

### What you need

- A Deepgram API key. KiroSight uses Deepgram for speech recognition (default model `nova-2`) and for spoken replies (default model `aura-asteria-en`).
- A working default microphone on the machine that runs the backend. The **backend** records, using `sounddevice`. KiroSight did not use the Kiro webview for capture because the webview refused the microphone in Spike D.

### 1. Configure Deepgram (backend only)

Copy the template and edit the copy. Real values never go into `backend\.env.example`, a command line or the repository:

```powershell
Copy-Item backend\.env.example backend\.env
```

In `backend\.env` fill in only the line you need:

```
DEEPGRAM_API_KEY=<your Deepgram key>
```

Leave `DEEPGRAM_STT_MODEL` and `DEEPGRAM_TTS_MODEL` empty to use the defaults. If you set them, use letters, digits, `.`, `_`, `:` and `-` only (at most 64 characters); anything else disables that capability. Restart the backend. The extension and the webview never see this key.

### 2. Enable the voice setting

`kirosight.voice.enabled` defaults to `true`, so there is usually nothing to do. If you turned it off, set it back to `true` in Settings and **reload the Extension Development Host window** (Command Palette, `Developer: Reload Window`). When it is `false`, the panel says "Voice is turned off in the KiroSight settings. You can keep typing."

### 3. Grant microphone permission

Because the backend records, the permission is the operating system's:

1. Open Windows Settings, Privacy and security, Microphone.
2. Turn on microphone access and allow desktop apps to use the microphone.

Nothing records at startup. The microphone opens only after you press push-to-talk, and it closes when you stop, cancel, reach 60 seconds, or the connection drops. Audio stays in memory.

### 4. Use push to talk

1. Open the panel (`KiroSight: Activate`) and wait for the voice note to read "Voice is ready. Press push-to-talk to speak." (or "Microphone permission has not been granted yet. Press push-to-talk to request it.").
2. Move to the **Push to talk** button (it is in the Tab order, after the Send button) and press Enter or Space. The button now reads **Stop listening**.
3. Say a command from the table in [section G](#g-how-to-use-kirosight), for example "where am I".
4. Press the button again to stop. You can also press `Escape`. Recording also stops at 60 seconds or if the connection is lost.
5. The recognized text appears in the Transcript as your query, marked as spoken, and is handled exactly like typed text, including the confirmation step.

When `kirosight.activate` runs while voice is already known to be ready, it starts listening as well. It never records without a deliberate action.

Spoken replies: a reply to a request made **by voice** is spoken after its text appears in the Transcript. Replies to typed requests are not spoken, so they do not compete with your screen reader. `Escape` or **KiroSight: Stop Speaking** stops speech.

### 5. Tell what is working and what is not

Read the **status line** in the panel. When the backend is connected it lists four capabilities:

```
Backend: connected · Bedrock available · STT available · TTS available · Mic available
```

| Part of the status line | Means |
|---|---|
| `STT available` | `DEEPGRAM_API_KEY` is set and speech recognition is configured. |
| `TTS available` | The same key is set and spoken replies are configured. |
| `Mic available` | A default input device exists. `Mic unavailable` means none was found; `Mic denied` means the OS refused access. |
| `Bedrock available` | A Bedrock credential is configured and `KIROSIGHT_LLM=bedrock` ([section F](#f-amazon-bedrock)). |

`available` means "configured". It does **not** prove that Deepgram will accept a request or that the microphone will work. `Mic available` in particular is a hint: the first real recording is the real test, and `denied` is only detected when the device is opened.

The **push-to-talk note** under the button gives the reason in words when voice cannot be used, for example:

- "Voice input is unavailable because the KiroSight backend is not connected."
- "Voice input is unavailable because speech recognition is not set up."
- "Voice input is unavailable because microphone permission was denied."
- "Voice input is unavailable on this setup."

When voice is unavailable, the button stays in the Tab order, says so, and starts nothing.

**Not verified.** Deepgram speech recognition, spoken replies and microphone capture have **not** been verified in a live end-to-end run. Rehearse them once before relying on them. The checklist is in [demo-script.md](demo-script.md) (Part 1.6).

---

## F. Amazon Bedrock

Bedrock is optional. It is the only reasoning provider KiroSight supports, and it is used for "explain this error" and for the written summary of test failures. There is no fallback provider.

### Offline stub versus live reasoning

| | Offline stub (default) | Live reasoning (Bedrock) |
|---|---|---|
| How to select | Leave `KIROSIGHT_LLM` unset, or set it to `stub`. | Set `KIROSIGHT_LLM=bedrock` and a credential. |
| Network calls | None. | Your question and a bounded IDE context go to Amazon Bedrock. |
| "Explain this error" | Returns the fixed text "KiroSight backend is connected." This is **not** an explanation. | A short explanation grounded in the file, line and message, if your account has inference quota. |
| Status line | `Bedrock unavailable` | `Bedrock available` once a credential is configured. |
| After a failure | Not applicable. | A stated error in the Transcript. The stub is **never** substituted after a Bedrock failure, and nothing retries on another provider. |

### Disclosure: live Bedrock is not verified

**Live Amazon Bedrock inference has not been verified for this hackathon submission.** The development account's Bedrock inference quota was zero and requests were throttled (Spike E, Task 7.14 is still open). The Bedrock client is tested only against mocked responses. `Bedrock available` in the status line means a credential is configured, not that Bedrock will answer.

### Configure it

Copy the template and fill in only what you need in `backend\.env` (never commit it):

```powershell
Copy-Item backend\.env.example backend\.env
```

Two authentication methods are supported:

| Method | Variables | Notes |
|---|---|---|
| Bedrock API key | `AWS_BEARER_TOKEN_BEDROCK` | Read by the AWS SDK itself. The backend only checks that it is set. |
| AWS access keys | `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, plus `AWS_SESSION_TOKEN` for temporary credentials | Both keys of the pair are required. |

Also set:

| Variable | Default | Purpose |
|---|---|---|
| `KIROSIGHT_LLM` | `stub` | Set to `bedrock` to use Bedrock. Any other value (besides `stub`) stops the backend at startup. |
| `AWS_REGION` | `us-east-1` | Region for the Bedrock client. `AWS_DEFAULT_REGION` is used when `AWS_REGION` is unset. |
| `BEDROCK_MODEL_ID` | `amazon.nova-lite-v1:0` | Model used through the Converse API. |

With `KIROSIGHT_LLM=bedrock` and no credential, requests fail closed with a "credential missing" error that names the variables. No other credential source (such as an AWS profile) is documented or tested. Restart the backend after any change.

---

## G. How to use KiroSight

Type into the **Command** field and press Enter, or say the same words with push-to-talk. Matching is on the whole normalized phrase, and the answer always appears in the Transcript first.

The table lists what the router recognizes. **Checked in source** means each phrase was read against the router and handlers in the code. It does not mean it was run live: the full demo journey has not been rehearsed end to end.

### Commands

| You say or type | Expected action | Needs |
|---|---|---|
| "where am I", "what file am I in", "what file is this" | Names the file, line and column, and the enclosing function if the editor can name it. | Extension only |
| "what function am I in", "read the current function" | Names the function at the cursor. | Extension only. Depends on the editor's symbol provider. |
| "read the selection" | Reads the selected text. | Extension only |
| "what errors are there", "list errors" | Lists workspace errors with severity, file, line, function when known, and message. | Extension only |
| "what errors are in this file" | The same, for the current file. | Extension only |
| "go to the first error" (also second, third) | Moves the cursor to that error. | Extension only |
| "next error", "previous error" | Moves between errors. | Extension only |
| "go to line 40", "line 40" | Moves to that line. | Extension only |
| "open discount.ts" | Opens a file by workspace-relative path or file name. | Extension only |
| "focus editor", "back to editor" | Returns focus to the editor. | Extension only |
| "run my tests", "run tests" | Asks for confirmation, naming the exact command, then runs `kirosight.testCommand`. | Extension only |
| "confirm", "decline", "cancel", "repeat" | Answers a pending confirmation. | Extension only |
| "summarize the test failures", "list all failures" | Reads the stored last test result. | Extension only. A written summary needs the backend and Bedrock. |
| "help", "what can you do" | Lists the supported commands. | Extension only |
| "explain this error" and other phrases starting with "explain", "why", "what does", "how do" or "summarize" | Sent to the backend agent. | Backend. A real answer needs Bedrock. |

Palette commands: `KiroSight: Activate`, `Where Am I`, `Describe Errors`, `Next Error`, `Previous Error`, `Ask`, `Run Tests`, `Show Test Output`, `Start Backend`, `Set Backend Token` and `Stop Speaking`.

Not supported: Git status questions, symbol navigation (go to a function by name) and code edits ("fix this error").

### About the demo fixture

`demo-project` is built to fail in two specific ways:

- **One type error:** `TS2322` in `src/cart.ts`, in `formatReceiptLine` (a number assigned to a `string` variable).
- **One failing test** in `tests/discount.test.ts`. A correctly configured run gives **6 passed and 1 failed** (7 tests in 2 files), and a non-zero exit code.

The failure is deliberate. It is the demo, not a KiroSight bug. If you see a different result, or no tests run at all, see [Troubleshooting](#test-execution-or-parsing-problems).

### Walkthrough

Start with `src/cart.ts` open in the Extension Development Host and the panel active.

1. **Where am I.** Type `where am I`. Expect a sentence naming `src/cart.ts`, the line and column, and the function when the editor can name it. In Kiro the symbol provider may return nothing (Spike B). Then you get the file, line and a short excerpt without a function name.
2. **What errors are there.** Type `what errors are there`. Expect one line like `Error in src/cart.ts at line 15, in function formatReceiptLine: ` followed by the TypeScript message about `number` not being assignable to `string`. If nothing is listed, make sure `src/cart.ts` is open and wait for the Problems list to show the error.
3. **Go to the first error.** Type `go to the first error`. The cursor moves to that line in `cart.ts`. Check it in the editor.
4. **Run my tests.** Type `run my tests`. KiroSight does **not** run anything yet. It shows a confirmation naming the exact command, `powershell.exe -NoProfile -Command "npm.cmd test"`, and focus moves to the prompt text.
5. **Decline.** Type `decline` (or Tab to the Decline button and press Enter). The request is discarded. Nothing ran. Focus returns to the Command field.
6. **Run my tests again, then confirm.** Type `run my tests`, and this time type `confirm`. The tests run once. Expect `Tests failed: 6 passed, 1 failed.` followed by `Failing tests:` and the name of the failing test in `tests/discount.test.ts`. If you type `repeat` while the prompt is pending, you hear the same prompt again.
7. **Summarize the test failures.** Type `summarize the test failures`. KiroSight reads the stored result again, naming the failing test. A written summary appears after the run only if Bedrock answers.
8. **Help.** Type `help`. KiroSight lists the supported commands. This works with the backend stopped.

Optionally try `explain this error` (needs the backend; see [section F](#f-amazon-bedrock) for what you will get).

Saying "just do it" does not authorize anything that is not pending. Running tests asks every time. For the timed demo script, the recovery steps and the reset steps, see [demo-script.md](demo-script.md).

---

## H. Troubleshooting

### `kirosight.activate` not found

The Command Palette says the command does not exist.

- **Wrong window.** The command is available only in the **Extension Development Host** (the second window opened by F5), not in the main window where you opened the repository root.
- **Extension not compiled.** `extension/dist/` is created by `npm.cmd run compile`. Run it in `extension`, then press F5 again. The extension loads `./dist/extension.js`.
- **Compile errors.** Run `npm.cmd run typecheck` in `extension` and fix the reported errors.
- **Wrong launch configuration.** The extension is loaded only by **Run KiroSight Extension**.
- **Older Development Host still open.** Close it and press F5 again so the freshly compiled code loads.

### Kiro tries to debug Markdown

If a `.md` file (such as this guide) is the active editor when you press F5, Kiro may ask which debugger to use for Markdown, or fail to start. Open the Run and Debug view (`Ctrl+Shift+D`), choose **Run KiroSight Extension** in the drop-down, and use its Start button. Or click into a TypeScript file such as `extension/src/extension.ts` and press F5 again.

### Missing demo-project dependencies

Symptoms: the tests report `Cannot find module 'vitest'`, or `npm.cmd run typecheck` fails in `demo-project`. Run `npm.cmd ci` (or `npm.cmd install`) in `demo-project`. `node_modules/` is ignored by Git, so a fresh clone never has it.

### Cannot connect to backend

- The status line reads `Backend: disconnected`: the backend is not running. Start it ([section D](#d-python-backend-setup)) and check `Invoke-RestMethod -Uri http://127.0.0.1:8765/health`.
- Another program already uses port 8765. Set `KIROSIGHT_PORT` for the backend, set `kirosight.backendUrl` to match (user setting), and reload the window.
- The status line says the backend URL setting is not a valid loopback WebSocket URL: only `127.0.0.1`, `localhost` and `[::1]` are accepted.
- `Backend: incompatible protocol version`: the extension and backend come from different versions of the repository. Update both.
- The handshake is refused as unauthorized: the backend has `KIROSIGHT_AUTH_TOKEN` set. Run **KiroSight: Set Backend Token** with the same value (see [section D](#authentication-token-optional)).
- You started the backend after the panel opened: it reconnects on its own after a moment. Reload the window if it does not.

Local commands such as "where am I" keep working while the backend is down.

### Microphone unavailable

The status line reads `Mic unavailable` or `Mic denied`. Check that a default input device exists and that Windows Settings, Privacy and security, Microphone allows desktop apps. Close other programs that hold the microphone. Then press push-to-talk again; the note says the next press will retry. If the backend cannot load `sounddevice`/PortAudio it reports `Mic unavailable` and everything else still works.

### Deepgram STT/TTS unavailable

`STT unavailable` or `TTS unavailable` in the status line, or "speech recognition is not set up" in the voice note, usually means `DEEPGRAM_API_KEY` is not set where the backend can see it. Set it in `backend\.env` (or the backend's environment), restart the backend and check again. If the key is set and requests still fail, Deepgram may be unreachable, or the key may be invalid. Type your commands instead. The Transcript is unaffected. Spoken replies come after the text, so a TTS failure never hides an answer.

### Voice transcription errors

If speech is recognized wrongly or not at all: speak closer to the microphone, keep to the short phrases in the command table, and check the Transcript to see what was heard. A wrongly recognized phrase falls through to the backend agent instead of a local command. You can always type the phrase. "No audio was recorded" or a "no speech" message means the microphone captured nothing: check the device. Recording stops at 60 seconds.

### Test execution or parsing problems

- **"No test command is configured"**: the workspace is not trusted, or `kirosight.testCommand` is not set in the opened folder. Trust the folder, and check `.vscode/settings.json`.
- **The tests did not start**: Vitest failing to start (for example `Cannot read properties of undefined (reading 'config')`, with no tests run) is **not** the demo. It was seen when `npm test` ran directly inside the Extension Development Host on the development machine, for a cause that was not found. The demo's PowerShell wrapper avoids it. Make sure you have not replaced `kirosight.testCommand` with plain `npm test`. See [demo-project/README.md](../demo-project/README.md).
- **Run the command by hand** to see the real result. From `demo-project`:

  ```powershell
  powershell.exe -NoProfile -Command "npm.cmd test"
  ```

  Expect `Tests  1 failed | 6 passed (7)` and a non-zero exit code.
- **Raw output**: run **KiroSight: Show Test Output** to open the `KiroSight Tests` output channel.
- **Result could not be parsed**: if the tests ran but the summary cannot be read, KiroSight says "Tests completed, but KiroSight could not parse the test summary" and points to the `KiroSight Tests` output.
- **"Command not recognized"**: detection of a missing command on Windows is a heuristic that depends on English `cmd.exe` wording (Spike C). Another display language may show a generic failure instead.
- **On macOS or Linux**: `powershell.exe` is normally not installed. Set `kirosight.testCommand` to `npm test` in `demo-project/.vscode/settings.json` and check it in a terminal first. This platform is untested.

### Workspace trust restrictions

`kirosight.testCommand` and `kirosight.backendCommand` are restricted settings. In an **untrusted** (restricted mode) workspace Kiro ignores them. KiroSight then says no test command is configured, and **KiroSight: Start Backend** cannot start anything. Use Command Palette, `Workspaces: Manage Workspace Trust` to trust the folder, after reading its `.vscode/settings.json`, because that file can set the command KiroSight runs. `kirosight.backendCommand` is a machine-scoped setting: set it in your **user** settings, not in a workspace file. Starting the backend by hand ([section D](#d-python-backend-setup)) has no such dependency.

### Other

| Symptom | Fix |
|---|---|
| No error is listed | Open `src/cart.ts`. Problems are reported for open files. |
| `Ctrl+Alt+K` types a character | Your layout uses Ctrl+Alt as AltGr. Use the Command Palette or assign another key. |
| "Bedrock unavailable" in the status line | `KIROSIGHT_LLM` is not `bedrock` (the stub is active), or no credential is set. |
| "Explain this error" says the reasoning service failed | Bedrock rejected or throttled the request, or the account has no inference quota. Retry once at most. Local commands still work. |

---

## I. Testing and accessibility

### Automated validation commands

These run no AWS or Deepgram requests. Credentials from your environment are isolated away from the test run.

Extension (Vitest), from `extension`:

```powershell
Set-Location extension
npm.cmd test
npm.cmd run typecheck
npm.cmd run compile
Set-Location ..
```

`npm.cmd test` runs `vitest --run` (a single run, no watch mode).

Backend (pytest), from `backend`, with the virtual environment from section D active:

```powershell
Set-Location backend
python -m pytest -q
Set-Location ..
```

Demo project, from `demo-project` (a failing test is expected here):

```powershell
Set-Location demo-project
npm.cmd run typecheck   # expect exactly one error: src/cart.ts, TS2322
npm.cmd test            # expect 1 failed | 6 passed (7), and a non-zero exit code
Set-Location ..
```

Pre-flight check for the demo, from the repository root. Add `-PythonPath .\backend\.venv\Scripts\python.exe` when your backend environment is `backend\.venv` (the script's default points at a different location), and drop `-OfflineOnly` to include the backend and live-service checks:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\preflight.ps1 -OfflineOnly
```

### What has been tested and what has not

| Kind of check | State |
|---|---|
| Vitest suites for the extension (command routing, action validation, protocol validation, panel structure and announcements in jsdom, repository hygiene checks for credential patterns) | Present. Run them with the commands above. |
| pytest suites for the backend (protocol, allow-list, agent logic with mocked clients, configuration, logging redaction) | Present. Run them with the commands above. |
| Live Amazon Bedrock | **Not verified.** Tests use mocks. |
| Live Deepgram speech recognition and spoken replies | **Not verified end to end.** |
| Microphone capture on a real device | **Needs a manual check.** |
| Full demo journey ([demo-script.md](demo-script.md)) | **Written, not rehearsed.** |
| Screen reader pass (NVDA, JAWS, VoiceOver), keyboard-only walkthrough, contrast measurements | **Not tested.** See [accessibility-checklist.md](accessibility-checklist.md); every result there is NOT TESTED. |

Automated tests cannot show what a screen reader says. A command that exits without error is not evidence that a live service works.

### Accessibility

KiroSight **supplements** your screen reader. It does not replace NVDA, JAWS or VoiceOver, and it does not intercept their keys.

- The panel uses semantic HTML, a live Transcript (`role="log"`), text labels for every state, visible focus outlines, and high-contrast and forced-colors styles. State is never conveyed by color alone.
- The Transcript is always available, even while a reply is being spoken, so you can read every answer with your own screen reader.
- Everything reachable by voice is reachable by typed text and the keyboard. Tab order with nothing pending: Transcript, Command field, Send, Push to talk. While a confirmation is pending: Transcript, Confirm, Decline, Command field, Send, Push to talk.
- **KiroSight does not claim WCAG conformance.** Full validation needs manual testing with assistive technologies and review by an accessibility expert. The automated checks catch some problems and cannot certify compliance.

---

Back to the [project README](../README.md).
