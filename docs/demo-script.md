# KiroSight demo script and pre-flight

This is the script for the KiroSight demo: a developer who is blind or has low vision uses structured IDE state in Kiro to find an error, understand it, and run tests, with every step available as typed text, by keyboard, or by voice.

**Status of this document: written, not yet rehearsed.** Every command below was checked against the router and handlers in the code (see "What was checked in the code"). Nothing here has been run live. Steps that need Deepgram, Amazon Bedrock or a microphone are marked **LIVE** and must be rehearsed once before presenting. Steps marked **OFFLINE** need only the extension and the demo project.

The demo supplements the presenter's own screen reader. It does not replace it. The text transcript in the panel is always available and is the source of truth if speech fails.

## The three kinds of step

| Label | Needs | If it fails |
|---|---|---|
| OFFLINE | The extension and `demo-project/`. No backend, no network. | Fix before presenting. These are the core of the demo. |
| BACKEND | The local KiroSight backend on `127.0.0.1` only. | Typed local commands still work. Only agent-routed steps and voice are affected. |
| LIVE | Deepgram, Amazon Bedrock, a microphone or the network. | Say so, use the typed alternative, and continue. Never hide a failure. |

## Part 1: Pre-flight (do this before the audience arrives)

### 1.1 Run the pre-flight script (OFFLINE and BACKEND)

From the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\preflight.ps1
```

Useful variations:

```powershell
# Offline-only version of the demo: skips the backend and live checks.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\preflight.ps1 -OfflineOnly

# Also resolve the Bedrock and Deepgram host names in DNS (no request is sent to either service).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\preflight.ps1 -CheckNetwork

# Opt in to reading backend\.env for the NAMES of entries that have a value (never the values).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\preflight.ps1 -InspectDotenv

# The backend uses a port other than 8765 (for example set in backend\.env): pass the same number.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\preflight.ps1 -Port 8766
```

**Credential files.** By default the script checks the PowerShell process environment only and does not open `backend\.env`. The backend itself also reads `backend\.env`, so a name that is not in your process environment is reported as INFO (unknown), not as "not set". `-OfflineOnly` never opens `backend\.env`, even with `-InspectDotenv`. With `-InspectDotenv` the script reads only the names of entries that have a value, and prints and keeps no value. It cannot tell from a `.env` entry whether `KIROSIGHT_LLM` selects Bedrock, so read "Bedrock available" in the panel status line for that.

**Port.** The `/health` check uses `KIROSIGHT_PORT` from the PowerShell process environment, or 8765. It does not read the port from `backend\.env`. If you configured the port there (or anywhere this shell does not see), pass the same number with `-Port`, or the check will look at the wrong port.

Every line starts with a label: PASS, FAIL, WARN or INFO, then the area (OFFLINE, BACKEND or LIVE). The script checks:

- The demo project files exist, dependencies are installed, and the extension is compiled.
- `kirosight.testCommand` is set in `demo-project\.vscode\settings.json` and matches the documented command. If it differs, the script says so but does not print the configured text, because a custom command could contain a secret.
- Typecheck reports exactly one error, `TS2322` in `src/cart.ts`.
- The documented test command gives **1 failed and 6 passed (7)** with a non-zero exit code.
- The demo project has no uncommitted changes against Git. If the Git command itself fails, the script warns that it could not compare, and does not call the project clean.
- The backend answers `GET /health` on `127.0.0.1` with status `ok`.
- Which environment variable **names** are set in the process environment (`DEEPGRAM_API_KEY`, `KIROSIGHT_LLM`, and a Bedrock credential). It never prints a value.

Read each FAIL aloud and fix it. A WARN in the LIVE area only means that step will not work live. The script cannot check the workspace trust prompt, the microphone, or whether Bedrock will accept a request. Those are in 1.5 and 1.6.

### 1.2 Open the correct workspace

1. In Kiro, open the **KiroSight repository root** and run the launch configuration **Run KiroSight Extension** (it starts the Extension Development Host). Compile first if the pre-flight said the extension is not compiled:

   ```powershell
   Set-Location extension
   npm.cmd run compile
   ```

2. In the Extension Development Host window, use File, Open Folder and choose the **`demo-project`** folder. Do not open it as part of a multi-root workspace: the test command runs in the first workspace folder, and it must be `demo-project`.
3. When Kiro asks whether you trust the folder, choose to trust it, after you have read `demo-project\.vscode\settings.json`. It holds one test command. If the workspace is not trusted, Kiro ignores `kirosight.testCommand` and KiroSight will say that no test command is configured.
4. Open `src/cart.ts` in the editor. The TypeScript service reports problems for open files, so the error appears only once the file is open. Wait until the Problems list shows the error.

### 1.3 Start the backend (BACKEND)

Skip this for the offline-only demo. Use a second terminal, from the `backend` folder:

```powershell
Set-Location backend
& "$env:USERPROFILE\.venvs\KiroSight\Scripts\python.exe" -m app.main
```

The backend binds to `127.0.0.1` port `8765` unless `KIROSIGHT_HOST` and `KIROSIGHT_PORT` say otherwise. It refuses non-loopback addresses. It reads its configuration from the process environment and from `backend\.env` if that file exists. Real values go only there, never in a command line or in this repository.

- If you set `KIROSIGHT_AUTH_TOKEN` for the backend, run `KiroSight: Set Backend Token` in the Extension Development Host and enter the same token in the masked box. Otherwise the handshake is refused.
- `KiroSight: Start Backend` can launch the backend for you only if the user setting `kirosight.backendCommand` is configured. Starting it by hand, as above, has no such dependency.
- Reload the Extension Development Host window after changing `kirosight.backendUrl`.

Check it:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8765/health
```

Expect `status` of `ok`.

### 1.4 Choose the reasoning mode (LIVE for Bedrock)

| Mode | How | What "explain this error" does |
|---|---|---|
| Offline stub (default) | Leave `KIROSIGHT_LLM` unset, or set it to `stub`. | Returns the fixed text "KiroSight backend is connected." This is **not** an explanation. The panel shows "Bedrock unavailable". Say so honestly. |
| Amazon Bedrock | Set `KIROSIGHT_LLM=bedrock` and a Bedrock credential (see `docs/env-vars.md`), then restart the backend. | A short explanation grounded in the IDE context, **if** your account has quota. |

The status line is the truth. `Bedrock available` means a credential is configured. It does not prove Bedrock will answer; the first real request is the test. Live Bedrock verification is still pending (Task 7.14), so rehearse this step.

### 1.5 Check the panel status line (BACKEND and LIVE)

In the Extension Development Host run `KiroSight: Activate` (Ctrl+Alt+K on Windows). Read the status text. When the backend is connected it reads like:

`Backend: connected · Bedrock available · STT available · TTS available · Mic available`

Each part may instead say unavailable (and Mic may say denied). Compare with what you plan to demo:

| You want to show | Needs in the status line | Otherwise |
|---|---|---|
| Typed local commands | Nothing | Always works. |
| "Explain this error" for real | `Bedrock available` | Use the stated-error recovery in Part 3. |
| Speaking a command | `STT available` and `Mic available` | Type the command. Say why. |
| Spoken replies | `TTS available` | Read the transcript. The text is always there. |

If a part says `unavailable` that you expected to be available, stop and read the transcript note. Do not troubleshoot in front of the audience.

### 1.6 Live rehearsal (LIVE, do once, end to end)

1. Press push-to-talk (or Ctrl+Alt+K once the panel says voice is ready) and say "where am I". Expect the same transcript result as typing it, with the line marked as spoken.
2. Confirm that a spoken request is spoken back, and that Escape stops the speech. Replies to typed requests are not spoken.
3. Type "explain this error" and read the result. Note whether it is a real explanation, a stated error, or the stub text.
4. Windows Settings, Privacy and security, Microphone must allow desktop apps. If the status line says `Mic denied`, fix that before the audience arrives.

### 1.7 Confirm the exact test command works (OFFLINE)

The pre-flight runs this. To run it by hand, from `demo-project`:

```powershell
powershell.exe -NoProfile -Command "npm.cmd test"
```

Expect `Tests  1 failed | 6 passed (7)`, the failing test in `tests/discount.test.ts`, and a non-zero exit code. A failing test is expected here. It is the demo.

Why PowerShell and not `npm test` directly: running `npm test` directly inside the Extension Development Host failed to start Vitest on the development machine, for a cause that was not found. The wrapper works. See `demo-project/README.md`. On macOS or Linux, set `kirosight.testCommand` to `npm test` in that folder's settings and check it in a terminal first.

### 1.8 Final pre-flight checklist

- [ ] Pre-flight script ran with no FAIL.
- [ ] Extension Development Host has `demo-project` as its only folder, and it is trusted.
- [ ] `src/cart.ts` is open and shows one error in Problems.
- [ ] The panel is open. The status line was read once.
- [ ] Backend connected (or you chose the offline-only demo).
- [ ] You know which of Bedrock, STT, TTS and the microphone are available today.
- [ ] Speaker volume and the screen reader speech rate are set, and the screen reader is running if you use one.
- [ ] A second terminal is ready to stop the backend for the recovery step (Part 3).
- [ ] A copy of the transcript expectations (Part 2) is within reach.

## Part 2: The demo sequence

Total about **9 minutes** with the live steps, **6 minutes** offline only. Times are estimates, not measurements. Rehearse and replace them.

Type each command in the Command field and press Enter, or say it with push-to-talk. The words are the same. The answer always appears in the Transcript first.

| # | Time | Step | Say or type | Expected | Label |
|---|---|---|---|---|---|
| 1 | 0:30 | Activate | Run `KiroSight: Activate` or press Ctrl+Alt+K | The panel opens with focus in the Command field. No keybinding is needed; the command palette works. | OFFLINE |
| 2 | 0:45 | Where am I | "where am I" | A sentence naming `src/cart.ts`, the line and column, and the enclosing function when the editor can name it. | OFFLINE |
| 3 | 0:45 | What errors | "what errors are there" | One line: `Error in src/cart.ts at line 15, in function formatReceiptLine: ` followed by the TypeScript message about `number` not assignable to `string`. The function name is missing if the editor's symbol provider is unavailable; then you get the file and line only. | OFFLINE |
| 4 | 0:30 | Go to the error | "go to the first error" | The cursor moves to line 15 in `cart.ts`. Check it in the editor. "next error" also works. | OFFLINE |
| 5 | 1:00 | Explain it | "explain this error" | With Bedrock: a short answer grounded in the file, line and message. Without it: a stated error (see Part 3). With the stub: the fixed stub text, which you must call out as not an explanation. | LIVE |
| 6 | 0:30 | Open a file | "open discount.ts" | Opens `src/discount.ts`, the only file with that name. | OFFLINE |
| 7 | 1:00 | Run tests, decline | "run my tests" then "decline" | A confirmation prompt names the exact command: `powershell.exe -NoProfile -Command "npm.cmd test"`. Nothing runs. After "decline" the request is discarded. | OFFLINE |
| 8 | 0:30 | Repeat the prompt | "run my tests" then "repeat" | The same prompt again. Still nothing has run. | OFFLINE |
| 9 | 1:00 | Run tests, confirm | "confirm" | The tests run once. Expect `Tests failed: 6 passed, 1 failed.` followed by `Failing tests:` and the failing test's name (a test in `tests/discount.test.ts`). | OFFLINE |
| 10 | 0:30 | Summarize | "summarize the test failures" | The stored result again, with the failing test named. A written failure summary also appears after the run when Bedrock answers. | OFFLINE (the written summary is LIVE) |
| 11 | 0:30 | Help | "help" | A list of the supported commands. | OFFLINE |

Notes for the presenter:

- **Why a failing test is the demo.** `loyaltyPrice(995)` is 895.5. `applyDiscount` rounds down to 895 and the test expects 896. It is deliberate. You are not showing a KiroSight failure.
- **Confirm and Decline are real buttons too.** After "run my tests", Tab reaches Confirm and Decline. Focus lands on the prompt text first, so a screen reader reads the prompt. After either answer, focus returns to the Command field.
- **KiroSight never runs the tests by itself.** The command comes from the trusted setting, not from anything the AI says. The model can only ask for "run the tests".
- **Speech.** Replies to requests made by voice are spoken after their text appears. Escape stops speech at once. Typed requests stay silent so they do not fight your screen reader.
- **Keyboard only.** Tab order with nothing pending: Transcript, Command field, Send, Push to talk. While a confirmation is pending: Transcript, Confirm, Decline, Command field, Send, Push to talk. Enter and Space press buttons. Run the whole sequence once without the mouse.
- **Screen reader.** Say plainly that KiroSight works alongside NVDA, JAWS or VoiceOver. The transcript is a normal log region they read themselves.

## Part 3: Recovery when something fails

Say what happened, in plain words, and carry on with the typed local commands. These are real behaviors, not slides.

### Backend stopped (BACKEND)

1. Stop the backend (Ctrl+C in its terminal).
2. Type "where am I", "what errors are there", "go to the first error", "run my tests". They all still work, because they never use the backend.
3. Type "explain this error". Expect the transcript to say that KiroSight can't reach the backend, so it can't explain that. Your draft is not lost.
4. Start the backend again. The status line reconnects.

### Bedrock unavailable, throttled, or no quota (LIVE)

The backend never falls back to another provider and never uses the stub after a Bedrock failure. It retries once, and only after a throttling error. What you will see is a stated message. The wording depends on the cause, for example:

- "The explanation couldn't be generated because the reasoning service failed." followed by the reason.
- For throttling, a reason that Amazon Bedrock is limiting requests and to try again shortly.

What to do on stage:

1. Say that the cloud reasoning step failed and show the stated error in the transcript.
2. Do **not** retry more than once. Repeated requests make throttling worse.
3. Continue with step 6 onward. They do not use Bedrock.
4. If you suspect quota in advance, rehearse with `KIROSIGHT_LLM` unset (the stub) and say clearly that it is the offline stub.

### Network failure

Treat it like Bedrock unavailable. Voice also fails if Deepgram cannot be reached. Type instead. The panel's STT and TTS notes say what is unavailable.

### Speech or microphone problem (LIVE)

- STT or the microphone unavailable: type the command. The text transcript is unaffected.
- TTS unavailable: read the transcript. A note says speech is unavailable.
- Press Escape if speech is playing and you want it to stop.

### The tests will not start

If the output says Vitest could not start, or no tests ran, that is not the demo. Check that the workspace is trusted and that `demo-project` is the first folder, then run the command from 1.7 by hand. If it still fails, skip the test steps and say so.

## Part 4: Ending and resetting the demo

### End

1. Press Escape to stop any speech.
2. Close the panel. Stop the backend (Ctrl+C in its terminal).
3. Close the Extension Development Host window and start a fresh one for the next run, so the Transcript starts empty. (Confirm at rehearsal that the new window's Transcript is empty.)
4. If you used a real credential, close the terminal that held it.

### Reset the demo project to its known initial state (OFFLINE)

The demo should leave `demo-project` unchanged, because KiroSight never edits files. If you changed it, from the repository root:

```powershell
git status --short -- demo-project
```

`git restore` can only reset files Git already tracks. List them first:

```powershell
git ls-files -- demo-project/src demo-project/tests demo-project/.vscode
```

- If that prints nothing, `demo-project` is not committed yet. Git has nothing to restore, so do not run `git restore`. Undo your edits by hand.
- If it lists files, restore only the files you changed, by the exact paths it printed. This throws away uncommitted edits to those files, so run it only if you mean to. Replace the example path with a path from the list:

```powershell
git restore -- demo-project/src/cart.ts
```

- Files that are new and untracked (a stray file you created) are not touched by `git restore`. Delete such a file by hand after checking `git status --short -- demo-project`. Do not use `git clean`.
- `node_modules/` is ignored by Git and is not part of the reset. Reinstall with `npm.cmd install` in `demo-project` if it is damaged.

Then run the pre-flight script. It confirms the single `TS2322` error in `src/cart.ts` and the `1 failed | 6 passed (7)` result.

Make sure no leftover test process is running:

```powershell
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, StartTime
```

Stop one only if you know it is a leftover from the demo.

## What was checked in the code

These were read in the code, not run live.

| Phrase or command | Where it is handled | Notes |
|---|---|---|
| `kirosight.activate` | Manifest command; keybinding Ctrl+Alt+K on Windows and Linux only | macOS has no default key. Use the palette. |
| "where am I" | Local router, `WHERE_AM_I` | Also "what file am I in". |
| "what errors are there" | Local router, `DESCRIBE_DIAGNOSTICS` | Output is `Severity in path at line N[, in kind name]: message`. |
| "go to the first error", "next error" | Local router, `GO_TO_DIAGNOSTIC` and `NEXT_DIAGNOSTIC` | "first", "second" and "third" are accepted. |
| "open discount.ts" | Local router, `OPEN_FILE` | Resolved inside the workspace. |
| "run my tests" | Local router, `RUN_TESTS` | Always asks first. Runs only `kirosight.testCommand`. |
| "confirm", "decline", "cancel", "repeat" | Confirmation flow | Confirmation prompt lists these four. |
| "summarize the test failures", "list all failures" | Local router | Uses the stored result. |
| "help", "what can you do" | Local router, `HELP` | Local; works with the backend stopped. |
| "explain this error" | Routed to the backend agent | Needs the backend. Needs Bedrock for a real explanation. |
| Escape | Webview | Stops speech and interrupts the pending request. |

Not part of this demo, because the MVP does not implement them: Git status questions, symbol navigation and code edits ("fix this error"). Do not promise them on stage. "What function am I in" works as a local command, but it depends on the editor's symbol provider, so it is left out of the sequence.

## What still needs live manual verification

- All LIVE steps: Deepgram speech recognition and speech output, the microphone, and a real Bedrock explanation. None has been run as part of writing this script.
- The timings in Part 2. They are estimates.
- The exact wording of the Bedrock throttling and network failure messages as they appear in the panel.
- The accessibility checklist in `docs/accessibility-checklist.md`, which is also still NOT TESTED.
- The demo as a whole, once, from `docs/demo-script.md` (Task 10.10).
