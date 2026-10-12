# KiroSight Technical Spike Results

## Spike A — Activation Command / Keybinding

- **Date:** 2026-10-05
- **Environment:** Kiro 1.2.4 on Windows; `en-US` keyboard layout (`0409:00000409`).
- **Scope:** Throwaway validation only. No production extension architecture or later milestone work was started.

### Activation command

- `kirosight.activate` **registered successfully** in an isolated Kiro Extension Development Host.
- The extension manifest contributes **KiroSight: Activate (Spike)** to the Command Palette.
- The command **ran successfully with no keybinding assigned**. Both the dependency-free smoke harness and the Kiro extension-host integration check passed.
- The stub displayed and returned: **“KiroSight activation spike works.”**

### Ctrl+Alt+K conflict check

- **Kiro and VS Code-compatible defaults:** No `Ctrl+Alt+K` binding was found in the installed Kiro 1.2.4 core output or built-in extension manifests (`0` exact matches).
- **Installed extensions:** The Kiro installed-extension registry contains `0` user-installed extensions, so no installed extension conflict was found. No separate VS Code installation/extensions directory was present.
- **User keybindings:** No Kiro user `keybindings.json` file was present.
- **Windows keyboard layout:** The machine uses the US English keyboard layout only. No non-US or AltGr layout was detected.
- **Temporary shortcut test:** The throwaway extension was temporarily bound to `Ctrl+Alt+K`. Sending the chord to an isolated Kiro Extension Development Host triggered `kirosight.activate` and produced the expected activation marker. The temporary binding and marker were removed after the check.
- **Conflict found:** No conflict or AltGr-related issue was found on this demo machine.

### Decision

Use `Ctrl+Alt+K` as the proposed Windows/Linux default for the hackathon demo. Keep `kirosight.activate` fully usable without a keybinding and user-rebindable. Define no macOS default. Re-run this machine-specific check if the keyboard layout or installed extensions change before the demo.

### Throwaway spike files

The disposable extension and validation harness are under `spikes/activation-command/`. They are not the production extension scaffold and may be removed or replaced when Task 1.2 begins.

## Spike B — Document Symbol Lookup

- **Date:** 2026-10-05
- **Language tested:** TypeScript (`typescript`).
- **Fixture used:** `spikes/document-symbol/fixture.ts`, containing the top-level `outerExample` function and `DemoCalculator.calculate` method. The known cursor position was line 2, column 5 inside `outerExample`.
- **API called:** `vscode.executeDocumentSymbolProvider` through a disposable isolated Kiro Extension Development Host. The harness opened and displayed the fixture, explicitly activated the built-in `vscode.typescript-language-features` extension when available, repeatedly queried the provider for approximately 1500 ms, and recursively flattened returned symbol children.
- **Symbols returned:** No symbols. The flattened symbol count was `0`.
- **Approximate response time:** `1553 ms` in the final built-ins-enabled attempt, exceeding the 1500 ms budget. Earlier isolated attempts also returned no symbols at approximately 1500 ms.
- **Expected enclosing symbol:** `outerExample`.
- **Actual enclosing symbol:** None (`null`).
- **Decision:** **FALLBACK.** The provider was unavailable or empty in the isolated Kiro spike environment and the known cursor position could not resolve to the expected function. KiroSight should use the planned `provider_unavailable` path: a bounded cursor-window excerpt with no symbol name. Do not implement that fallback in this spike. Do not spend additional time repairing the provider; TypeScript symbol lookup should be rechecked in the actual demo workspace before Milestone 2 if needed.

### Spike B disposable files

The fixture and harness are under `spikes/document-symbol/`. No production `extension/src/context/` or SymbolService code was added.

## Spike C — Trusted Test Command on Windows

- **Date:** 2026-10-06
- **Environment:** Windows 11 Pro, `os.release()` 10.0.26300, x64, `ComSpec` = `C:\WINDOWS\system32\cmd.exe`; Node `v24.14.1`.
- **Approach tested:** `child_process.spawn(command, { shell: true, cwd: <fixtures dir>, windowsHide: true })`, with `taskkill` invoked through `spawnSync('taskkill', args)`. Node built-ins only, no packages installed. The harness ran twice and gave the same results; the first run's PIDs are quoted below.
- **Scope:** Throwaway harness only (`spikes/trusted-test-command-windows/run.js` plus `fixtures/`). No `TestRunner` or other production code was written.

### A. Output and exit code capture (`node normal.js`)

- stdout `KIROSIGHT_STDOUT_OK` was captured on stdout only.
- stderr `KIROSIGHT_STDERR_OK` was captured on stderr only.
- Exit code `7` was captured via `close`. No `error` event, signal `null`.
- **Result: PASS.** A non-zero exit from a command that ran is plainly distinguishable from a command that never ran (see C).

### B. Process-tree kill (`node tree-parent.js`, 6 s spike timeout)

- Tree measured **before** the kill: root PID `336` = `cmd.exe` (the PID `child.pid` reports with `shell: true`); fixture parent `node.exe` PID `19396`; nested child `node.exe` PID `19668`. `taskkill` also reported one more child of the root, PID `27552`. It was not identified, because it was not inspected before the kill.
- Kill command: `taskkill /PID 336 /T /F` (arguments `['/PID','336','/T','/F']`). Exit status `0`. It reported all four processes terminated (nested child first, then the extra child, the fixture parent and the root).
- `close` fired about 2 ms after the kill (1 ms in the second run). Close reported exit code `1`, signal `null`, no spawn error.
- **Orphan check:** `tasklist /FI "PID eq <pid>" /FO CSV /NH` and `process.kill(pid, 0)` were both used for the root, the fixture parent and the nested child. After a bounded poll (100 ms interval, 3 s cap; about 411 ms needed in the first run) all three were gone by both methods. Both methods agreed.
- **Result: PASS.** `/T /F` on the `shell:true` root killed the whole tree, including the grandchild, with no orphan.
- The kill targeted only PIDs the spike created. A `finally` cleanup killed any leftover known PID and never used `/IM`. It found none.

### C. Missing executable (`kirosight_definitely_missing_executable_5_1`, same `shell:true` path)

| Case | `error` event | `exit`/`close` | exit code | stdout | stderr |
|---|---|---|---|---|---|
| missing executable | **no** | both fire | `1` | empty | `'…' is not recognized as an internal or external command, operable program or batch file.` |
| missing executable with args | **no** | both fire | `1` | empty | same message |
| executed, exits 7 (`node normal.js`) | no | both fire | `7` | marker | marker |
| executed, missing script (`node definitely_missing_script_5_1.js`) | no | both fire | `1` | empty | Node loader stack trace |
| executed, prints the "not recognized" wording itself (`node decoy.js`) | no | both fire | `1` | empty | same message as the missing case |

Findings:

- With `shell: true`, `spawn` succeeds because `cmd.exe` itself starts. **A missing executable never emits `error`**, so a `spawn`-error rule alone can never detect it.
- The exit code for a missing executable is `1`, not `9009`. It is the same code a failing test run commonly returns, so the exit code cannot distinguish the two cases.
- The only signal is the English `cmd.exe` message on stderr. It is not locale-independent, and this machine's locale is the only one measured. Another Windows display language would produce different wording.
- A process that did execute and prints the same wording, exits 1 and prints nothing to stdout (the decoy case) is indistinguishable from a missing command. The rule can therefore misclassify an executed process in that contrived case.
- A non-zero exit with stdout output, or with stderr that lacks the signature, was never confused with a missing command here.
- Pre-flight `where <first token>` gave status `0` for `node`, `npm` and `npx`, and `1` for the missing command. It also gave `1` for the `cmd.exe` builtins `echo` and `dir`, so it cannot be a hard gate, only a hint.

### Result: **PASS for capture and process-tree kill. FALLBACK for the `did_not_execute` rule (heuristic only).**

- stdout, stderr, exit code and `close` capture all work under `shell: true`.
- `taskkill /PID <child.pid> /T /F` kills the full tree and leaves no orphan.
- `did_not_execute` can be classified only heuristically. It is not a robust contract.

### Decision for Task 5.12

- Use `spawn(command, { shell: true, cwd, windowsHide: true })` with the trusted configured string. Buffer stdout and stderr and use the `close` event's exit code. Do not rely on `exit` alone.
- On timeout or `interrupt()`, kill the tree with `taskkill /PID <child.pid> /T /F` (via `spawn`/`spawnSync` with an argument array, never through a shell string). Wait for `close`, then treat the run as `timed_out` or `cancelled`. `close` arrives within a few milliseconds of a successful kill, but allow a bounded wait (the orphan check needed about 0.4 s to settle).
- Classify `did_not_execute` when either:
  1. `spawn` emits `error` (for example `ENOENT` from a bad `cwd`), or
  2. the exit code is `1`, stdout is empty, and stderr consists only of the `cmd.exe` "is not recognized as an internal or external command" message.
- Treat any other non-zero exit as an executed run (`failed` or `completed_unparsed`). Never treat every non-zero exit as `did_not_execute`.
- Known limitations to keep in the design notes and wording: rule 2 depends on English-language `cmd.exe` output, and a process that prints the same wording itself would be misreported. Word the user message cautiously (for example "the test command could not be started: command not recognized") and always point to the `KiroSight Tests` output channel for the raw output.
- Optional hint, not a gate: a `where <first token>` pre-flight can strengthen the message when it fails, but must not block the run, because builtins such as `echo` return a failing `where` status.

### Spike C disposable files

The harness and fixtures are under `spikes/trusted-test-command-windows/` (`run.js`, `fixtures/normal.js`, `fixtures/decoy.js`, `fixtures/tree-parent.js`, `fixtures/tree-child.js`). Run with `node run.js` from that folder. No generated output or PID files are kept.
