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
