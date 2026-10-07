# Implementation Plan: KiroSight MVP

## Overview

This plan implements KiroSight in the ten approved milestones from the design's "Recommended Implementation Order". The implementation languages are fixed by the design: **TypeScript** (strict mode, Vitest + fast-check) for the extension and **Python** (FastAPI, Pydantic v2, pytest + hypothesis) for the backend.

Milestones 1 to 5 are extension-only and need no Python, WebSocket, Bedrock or Deepgram. Voice (Milestones 8 and 9) is layered on an already working typed-text pipeline, and a voice failure never blocks typed commands or the deterministic local features.

Early Technical Spikes A to E are explicit, time-boxed tasks. Each spike writes throwaway code only, must NOT implement the full feature, and records its outcome in `docs/spike-results.md`:

- Spike A: task 1.1 (first task of Milestone 1)
- Spike B: task 2.1 (first task of Milestone 2)
- Spike C: task 5.1 (first task of Milestone 5, before TestRunner work)
- Spike E: task 7.1 (first task of Milestone 7)
- Spike D: task 8.1 (first task of Milestone 8)

Spikes D and E can be done in parallel and early, if time allows, by running tasks 8.1 and 7.1 ahead of their milestones. Their results are recorded in `docs/spike-results.md`, and they gate only the design choices of Milestones 7 and 8.

Scope guardrails taken from the approved spec:

- The allow-list is exactly `NO_ACTION`, `GO_TO_DIAGNOSTIC`, `NEXT_DIAGNOSTIC`, `PREVIOUS_DIAGNOSTIC`, `OPEN_FILE`, `GO_TO_LINE`, `FOCUS_EDITOR` and `RUN_TESTS`. No task adds `GO_TO_SYMBOL`, `RUN_COMMAND` or any symbol navigation. `SymbolService` exists only to describe the current symbol, read the current function and supply explanation context.
- Requirement 3 (Git status) is Stretch and has no tasks.
- Only the extension host executes actions. Secrets never appear in the webview or the extension source.
- Checkpoint sub-tasks close each milestone. Each milestone's last-but-one sub-task wires its pieces together.

## Tasks

- [x] 1. Milestone 1: Working extension and activation command
  - Scaffold the monorepo and ship an extension whose `kirosight.activate` command works from the command palette with no keybinding at all.
  - Spikes D (task 8.1) and E (task 7.1) can be done in parallel early if time allows. Their results are recorded in `docs/spike-results.md`.
  - _Requirements: 9.7, 9.8, 9.9, 9.10, 17.3, 18.5_

  - [x] 1.1 Spike A: activation command and keybinding conflict check (time box: 30 minutes)
    - Create `docs/spike-results.md` with a section per spike (A to E). Write a throwaway stub extension with a `kirosight.activate` command.
    - Pass criterion: the stub command is listed in the command palette and runs with no keybinding assigned. On the demo machine, the Keyboard Shortcuts editor search for `Ctrl+Alt+K` and "Developer: Inspect Key Mappings" show no other command bound to `Ctrl+Alt+K`, in the default Kiro/VS Code keybindings or in any installed extension. With the stub bound to `Ctrl+Alt+K`, the demo keyboard layout and screen reader active, the chord triggers it.
    - Fallback decision: if any conflict or AltGr problem exists, ship no default keybinding on any platform. The command stays primary. No macOS default is added either way.
    - Must NOT implement the real activation feature. The stub is discarded or rewritten in task 1.4.
    - Record the outcome (conflict found or not, machine, keyboard layout) in `docs/spike-results.md`. Spikes D and E can also be run early and in parallel if time allows (see tasks 8.1 and 7.1).
    - _Requirements: 9.7, 9.8, 9.9, 9.10_

  - [x] 1.2 Scaffold the monorepo (extension workspace, tooling and repository hygiene)
    - Create the `extension/` workspace with `package.json` (exact pinned dependency versions), `tsconfig.json` with `"strict": true`, `vitest.config.ts`, and dev dependencies for Vitest, fast-check, `zod` and the VS Code type definitions. Add build, test (`vitest --run`) and lint scripts. Leave the `backend/` directory for Milestone 6 and the `media/` directory for Milestone 4.
    - Create a root `.gitignore` excluding `.env` files, `node_modules`, Python virtual environments, `__pycache__`, and build output directories.
    - Create `.env.example` listing every planned variable name with no values (`KIROSIGHT_HOST`, `KIROSIGHT_PORT`, `KIROSIGHT_AUTH_TOKEN`, `DEEPGRAM_API_KEY`, `DEEPGRAM_STT_MODEL`, `DEEPGRAM_TTS_MODEL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `BEDROCK_MODEL_ID`) and a first version of `docs/env-vars.md` describing each one.
    - _Requirements: 17.1, 17.3, 17.4_

  - [x] 1.3 Add shared utility modules
    - Implement `util/result.ts` (a small `Result<T, E>` type), `util/redact.ts` (replaces common key, token and secret patterns and any supplied secret values) and `util/logger.ts` (a logger that applies `redact()` to every line and never logs credentials, audio or file contents).
    - _Requirements: 17.6_

  - [x] 1.4 Implement the activation command and extension entry point
    - Implement `extension.ts` (`activate()`) and `commands/registerCommands.ts` (thin command-to-handler glue). Register `kirosight.activate` in the manifest as a palette command. For now it writes a short text confirmation to a KiroSight `OutputChannel`. It must complete successfully regardless of any other state.
    - Manifest keybinding: include `ctrl+alt+k` for Windows and Linux only, and only if the Spike A result (task 1.1) recorded no conflict. If a conflict was recorded, ship no default keybinding on any platform. Define no macOS keybinding under any outcome.
    - _Requirements: 9.7, 9.8, 9.9, 9.10, 18.1, 18.5_

  - [x]* 1.5 Write unit tests for the manifest, activation and redaction
    - Assert the manifest declares `kirosight.activate`, that it has no macOS keybinding, and that a default keybinding is present if and only if `docs/spike-results.md` records no Spike A conflict (and when present, is `ctrl+alt+k` for Windows and Linux only).
    - Assert the activation handler resolves without error with no keybinding configured. Assert `redact()` removes supplied secret values and common token patterns.
    - _Requirements: 9.7, 9.8, 9.9, 9.10, 17.6_

  - [x] 1.6 Wire and verify the scaffold end to end
    - Make sure the extension entry point registers the commands from `registerCommands.ts`. Add a `.vscode/launch.json` for running the extension and confirm the build and `vitest --run` scripts pass on the scaffold.
    - _Requirements: 9.7, 18.5_

  - [x] 1.7 Checkpoint - Ensure all tests pass, ask the user if questions arise.
    - Demo check: run `KiroSight: Activate` from the command palette with no keybinding and read the text confirmation in the output channel.

- [x] 2. Milestone 2: Structured IDE context and local text description
  - Extension-only. Describe the current file, cursor, selection and enclosing symbol as text. There is no Python, WebSocket, Bedrock or Deepgram in this milestone, and no webview yet.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 12.1, 12.2_

  - [x] 2.1 Spike B: document symbol lookup with the demo language (time box: 45 minutes)
    - Write throwaway code that calls `vscode.executeDocumentSymbolProvider` on a fixture file in the demo language and project.
    - Pass criterion: the call returns a symbol tree within the 1500 ms budget, and an enclosing-symbol lookup can name the function at a known cursor position.
    - Fallback decision: switch the demo to a language with a reliable provider (for example TypeScript), or accept the `provider_unavailable` path (cursor-window excerpt, no symbol name) for that language.
    - Must NOT implement the real `SymbolService`. Record the outcome in `docs/spike-results.md`.
    - _Requirements: 1.3, 1.4_

  - [x] 2.2 Define context data types and the editor adapter seam
    - Create `context/editorAdapter.ts` with the `EditorAdapter` and `EditorSnapshot` interfaces and the `Pos`, `IDEContext`, `CodeExcerpt`, `DiagnosticInfo`, `RawDiagnostic` and `SymbolQueryResult` types from the design. Implement `VscodeEditorAdapter` as the only class in the context layer that imports `vscode`.
    - All positions are 1-indexed. An in-memory fake adapter is used by tests.
    - _Requirements: 1.1, 1.2, 1.5_

  - [x] 2.3 Implement SymbolService (internal use only)
    - Implement `context/symbolService.ts`: call the document symbol provider through the adapter, flatten results to `SymbolNode[]`, and implement a pure `findEnclosingSymbol(nodes, pos)` returning the innermost match (name and kind). Retry once within a 1500 ms total budget and otherwise return `provider_unavailable`. Never guess a symbol by text heuristics.
    - This service only describes code and never moves the cursor. No symbol navigation is built from it.
    - _Requirements: 1.3, 1.4, 1.5_

  - [x]* 2.4 Write property test for enclosing symbol lookup
    - **Property 14: Enclosing symbol lookup returns the innermost container**
    - **Validates: Requirements 1.3, 1.4**

  - [x] 2.5 Implement the context-window strategy
    - Implement `context/contextWindow.ts` with `selectExcerpt(...)` and the documented constants (`MAX_EXCERPT_LINES`, `MAX_EXCERPT_CHARS`, `CURSOR_WINDOW_RADIUS`, `DIAGNOSTIC_WINDOW_RADIUS`, `MAX_DIAGNOSTICS_SENT`, `MAX_DIAGNOSTIC_MESSAGE_CHARS`). Precedence is selection, then enclosing symbol, then cursor window. Oversized ranges are cut around an anchor line, which is retained, and `truncated` is set.
    - _Requirements: 12.1, 12.2_

  - [x]* 2.6 Write property test for the context excerpt
    - **Property 13: Context excerpt is bounded and follows the precedence rule**
    - **Validates: Requirements 12.1, 12.2**

  - [x] 2.7 Implement ContextService and the wire-form converter
    - Implement `context/contextService.ts` to build an `IDEContext` from the adapter, `SymbolService` and `contextWindow` (file, cursor, selection or an explicit no-selection state, enclosing symbol and `symbolStatus`, bounded `nearbyCode`). The diagnostics fields are left empty here and are filled in task 3.1.
    - Implement `toWireContext()`, which removes the absolute path and every other absolute path. When no text editor is active, report that no file is open rather than returning an empty or malformed result.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 12.1, 12.2_

  - [x] 2.8 Implement ContextFormatter for editor context
    - Implement `context/contextFormatter.ts`: `formatWhereAmI` (relative path, 1-indexed line and column, selection start and end or an explicit "nothing selected", enclosing symbol or an explicit "no enclosing symbol found"), `formatCurrentSymbol` and `formatSelection` (bounded). A missing editor yields "No file is open."
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x]* 2.9 Write property test for the editor context report
    - **Property 19: Editor context report is complete**
    - **Validates: Requirements 1.1, 1.2**

  - [x] 2.10 Implement ResponseSink
    - Implement `response/responseSink.ts`: an interface plus an implementation that writes to the KiroSight `OutputChannel` and shows a notification. Later milestones add the Transcript as another sink without changing callers.
    - _Requirements: 1.5_

  - [x]* 2.11 Write example tests for ContextService and ResponseSink
    - With the fake adapter: no active editor, non-empty and empty selection, cursor outside any symbol, symbol provider unavailable, and large files (the excerpt bound holds). Assert the sink receives the formatted text.
    - _Requirements: 1.1, 1.2, 1.4, 1.5_

  - [x] 2.12 Wire the Milestone 2 command path
    - In `extension.ts`, construct the adapter, `SymbolService`, `ContextService`, `ContextFormatter` and `ResponseSink`. Register `kirosight.whereAmI`, which prints the formatted description to the sink. Route the activation confirmation from task 1.4 through the sink.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 2.13 Checkpoint - Ensure all tests pass, ask the user if questions arise.
    - Demo check: run `KiroSight: Where Am I` and read "You're editing src/login.ts at line 32, column 5, in function validateLogin." in the output channel, and check the no-file-open case.

- [ ] 3. Milestone 3: Diagnostics and deterministic navigation
  - Extension-only. Diagnostics reporting, the allow-list registry, the validator and executor for the navigation actions, and the pure local intent router. There is no symbol navigation and no `RUN_COMMAND`.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 5.1, 5.2, 5.3, 5.5, 5.6, 5.7, 5.8_

  - [x] 3.1 Implement DiagnosticsService
    - Implement `context/diagnosticsService.ts` using `vscode.languages.getDiagnostics` through the adapter: map raw diagnostics to `DiagnosticInfo`, filter by scope (workspace or current file), and provide `compareForReport` (severity, then path, then line) and `compareForNavigation` (path, then line, with a stable sort keeping the reported order for identical path and line). Report "no file is open" for a file-scope request with no editor, and "no diagnostics found" for an empty result.
    - Fill the diagnostics fields of `IDEContext` in `ContextService` (capped at `MAX_DIAGNOSTICS_SENT`, with full counts).
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x]* 3.2 Write property test for diagnostics scoping and ordering
    - **Property 15: Diagnostics are scoped and ordered as specified**
    - **Validates: Requirements 2.1, 2.2**

  - [x] 3.3 Implement diagnostics formatting
    - Extend `context/contextFormatter.ts` with diagnostic reports that include file name, line and the enclosing symbol name only when one is known (looked up through `SymbolService`), state "no diagnostics found" for an empty list, and state "no file is open" when appropriate.
    - _Requirements: 2.3, 2.4, 16.1, 16.2_

  - [x]* 3.4 Write property test for concrete diagnostic reports
    - **Property 20: Diagnostic reports are concrete**
    - **Validates: Requirements 2.4, 16.1, 16.2**

  - [x] 3.5 Implement the action types, extension-side allow-list and ActionValidator
    - Implement `actions/actionTypes.ts` (the `Action` union with exactly the eight actions) and `actions/allowlist.ts` (`ALLOWLIST: Record<Action['type'], { risk }>` with `RUN_TESTS` as `needs-confirmation` and everything else `safe`). Commit the shared parity fixture `protocol/fixtures/allowlist.json` (action name, risk, parameter names).
    - Implement `actions/actionValidator.ts`: exact case-sensitive `type` match, strict per-action parameter schemas (zod) with bounds, rejection of unknown and extra properties (`command`, `cmd`, `shell`, `args`), identical behavior for local and agent origins, and the registry risk class returned on success. Names such as `GO_TO_SYMBOL` and `RUN_COMMAND` return `UNKNOWN_ACTION`.
    - _Requirements: 4.8, 5.1, 5.2, 5.3, 5.5, 5.6, 5.7, 5.8_

  - [x]* 3.6 Write property test for action validation
    - **Property 1: Only allow-listed, well-formed actions validate**
    - **Validates: Requirements 4.8, 5.1, 5.2, 5.3, 5.5, 5.6, 5.7, 5.8**

  - [x] 3.7 Implement diagnostic navigation logic
    - Implement `navigation/diagnosticNavigation.ts` as pure functions: resolve a 0-based `index` (from the 1-based user ordinal) against the candidate list filtered by severity and ordered with `compareForNavigation`; `next` and `previous` relative to the cursor, strictly after or before it, wrapping at the ends and saying so.
    - _Requirements: 4.4, 4.5_

  - [x]* 3.8 Write property test for next and previous navigation
    - **Property 29: Next and previous diagnostics wrap and invert**
    - **Validates: Requirements 4.4**

  - [x]* 3.9 Write property test for ordinal diagnostic navigation
    - **Property 16: Diagnostic ordinal navigation follows path/line order**
    - **Validates: Requirements 4.4, 4.5**

  - [x] 3.10 Implement FileService
    - Implement `navigation/fileService.ts`: `resolve(nameOrPath)` returns not-found, exactly one match, or an ambiguity result listing up to 10 workspace-relative paths plus the total count. It never picks one of several matches.
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ]* 3.11 Write property test for file resolution
    - **Property 17: File resolution opens only unambiguous matches**
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [ ] 3.12 Implement NavigationService
    - Implement `navigation/navigationService.ts`: reveal a file and position, open a file, focus the editor, and `goToLine` with pure bounds validation (an editor must be active and the line must be an integer from 1 to the last line). The cursor moves to the start of the line. Every failure leaves the cursor and active editor unchanged.
    - _Requirements: 4.4, 4.6, 4.7_

  - [ ]* 3.13 Write property test for go-to-line validity
    - **Property 18: Go-to-line validity**
    - **Validates: Requirements 4.6, 4.7**

  - [ ] 3.14 Implement ActionExecutor and ActionResult
    - Implement `actions/actionResult.ts` (the `ActionResult` type) and `actions/actionExecutor.ts` with a compiler-enforced handler map, one named handler per action: `NO_ACTION`, `GO_TO_DIAGNOSTIC`, `NEXT_DIAGNOSTIC`, `PREVIOUS_DIAGNOSTIC`, `OPEN_FILE`, `GO_TO_LINE` and `FOCUS_EDITOR`. No code path passes a string to `vscode.commands.executeCommand`.
    - The `RUN_TESTS` handler is a placeholder returning a `failed` result ("test running is not available yet") and is replaced by the real handler in task 5.14.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [ ] 3.15 Implement ResponseFormatter for action results
    - Implement `response/responseFormatter.ts` with `formatActionResult`: concrete outcomes for success (opened path, reached file and line, severity and message) and the specific reason for failures, clarification requests and declines.
    - _Requirements: 16.5, 16.6_

  - [ ]* 3.16 Write property test for concrete action results
    - **Property 21: Action results state a concrete outcome or reason**
    - **Validates: Requirements 16.5, 16.6**

  - [ ] 3.17 Implement the LocalIntentRouter
    - Implement `intent/normalize.ts`, `intent/intentTypes.ts` and `intent/localIntentRouter.ts`: a pure, synchronous `route(utterance)` with normalization (case, punctuation, whitespace, filler words, number words), an anchored rule table and the exactly-one-match rule. Rules: where am I, current function, read selection, errors in the workspace or file, next and previous error, go to the first, second, third error, go to line N, open NAME, focus editor, run tests, summarize test failures and help.
    - Semantic phrases and anything unmatched or ambiguous route to the agent. There is no symbol-navigation rule, so "go to function foo" routes to the agent as `unrecognized`. Every produced action must pass `validateAction`.
    - _Requirements: 1.1, 4.4, 4.6, 7.1, 8.2_

  - [ ]* 3.18 Write property test for the local router
    - **Property 10: Local router is deterministic and conservative**
    - **Validates: Requirements 1.1, 4.4, 4.6, 7.1, 8.2**

  - [ ] 3.19 Implement the local intent handler
    - Implement `pipeline/localIntentHandler.ts`: run a `LocalIntent` by calling `ContextService`, `DiagnosticsService`, `validateAction` and `ActionExecutor`, then format the result with `ContextFormatter` and `ResponseFormatter`. Returns display text. Agent-routed results return a "reasoning is not connected yet" message (replaced in Milestone 6).
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 4.1, 4.4, 4.6, 16.5, 16.6_

  - [ ] 3.20 Wire the Milestone 3 commands
    - Register `kirosight.describeErrors`, `kirosight.nextError`, `kirosight.previousError`, and `kirosight.ask` (an input-box command that sends typed text through the router and the local handler to the sink). Construct all services in `extension.ts`. The webview replaces the input box in Milestone 4.
    - _Requirements: 2.1, 2.2, 4.4, 8.2_

  - [ ] 3.21 Checkpoint - Ensure all tests pass, ask the user if questions arise.
    - Demo check: use `KiroSight: Ask` to run "what errors are there", "go to the first error", "open auth.ts" and "go to line 40", and read the concrete text result of each.

- [ ] 4. Milestone 4: Accessible webview and typed command pipeline
  - Extension-only. One `InputPipeline` for all text input, an append-only transcript, a plain HTML/CSS/JS webview panel, and a closed, validated bridge between the webview and the extension host. Confirm and Decline controls are rendered but stay hidden until Milestone 5 supplies a pending confirmation.
  - _Requirements: 8.1, 8.3, 8.4, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 15.1, 15.2, 15.4, 19.1, 19.3, 19.4, 19.10_

  - [ ] 4.1 Implement TranscriptStore
    - Implement `transcript/transcriptStore.ts`: append-only entries with strictly increasing `seq`, roles (`user`, `kirosight`, `system`) and an optional `source` (`typed` or `voice`). Earlier entries are never changed.
    - _Requirements: 15.1, 15.2_

  - [ ]* 4.2 Write property test for the transcript
    - **Property 24: Transcript is append-only and ordered**
    - **Validates: Requirements 15.1, 15.2**

  - [ ] 4.3 Implement the view model
    - Implement `webview/viewModel.ts`: status kinds (idle, listening, processing, speaking, error, confirmation pending, voice unavailable) each with a non-empty text label, the voice state and reason text, the pending-confirmation field (empty for now), the latest response and the transcript.
    - The view model never carries the input draft and never contains credentials or tokens.
    - _Requirements: 10.3, 14.3, 15.4_

  - [ ]* 4.4 Write property test for status labels
    - **Property 25: Every state has a text label**
    - **Validates: Requirements 10.3, 14.3**

  - [ ] 4.5 Implement the webview bridge messages and validators
    - Implement `protocol/bridgeMessages.ts` with zod validators for the closed webview-to-host set (`ready`, `submit_text`, `ptt_toggle`, `audio_clip`, `mic_state`, `confirm`, `decline`, `interrupt`, `playback`) and the host-to-webview set (`view_state`, `submit_ack`, `backend_unavailable`, `transcript_append`, `start_capture`, `stop_capture`, `play_audio`, `stop_audio`). No host-to-webview message type may carry a credential or token field. Only message definitions and validators are built here. The voice and playback messages are used in Milestones 8 and 9.
    - _Requirements: 19.1, 19.3, 19.4, 19.10_

  - [ ] 4.6 Implement the InputPipeline
    - Implement `pipeline/inputPipeline.ts` and `pipeline/requestTracker.ts`. `handle(text, source)` discards empty or whitespace-only text (no transcript entry, nothing routed), appends the user entry, routes with `LocalIntentRouter`, runs local intents through the local intent handler, and for agent routes calls an injectable `AgentGateway` interface (a stub reporting that reasoning is not connected until Milestone 6). It appends the response, updates status and returns a `submit_ack` status (`handled`, `not_handled` or `discarded`). `source` affects only presentation, never routing.
    - Expose an injectable interceptor hook for pending-confirmation replies (unused until Milestone 5) and the `confirm()`, `decline()` and `interrupt()` entry points.
    - _Requirements: 8.1, 8.2, 8.4, 15.1, 15.2_

  - [ ]* 4.7 Write property test for whitespace-only input
    - **Property 12: Whitespace-only input is discarded**
    - **Validates: Requirements 8.4**

  - [ ] 4.8 Implement the webview HTML and styles
    - Implement `webview/html.ts` (per-load nonce and CSP `default-src 'none'; style-src ${cspSource}; script-src 'nonce-...'; media-src blob: data:` with no `connect-src`) and `media/styles.css`. The markup follows the design: heading, status (`role="status"`), transcript (`role="log"`, one live announcer), a static latest-response block, a hidden confirmation section with Confirm and Decline buttons, a command form with Send, and the push-to-talk button with `aria-pressed`, `aria-disabled` and a visible note. DOM order equals visual order equals Tab order.
    - Focus indicator: a 3 px outline using the theme focus color with a fallback. State is never conveyed by color alone.
    - _Requirements: 6.2, 8.3, 10.3, 14.1, 14.2, 14.3, 14.4, 14.5, 15.4, 19.3, 19.4_

  - [ ] 4.9 Implement the webview script
    - Implement `media/main.js` (plain JavaScript, thin DOM wiring only): post `ready` and `submit_text` through `postMessage`; render `view_state`; clear the input only on `submit_ack` with status `handled`; show `backend_unavailable` text while keeping the draft; keep the push-to-talk button focusable with `aria-disabled="true"` and reason text when voice is unavailable; handle Enter and Space on buttons and Escape for `interrupt`; never capture arrow keys or screen reader shortcuts. The input accepts at least 1,000 characters.
    - _Requirements: 8.3, 10.1, 10.3, 14.1, 14.5, 14.6, 19.3, 19.9_

  - [ ] 4.10 Implement the webview provider
    - Implement `webview/webviewProvider.ts` (`retainContextWhenHidden`). Validate every incoming message with the bridge validators and discard any message whose `type` is not in the defined set without acting on it or relaying it. Re-send the full view model on `ready`. Route `submit_text` to the `InputPipeline` and reply with `submit_ack`. Forward `confirm`, `decline` and `interrupt` to the pipeline. Make `kirosight.activate` open or focus the panel, place focus in the command input, and record in the transcript that voice is unavailable until Milestone 8.
    - _Requirements: 9.7, 18.1, 18.4, 18.5, 19.3, 19.10_

  - [ ]* 4.11 Write property test for credential-free host messages
    - **Property 30: Host-to-webview messages carry no credentials**
    - **Validates: Requirements 19.4, 19.8**

  - [ ]* 4.12 Write property test for unknown webview messages
    - **Property 31: Unknown webview messages are discarded**
    - **Validates: Requirements 19.10**

  - [ ]* 4.13 Write webview structure tests
    - Add jsdom (exact pinned version) and test: DOM order equals the expected Tab order, landmarks and labels exist, exactly one live announcer for transcript entries, the CSP string has no `connect-src`, no credential patterns appear in `media/` or the generated HTML, the input draft is kept until `submit_ack` is `handled`, and the push-to-talk control stays in the Tab order with `aria-disabled` and no `disabled` attribute.
    - _Requirements: 8.3, 10.3, 14.1, 14.3, 14.4, 15.4, 19.3, 19.4_

  - [ ] 4.14 Wire the panel and pipeline together
    - In `extension.ts`, construct `TranscriptStore`, view model, `InputPipeline` and `WebviewProvider`. Make `kirosight.ask`, `whereAmI` and the other commands go through the pipeline so that the transcript records their query and response. Make `kirosight.activate` open and focus the panel. The status label and the transcript update the webview within 500 ms of a state change.
    - _Requirements: 8.1, 14.3, 15.1, 15.2, 15.4, 18.1, 18.5_

  - [ ] 4.15 Checkpoint - Ensure all tests pass, ask the user if questions arise.
    - Demo check: type the Milestone 2 and 3 commands into the panel, read the persistent transcript, and operate everything by keyboard alone.

- [ ] 5. Milestone 5: Confirmation flow and trusted RUN_TESTS
  - Extension-only. The four-intent confirmation state machine, the registry-based gate, and a `RUN_TESTS` handler that spawns only the trusted `kirosight.testCommand`.
  - _Requirements: 5.4, 5.7, 5.9, 5.10, 5.11, 6.1, 6.2, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 7.1, 7.2, 7.3, 7.4, 7.6, 7.7, 7.8_

  - [ ] 5.1 Spike C: trusted test command on Windows (time box: 60 minutes)
    - Write throwaway code that runs a fixture command (for example `npm test` in a tiny fixture project) with `child_process.spawn` and `shell: true`.
    - Pass criterion: stdout, stderr and the exit code are captured. A long-running fixture is killed with `taskkill /T /F` and leaves no orphan process. A missing-executable command is reported as `did_not_execute`.
    - Fallback decision: use a direct executable plus arguments without `shell: true`, a shorter timeout, or demo with one known runner, and record the parser scope that is actually feasible.
    - Must NOT implement the real `TestRunner`. Record the outcome in `docs/spike-results.md`.
    - _Requirements: 7.2, 7.7, 7.8_

  - [ ] 5.2 Implement confirmation prompt and re-prompt formatting
    - Extend `response/responseFormatter.ts` with `formatConfirmation(action, target)` (contains the action name, the concrete target such as the exact test command, and the accepted replies) and `formatConfirmationReprompt(action)` (at most 30 words, naming the pending action and listing the accepted replies).
    - _Requirements: 6.1, 6.3, 6.6_

  - [ ]* 5.3 Write property test for concrete confirmation prompts
    - **Property 4: Confirmation prompts and re-prompts are concrete**
    - **Validates: Requirements 6.1, 6.6**

  - [ ] 5.4 Implement replyClassifier and ConfirmationManager
    - Implement `confirmation/replyClassifier.ts` (whole-utterance matching only, returning `confirm`, `decline`, `cancel`, `repeat` or `unrecognized`) and `confirmation/confirmationManager.ts`: at most one pending action, a FIFO hold queue presented in the order received, no timer and no expiry, CANCEL behaving exactly like DECLINE, REPEAT_CONFIRMATION re-reading the stored prompt without changing state or queue order, and the concise re-prompt for any other input. An affirmative with nothing pending has no effect and is not stored. The manager stores the resolved target at request time and re-prompts if the test command changes while pending. It records the origin and correlation id of each request.
    - _Requirements: 5.4, 6.1, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10_

  - [ ]* 5.5 Write property test for the confirmation state machine
    - **Property 3: Confirmation state machine**
    - **Validates: Requirements 5.4, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10**

  - [ ] 5.6 Implement the ActionGate
    - Implement `confirmation/actionGate.ts`: decide from the registry risk class (never from the agent flag) whether to execute at once or request confirmation. A `needs-confirmation` action is always confirmed. A `safe` action is confirmed only when `confirmationRequired` is true. Execute exactly once on CONFIRM, never on decline, cancel or dismissal, and return a `declined` `ActionResult` with the reason. Expose the origin and correlation id so Milestone 7 can report back to the backend.
    - _Requirements: 5.2, 5.3, 5.4, 5.9, 5.10, 7.1_

  - [ ]* 5.7 Write property test for registry-gated execution
    - **Property 2: Execution is gated by registry risk**
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.9, 5.10, 7.1**

  - [ ] 5.8 Implement testCommandConfig and the manifest settings
    - Implement `testing/testCommandConfig.ts` (`read()` returns the trimmed value of `kirosight.testCommand` and takes no parameters). Contribute `kirosight.testCommand` and `kirosight.testTimeoutSeconds` (default 300) in the manifest, and list `kirosight.testCommand` (and `kirosight.backendCommand`) under `capabilities.untrustedWorkspaces.restrictedConfigurations`.
    - _Requirements: 5.7, 5.11, 7.2, 7.6_

  - [ ] 5.9 Implement TestOutputParser
    - Implement `testing/testOutputParser.ts` as pure functions with the `TestRunSummary` and `FailingTest` types: strip ANSI codes, best-effort extractors for Jest, Vitest, pytest and Mocha, and a generic fallback. Report counts, the true failed total and at most 20 failing names with excerpts capped at 300 characters and passed through `redact()`. Unrecognized output gives `completed_unparsed` with the exit code only and no invented counts.
    - _Requirements: 7.3, 7.4, 7.7_

  - [ ] 5.10 Implement test result formatting
    - Extend `response/responseFormatter.ts` with `formatTestResult`: pass and fail counts, at most 5 failing names, and when more than 5 fail, the total plus a path to the rest (the full list and the `KiroSight Tests` output). Distinct messages for `did_not_execute`, `timed_out`, `cancelled`, `completed_unparsed` and `not_configured` (with how to set `kirosight.testCommand`).
    - _Requirements: 7.3, 7.4, 7.6, 7.7, 16.3, 16.4_

  - [ ]* 5.11 Write property test for bounded test summaries
    - **Property 6: Test summaries are bounded and faithful**
    - **Validates: Requirements 7.3, 7.4, 16.3, 16.4**

  - [ ] 5.12 Implement TestRunner
    - Implement `testing/testRunner.ts` with an injectable process spawner: run `spawn(command, { shell: true, cwd: first workspace folder, windowsHide: true })` using only the value from `testCommandConfig`; merge stdout and stderr into a bounded head-and-tail buffer (256 KB); apply the timeout and `interrupt()` with a process-tree kill; allow one run at a time; write the full output to a `KiroSight Tests` output channel; return `not_configured` without spawning when the setting is empty. Apply the Spike C outcome (task 5.1).
    - No VS Code Test Explorer API is used.
    - _Requirements: 5.7, 5.11, 7.2, 7.3, 7.6, 7.7, 7.8_

  - [ ]* 5.13 Write property test for the trusted test command
    - **Property 5: Test command comes only from trusted configuration**
    - **Validates: Requirements 5.7, 5.11, 7.2, 7.6**

  - [ ] 5.14 Integrate RUN_TESTS into the executor and pipeline
    - Replace the placeholder `RUN_TESTS` handler (task 3.14) with a `TestRunner` delegate. Run the not-configured check before any confirmation prompt is shown (no prompt and no spawn when the setting is unset). Store the last run in a `TestRunStore`. Add the `list all failures` local rule (listing up to 20 failing names from the stored run) and make "summarize the test failures" answer deterministically from the stored summary.
    - Integrate `ConfirmationManager` and `ActionGate` into `InputPipeline`: while an action is pending, text goes only to the manager, and nothing else reaches the router, the backend or Bedrock. Non-confirmation text produces the re-prompt.
    - _Requirements: 5.11, 6.1, 6.4, 6.5, 6.6, 6.8, 7.1, 7.2, 7.3, 7.4, 7.6, 7.7, 16.3, 16.4_

  - [ ]* 5.15 Write integration tests for confirmation and test running
    - With fakes, assert: while pending, "go to line 10" and "what errors are there" give only the re-prompt and the router spy and a backend spy are never called; a fake clock advanced by hours leaves the action pending; a second `needs-confirmation` request is held and presented in order; REPEAT_CONFIRMATION leaves the order unchanged; an idle "yes", "ok" or "just do it" executes nothing and does not authorize a later request; `did_not_execute` is reported differently from a failing run.
    - _Requirements: 6.2, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 7.1, 7.7_

  - [ ] 5.16 Wire confirmation and tests into the extension and webview
    - Feed the pending confirmation into the view model and webview: show the Confirm and Decline section with the prompt text, move focus to the prompt, make Tab reach Confirm then Decline, and return focus to the input when it resolves. Connect the buttons to `confirm()` and `decline()`. Register `kirosight.runTests` and `kirosight.showTestOutput`. In `extension.ts` construct `TestRunner`, `ConfirmationManager` and `ActionGate`.
    - _Requirements: 6.2, 6.3, 6.5, 14.1, 14.3, 7.1, 7.4_

  - [ ] 5.17 Checkpoint - Ensure all tests pass, ask the user if questions arise.
    - Demo check: type "run my tests", read the confirmation prompt, try confirm, decline, cancel and repeat, and read the concise pass and fail summary.

- [ ] 6. Milestone 6: Python backend and mock WebSocket round trip
  - Introduce the local FastAPI backend, the versioned protocol on both sides with shared fixtures, the WebSocket client in the extension host, and the local-first relay. The backend's agent is a canned stub. Local commands keep working with the backend off.
  - _Requirements: 5.1, 11.1, 11.2, 11.3, 11.4, 17.1, 17.5, 17.6, 19.2, 19.5, 19.9_

  - [ ] 6.1 Scaffold the backend
    - Create `backend/` with `app/` (`main.py`, `config.py`, `session.py`, `allowlist.py`, `logging_utils.py`, and `protocol/`, `agent/`, `speech/` packages), `tests/`, `requirements.txt` with exactly pinned versions (`fastapi`, `uvicorn[standard]`, `pydantic>=2` pinned, `httpx`, `python-dotenv`, `pytest`, `pytest-asyncio`, `hypothesis`), pytest configuration, and a backend `.env.example` aligned with the root one.
    - _Requirements: 17.1, 17.3, 17.4_

  - [ ] 6.2 Implement configuration and loopback enforcement
    - Implement `config.py`: load the environment (python-dotenv), resolve `KIROSIGHT_HOST` (default `127.0.0.1`) and `KIROSIGHT_PORT`, refuse any non-loopback host with a configuration error, and report which credentials are missing by name without logging values.
    - _Requirements: 11.4, 17.1, 17.5_

  - [ ]* 6.3 Write property test for loopback-only binding
    - **Property 9: Backend binds only to loopback**
    - **Validates: Requirements 11.4**

  - [ ] 6.4 Implement log redaction
    - Implement `logging_utils.py`: `redact()` and a logging filter that removes secret values. Log metadata only (type, id, sizes), never audio, code or credentials.
    - _Requirements: 17.6_

  - [ ]* 6.5 Write property test for redaction
    - **Property 27: Redaction removes secrets**
    - **Validates: Requirements 17.6**

  - [ ] 6.6 Implement the backend allow-list registry
    - Implement `allowlist.py`: `ALLOWED_ACTIONS: dict[str, ActionSpec]` with exactly the eight MVP actions, each with its risk class (`RUN_TESTS` is `needs-confirmation`) and strict parameter models with `extra="forbid"`. There is no `RUN_COMMAND` and no `GO_TO_SYMBOL`.
    - _Requirements: 5.1, 5.6, 5.8_

  - [ ]* 6.7 Write allow-list parity tests
    - A pytest test checks `allowlist.py` against the shared fixture `protocol/fixtures/allowlist.json`, and a Vitest test checks `actions/allowlist.ts` against the same fixture. Both assert the registry has exactly the eight MVP actions and the same risk classes (the automated parity check).
    - _Requirements: 5.1, 5.8_

  - [ ] 6.8 Implement the TypeScript protocol types and validators
    - Implement `protocol/messages.ts`, `protocol/constants.ts` (`PROTOCOL_VERSION = 1`) and `protocol/validators.ts` (zod). Define every message in the design with `version` and `type` on each: `hello`, `hello_ack`, `agent_request`, `agent_response`, `action_request`, `action_result`, `record_start`, `record_stop`, `audio_clip`, `transcription_result`, `speech_request`, `speech_audio`, `cancel` and `error_message`, the `ErrorCode` set, and the `IDEContext` payload. `agent_response.action` is validated on the envelope only as an object with a string `type`; strict checking stays in `ActionValidator`. Validation never throws.
    - _Requirements: 11.1, 11.2, 11.3_

  - [ ] 6.9 Implement the Python protocol models, validators, fixtures and protocol document
    - Implement `protocol/messages.py` (Pydantic v2, `extra="forbid"`, discriminated union on `type`) and `protocol/validators.py` (`parse_message(raw)` returns a message or a protocol error and never raises). Commit sample messages per type as shared fixtures in `protocol/fixtures/`, validated by both languages. Write `docs/protocol.md` documenting every message, its fields and the error codes.
    - _Requirements: 11.1, 11.2, 11.3_

  - [ ]* 6.10 Write property test for protocol round trips
    - **Property 7: Protocol messages round-trip**
    - **Validates: Requirements 11.1, 11.2**

  - [ ]* 6.11 Write property test for invalid protocol messages
    - **Property 8: Invalid protocol messages are rejected without dispatch**
    - **Validates: Requirements 11.3**

  - [ ] 6.12 Implement the FastAPI app, session and stub agent
    - Implement `main.py` (`GET /health`, `WebSocket /ws`, `ws_max_size` of 2 MB, rejection of any connection carrying an `Origin` header, optional shared-token check in `hello`), `session.py` (history of the last 6 turns, in-flight task registry for `cancel`, capability snapshot), the `hello`/`hello_ack` handshake with capabilities (`bedrock`, `stt`, `tts` false for now; `mic` `not_applicable`), validation failures answered with an `error_message` that never echoes the payload while the connection stays open, and a stub agent returning a canned `agent_response` with `NO_ACTION`.
    - _Requirements: 11.3, 11.4, 17.5_

  - [ ]* 6.13 Write WebSocket integration tests
    - With the FastAPI `TestClient`: handshake and capabilities, rejection of a connection with an `Origin` header, the token check, an invalid message keeps the connection open, `cancel` stops a running task, the stub agent round trip.
    - _Requirements: 11.3, 11.4_

  - [ ] 6.14 Implement BackendClient and ConnectionManager
    - Implement `backend/backendClient.ts` and `backend/connectionManager.ts` with an injectable WebSocket factory: lazy connect, the `hello` handshake, states `disconnected`, `connecting`, `connected` and `incompatible`, bounded exponential backoff (1, 2, 4 s, capped at 15 s) while the panel is open, request timeouts (agent 25 s), `cancel`, `onEvent`, failure of in-flight requests on disconnect, validation of every incoming message with the protocol validators, and acceptance of `kirosight.backendUrl` only when its host is loopback. The host process owns this connection; the webview never does.
    - _Requirements: 10.3, 11.1, 11.2, 11.3, 19.2_

  - [ ] 6.15 Implement the optional backend launcher
    - Implement `backend/backendLauncher.ts` and register `kirosight.startBackend`, which spawns the command from the user-scoped `kirosight.backendCommand` setting. A documented manual start remains the default and nothing in Milestones 1 to 5 depends on this.
    - _Requirements: 19.2_

  - [ ] 6.16 Implement the local-first relay
    - Extend the pipeline with a real `AgentGateway`: only agent-routed text is relayed as an `agent_request` (with `toWireContext`), within 500 ms of receipt and in arrival order, and each backend response reaches the webview within 500 ms. Locally handled text is never relayed. When the WebSocket is not open, relay nothing, send the webview `backend_unavailable` within 2 s, return `submit_ack` status `not_handled` so the draft stays in the input, and state which features still work. Append `agent_response` speech to the transcript. Actions carried by `agent_response` are validated and executed in task 7.11.
    - _Requirements: 8.1, 10.4, 19.5, 19.9_

  - [ ]* 6.17 Write property test for relay ordering
    - **Property 32: Relay preserves arrival order**
    - **Validates: Requirements 19.5**

  - [ ]* 6.18 Write property test for local-first handling
    - **Property 33: Local commands never relay and never depend on the backend**
    - **Validates: Requirements 10.4, 19.5, 19.9**

  - [ ] 6.19 Wire the backend connection into the extension
    - In `extension.ts`, construct `BackendClient` and `ConnectionManager` and connect lazily. Show connection state and capabilities in the view model status text. Read the optional backend token from `SecretStorage` and add a command to set it. Contribute `kirosight.backendUrl` and `kirosight.voice.enabled` settings. Keep the token out of the webview, logs and source.
    - _Requirements: 10.3, 11.4, 17.2, 19.2_

  - [ ] 6.20 Checkpoint - Ensure all tests pass, ask the user if questions arise.
    - Demo check: start the backend, see "connected" with capabilities, and get the canned stub answer to an agent-routed utterance. Confirm local commands still work with the backend stopped.

- [ ] 7. Milestone 7: Bedrock semantic reasoning
  - Add the `AgentService` behind a mockable `LLMClient`, the Bedrock Converse call with a forced tool, strict output validation, explanation and test-failure summaries, and handling of agent-proposed actions with `action_result` replies. Amazon Bedrock is the only LLM provider.
  - _Requirements: 5.4, 5.5, 5.9, 5.10, 5.11, 7.5, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 13.1, 13.2, 13.3, 13.4_

  - [ ] 7.1 Spike E: minimal Bedrock request from Python (time box: 45 minutes)
    - Write a throwaway script that makes one `converse` call with a forced `respond` tool, using the planned credentials, model ID and region.
    - Pass criterion: the returned tool input parses as an `AgentResponse`-shaped object with Pydantic (`extra="forbid"`).
    - Fallback decision: choose another enabled model or region, or request access, and record the chosen `BEDROCK_MODEL_ID` and region. If Bedrock cannot be reached in time, demo the stub `LLMClient` behind the same interface. No second LLM provider is added.
    - Must NOT implement the real Bedrock client. Record the outcome in `docs/spike-results.md`. This spike can also be done early, in parallel with Milestone 1, if time allows.
    - _Requirements: 13.1, 13.2_

  - [ ] 7.2 Implement the LLMClient seam and a stub client
    - Implement `agent/llm_client.py`: the `LLMClient` protocol (`async def respond(request) -> RawModelOutput`), the `LLMRequest` and `RawModelOutput` types, and a `StubLLMClient` returning canned valid responses so the demo can run if Bedrock is unreachable.
    - _Requirements: 13.2, 13.3_

  - [ ] 7.3 Implement the agent response parser
    - Implement `agent/response_parser.py`: `parse_agent_output(raw)` validates the shape with Pydantic, checks the action against `allowlist.py`, limits speech to 5 sentences and 600 characters, and returns either an `AgentResponse` or a safe failure. It never raises and never returns an action outside the allow-list.
    - _Requirements: 5.5, 5.6, 7.5, 12.6_

  - [ ]* 7.4 Write property test for safe agent output
    - **Property 22: Agent output never yields an unsafe action**
    - **Validates: Requirements 5.5, 5.6, 13.4**

  - [ ]* 7.5 Write property test for the sentence limit
    - **Property 23: Spoken responses respect the sentence limit**
    - **Validates: Requirements 7.5, 12.6**

  - [ ] 7.6 Implement prompt construction
    - Implement `agent/prompt.py`: build the system prompt and user content from the utterance, bounded context, diagnostics, the allowed action definitions from `allowlist.py` and the last few turns. Code, diagnostics and test output are presented as untrusted text. Instruct the model to keep answers to 5 sentences or fewer, offer more detail, and answer with an allow-listed action only.
    - _Requirements: 12.1, 12.2, 12.6_

  - [ ] 7.7 Implement the Bedrock client
    - Implement `agent/bedrock_service.py`: `BedrockLLMClient` using boto3 `bedrock-runtime` `converse` with a forced `respond` tool whose schema is `AgentResponse`, run in a worker thread with a 20 s read timeout and at most one retry on throttling. Read `AWS_*` and `BEDROCK_MODEL_ID` from the environment and make no call when a credential is missing (naming it in the error). No other provider is referenced.
    - _Requirements: 13.1, 13.2, 13.3, 17.1, 17.5_

  - [ ] 7.8 Implement AgentService and integrate it into the backend
    - Implement `agent/agent_service.py`: orchestrate prompt, `LLMClient` call and parser; map any failure to an `error_message` (`BEDROCK_UNAVAILABLE`, `CREDENTIAL_MISSING`, `BEDROCK_INVALID_RESPONSE`) with no action and no retry against another provider; support `kind='utterance'` and `kind='summarize_test_run'`. Replace the stub agent in `main.py`, select the real or stub client by configuration, and report `capabilities.bedrock` in `hello_ack`.
    - _Requirements: 7.5, 12.3, 12.6, 13.3, 13.4_

  - [ ]* 7.9 Write agent orchestration tests
    - With a fake `LLMClient`: a Bedrock failure yields `BEDROCK_UNAVAILABLE` and no second provider is attempted; a valid output passes through; an invalid output yields a safe error with no action; a `summarize_test_run` request is grounded in the bounded summary; the result respects the 5-sentence limit.
    - _Requirements: 7.5, 12.3, 13.2, 13.3, 13.4_

  - [ ] 7.10 Implement extension-side explanation request building
    - Build the `agent_request` for "explain this error", "explain this function" and "explain the selection": choose the focus diagnostic (at the cursor, otherwise the first in the file), use the enclosing symbol or `DIAGNOSTIC_WINDOW_RADIUS` lines for a diagnostic, and the symbol or selection for code. Report locally, without calling the backend, that no matching diagnostic was found, or that no function or selection is available to explain. Show a stated error when the backend reports a reasoning failure.
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

  - [ ] 7.11 Implement agent-originated action handling and action_result
    - Pass every action carried by an `agent_response` or `action_request` through `validateAction` and the `ActionGate` (registry risk decides; `confirmationRequired` can only add a confirmation). Send exactly one `action_result` back to the backend for every agent-originated action, with status `ok`, `failed`, `declined`, `not_permitted`, `needs_clarification` or `not_configured`. Locally originated actions send none. After a failed test run, send a bounded `summarize_test_run` request when the backend is available and append its summary, falling back to the deterministic text otherwise.
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.9, 5.10, 5.11, 7.5_

  - [ ]* 7.12 Write integration tests for agent-originated actions
    - With a fake backend: `RUN_TESTS` with `confirmationRequired: false` still asks for confirmation; a `safe` action with the flag true asks, and with the flag false or absent does not; decline, cancel, an unknown action name and an unconfigured command each produce exactly one `action_result` with the matching status; a locally originated action produces none.
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.9, 5.10, 5.11_

  - [ ] 7.13 Wire reasoning into the extension
    - Hook the explanation builder (task 7.10) and the action handling (task 7.11) into the pipeline and `extension.ts`. Show the F1 (backend offline), F2 (Bedrock unavailable) and F6 (invalid response) messages in the transcript. Update `docs/env-vars.md` and `.env.example` for the Bedrock variables and document how to use the stub client.
    - _Requirements: 10.5, 12.3, 13.4_

  - [ ] 7.14 Checkpoint - Ensure all tests pass, ask the user if questions arise.
    - Demo check: "explain this error" returns a grounded answer of at most five sentences. With Bedrock unreachable, a stated error appears and local commands keep working.

- [ ] 8. Milestone 8: Deepgram speech-to-text
  - Layer voice input on the text pipeline behind a `VoiceInput` interface. Complete-clip STT, a 60 s capture cap, and the same path as typed input. Voice never blocks typed commands or the local features.
  - _Requirements: 9.1, 9.2, 9.3, 10.1, 10.3, 10.4, 10.5, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 19.5, 19.6, 19.7, 19.8_

  - [ ] 8.1 Spike D: microphone capture in a Kiro webview (time box: 60 minutes)
    - Write a throwaway webview that calls `getUserMedia` and `MediaRecorder`, records a 3 to 5 second clip after a permission grant, and sends it as base64 through `postMessage` to the extension host.
    - Pass criterion: the host receives at least one audio sample of non-zero length within 5 seconds of the webview starting capture, and the bytes play back correctly. Webview capture counts as unreliable if permission is denied, capture is unavailable, or that first sample does not arrive within 5 seconds.
    - Fallback decision: switch the `VoiceInput` implementation to `BackendLocalVoiceInput`, or run the demo typed-only with TTS playback. The outcome only switches the `VoiceInput` implementation and never changes routing, confirmation or accessibility logic.
    - Must NOT implement the real voice feature. Record the outcome in `docs/spike-results.md`. This spike can also be done early, in parallel with Milestone 1, if time allows.
    - _Requirements: 19.6_

  - [ ] 8.2 Implement the VoiceInput interface and VoiceController
    - Implement `voice/voiceInput.ts` (the interface with `kind`, `maxDurationMs` of 60,000, `available()`, `start()`, `stop()`, `cancel()`) and `voice/voiceController.ts`. The controller depends only on the interface, selects the implementation from the `hello_ack` capabilities and the Spike D result (a documented default constant), applies the 60 s cap, the 5 s first-sample watchdog that marks webview capture unreliable, the 10 s STT response limit, and the 10 s voice initialization budget. It remembers the last known microphone state. It only hands finished transcription text to `InputPipeline.handle(text, 'voice')`.
    - _Requirements: 9.1, 9.3, 10.3, 19.6, 19.7_

  - [ ] 8.3 Implement webview capture and audio relay
    - Add `MediaRecorder` capture to `media/main.js` (start and stop on `start_capture` and `stop_capture`, report `mic_state` of `granted`, `denied`, `unavailable` or `prompt`, send the clip as one `audio_clip`, chunked with `seq` and `final` above 1 MB). Implement `voice/webviewVoiceInput.ts` and `voice/audioRelay.ts`, which relay clips to the backend within 500 ms in the order received.
    - _Requirements: 9.1, 19.1, 19.3, 19.5_

  - [ ] 8.4 Implement Deepgram speech-to-text in the backend
    - Implement the `STTClient` interface and an `httpx`-based Deepgram Nova-2 client in `speech/deepgram_service.py` (model from `DEEPGRAM_STT_MODEL`, 10 s timeout, `DEEPGRAM_API_KEY` from the environment with no call and a named error when missing). Handle `audio_clip` in `main.py`: answer with `transcription_result`, or an `error_message` (`STT_UNAVAILABLE`, `STT_NO_SPEECH`, `TIMEOUT`). Report `capabilities.stt`.
    - _Requirements: 9.1, 9.2, 9.3, 10.1, 17.1, 17.5_

  - [ ] 8.5 Implement the backend-local recorder
    - Implement `speech/local_recorder.py`: on `record_start` record from the default microphone, stop on `record_stop` or at 60 s, re-check microphone availability on every start, and pass the clip to the STT client. Answer with `transcription_result` or `error_message` (`MIC_UNAVAILABLE`, `MIC_DENIED`), and report `capabilities.mic`. The recorder holds no credentials. Add the audio library as an exactly pinned dependency.
    - _Requirements: 19.6, 19.8_

  - [ ] 8.6 Implement BackendLocalVoiceInput
    - Implement `voice/backendLocalVoiceInput.ts` behind the `VoiceInput` interface: send `record_start` and `record_stop`, and resolve `stop()` to the backend clip id. Text it produces enters `InputPipeline.handle(text, 'voice')` exactly like webview-captured text, and no credential is involved on the extension side.
    - _Requirements: 19.6, 19.7, 19.8_

  - [ ]* 8.7 Write property test for missing credentials
    - **Property 26: Missing credentials block provider calls**
    - **Validates: Requirements 17.5**

  - [ ]* 8.8 Write Deepgram STT and recorder tests
    - With `httpx.MockTransport`: success, HTTP errors, a 10 s timeout and an empty transcript map to the right `error_message` codes. With a fake recorder: microphone unavailable and denied, and the 60 s cap.
    - _Requirements: 9.3, 10.1, 17.5, 19.6_

  - [ ] 8.9 Integrate voice with the pipeline, view model and activation
    - Route `transcription_result` to `InputPipeline.handle(text, 'voice')` and record the text as the user's query. On a transcription failure, timeout or empty result: route nothing, add a Transcript entry within 1 s saying the voice input could not be processed, keep the typed draft, and leave push-to-talk enabled. Implement the push-to-talk toggle (Enter or Space to start and stop, Listening and Processing labels). Implement the voice states (granted, undetermined, denied, unavailable, granted later) so that `kirosight.activate` always opens the panel, begins listening only when the microphone is known to be granted and speech is available, offers a keyboard-operable permission request otherwise, and records that voice is unavailable. When initialization is not finished within 10 s, add the "voice unavailable for the session" entry and keep push-to-talk focusable with visible text. Typed input and local features stay operable under every voice failure.
    - _Requirements: 9.2, 9.3, 10.1, 10.3, 10.4, 10.5, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 19.7_

  - [ ]* 8.10 Write property test for typed and voice equivalence
    - **Property 11: Typed and voice input take the same path**
    - **Validates: Requirements 8.1, 8.2, 9.2, 19.7**

  - [ ]* 8.11 Write property test for activation under voice states
    - **Property 28: Activation never fails because of voice**
    - **Validates: Requirements 18.1, 18.2, 18.3, 18.4, 18.5, 18.6**

  - [ ]* 8.12 Write timing and substitution tests
    - With a fake clock: STT with no response for 10 s yields the Transcript entry within 1 s with the draft preserved and push-to-talk enabled; initialization not finished by 10 s yields the "unavailable for the session" entry; recording stops at 60 s; no non-zero audio sample within 5 s selects the backend-local implementation; the same `VoiceController` tests pass against fake `WebviewVoiceInput` and `BackendLocalVoiceInput` with identical routing output.
    - _Requirements: 9.1, 9.3, 10.1, 10.3, 19.5, 19.6_

  - [ ] 8.13 Wire voice into the extension
    - In `extension.ts`, construct `VoiceController` with the selected `VoiceInput`, honor `kirosight.voice.enabled`, connect it to the webview provider and the backend client, and make `kirosight.activate` use the voice-aware behavior from task 8.9. Update `docs/env-vars.md` for the Deepgram variables.
    - _Requirements: 9.7, 18.1, 18.2, 18.5, 18.6_

  - [ ] 8.14 Checkpoint - Ensure all tests pass, ask the user if questions arise.
    - Demo check: press push-to-talk, speak a local command, and see the same result as typing it. Stop the backend or disable STT and confirm typed input continues.

- [ ] 9. Milestone 9: Deepgram text-to-speech
  - Speak responses after their text is already in the Transcript, with playback in the webview and reliable interruption. TTS failure leaves the full text in place.
  - _Requirements: 6.3, 9.4, 9.5, 10.2, 15.3_

  - [ ] 9.1 Implement Deepgram text-to-speech in the backend
    - Add a `TTSClient` interface and an `httpx`-based Deepgram Aura client (model from `DEEPGRAM_TTS_MODEL`, 10 s timeout, named error when `DEEPGRAM_API_KEY` is missing). Handle `speech_request` in `main.py`: answer with `speech_audio` or `error_message` `TTS_UNAVAILABLE`, support `cancel`, and report `capabilities.tts`.
    - _Requirements: 9.4, 9.5, 10.2, 17.5_

  - [ ]* 9.2 Write Deepgram TTS tests
    - With `httpx.MockTransport`: success, HTTP errors and a timeout map to the right outcomes; a missing credential makes no call; `cancel` stops an in-flight synthesis.
    - _Requirements: 9.5, 10.2, 17.5_

  - [ ] 9.3 Implement the SpeechController in the extension host
    - Implement `voice/speechController.ts`: after a response is appended to the Transcript (text first), send a `speech_request` when speech is active; forward `speech_audio` to the webview as `play_audio`; require playback to begin within 10 s; on failure or timeout keep the full text and add a separate Transcript entry within 1 s saying spoken playback is unavailable. Speak the confirmation prompt, including action name, target and change, when speech is active, and again on REPEAT_CONFIRMATION. A Bedrock error is spoken as well as shown.
    - _Requirements: 6.3, 9.4, 9.5, 10.2, 13.4, 15.3_

  - [ ] 9.4 Implement webview audio playback
    - Add playback to `media/main.js` using `blob:` URLs with a `data:` fallback: report `playback` state (`started`, `ended`, `failed`), handle `stop_audio`, show a Speaking status label, and keep the Escape key stopping speech without capturing other keys.
    - _Requirements: 9.4, 9.5, 14.5, 15.3_

  - [ ] 9.5 Implement interruption and cancellation
    - Starting push-to-talk, pressing Escape, running `kirosight.stopSpeaking` or submitting a new utterance stops playback (`stop_audio`), bumps the `RequestTracker` lane, and sends `cancel` for any in-flight `speech_request`, `audio_clip` or `agent_request`. Late replies for superseded ids are dropped. A pending confirmation is not resolved by an interruption, and an interrupted spoken response stays complete in the Transcript.
    - _Requirements: 6.10, 9.4, 15.3_

  - [ ]* 9.6 Write TTS ordering and interruption tests
    - Assert the Transcript entry is appended before `play_audio` is sent; a TTS response not playing within 10 s gives the full text and a separate unavailable entry within 1 s; interruption cancels in-flight work and drops late replies; a pending confirmation survives an interruption; the spoken confirmation prompt names the action and target and is repeated on request.
    - _Requirements: 6.3, 6.9, 9.4, 9.5, 10.2, 15.3_

  - [ ] 9.7 Wire speech output into the extension
    - In `extension.ts`, construct `SpeechController`, connect it to the pipeline's response path and the confirmation prompts, and register `kirosight.stopSpeaking` in the manifest. Respect `kirosight.voice.enabled` so typed-only use stays silent.
    - _Requirements: 9.4, 9.5, 6.3_

  - [ ] 9.8 Checkpoint - Ensure all tests pass, ask the user if questions arise.
    - Demo check: responses are spoken after their text appears, Escape or a new utterance interrupts, and with TTS unavailable the text and a note remain.

- [ ] 10. Milestone 10: Demo fixture, accessibility polish and failure handling
  - Prepare the demo project with a known test runner, verify every documented failure mode, polish the accessibility details, write the demo script and README, and do a final integration pass.
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 15.4, 17.3, 17.4, 17.6_

  - [ ] 10.1 Create the demo fixture project
    - Create a small TypeScript project in `demo-project/` with exactly pinned dependencies and a known test runner (Vitest), one deliberate type error in a function, a second file for `OPEN_FILE`, and a test suite with a few passing tests and at least one failing test. Add `kirosight.testCommand` to the fixture's workspace settings and document that the workspace must be trusted for it to apply.
    - _Requirements: 2.1, 4.1, 4.4, 7.2, 7.3, 12.1_

  - [ ]* 10.2 Write failure-mode tests (F1 to F12)
    - Table-driven tests with fakes covering: backend offline, Bedrock unavailable, Deepgram STT and TTS failing, microphone unavailable, microphone permission denied, invalid AI response, unknown action, test command missing, test command failing, no active editor, no diagnostics and symbol provider unavailable. Each asserts the stated message, that no action ran where none should, and that typed commands and local features still work.
    - _Requirements: 1.2, 1.4, 2.3, 2.4, 5.5, 7.6, 7.7, 10.1, 10.2, 10.3, 10.4, 10.5, 12.3, 13.4_

  - [ ]* 10.3 Write repository hygiene tests
    - Assert the environment variable names referenced in the Python and TypeScript sources match `.env.example` and `docs/env-vars.md`, that `.gitignore` excludes `.env` files, `node_modules`, Python virtual environments, `__pycache__` and build output, and that no credential patterns appear in the webview assets, the generated HTML or the extension source.
    - _Requirements: 17.3, 17.4, 17.6, 19.4_

  - [ ] 10.4 Apply accessibility polish from the review
    - Refine the webview code: focus movement after submit, confirmation and resolution; one announcement per change (no duplicate transcript and latest-response announcements); text labels for every status; `forced-colors` and high-contrast friendly styles; a focus indicator that holds at least 3:1 contrast in the light, dark and high-contrast themes; no interception of screen reader keys.
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 15.4_

  - [ ]* 10.5 Add an automated accessibility check
    - Run `axe-core` (exact pinned version) against the rendered webview in jsdom and assert no violations. State in the test comments that automated checks catch only a subset of issues and cannot certify WCAG conformance.
    - _Requirements: 14.1, 14.3, 14.4_

  - [ ] 10.6 Write the accessibility review checklist
    - Create `docs/accessibility-checklist.md` covering: a keyboard-only walkthrough of every control and demo step; a screen reader pass (NVDA or JAWS on Windows, VoiceOver on macOS) checking that the transcript is read, status changes are announced once, and the confirmation prompt is announced with focus on it; operation with TTS disabled and with the backend stopped; and focus indicator contrast in the light, dark and high-contrast themes. State clearly that full WCAG validation needs assistive technology testing and expert review.
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 15.4_

  - [ ] 10.7 Write the demo script and pre-flight check
    - Create `docs/demo-script.md` for the primary journey (activate with `kirosight.activate`, ask what is happening, go to the error, explain it, run tests, get a summary) with text always available, and a pre-flight script checking the backend `/health`, that required environment variable names are set (never printing values), that `kirosight.testCommand` is configured and that the demo fixture builds.
    - _Requirements: 7.2, 9.7, 17.6_

  - [ ] 10.8 Write the README and finalize the documentation
    - Write the root `README.md` (what KiroSight is, setup for the extension and backend, environment variables, settings, how to activate with and without a keybinding, the loopback-only backend, the limits and non-goals, and that it supplements the user's screen reader). Finalize `docs/env-vars.md`, `docs/protocol.md` and `docs/spike-results.md` (all five spike outcomes and the decisions taken).
    - _Requirements: 9.7, 9.8, 9.9, 9.10, 17.4_

  - [ ] 10.9 Final integration pass
    - Confirm every command in the manifest is registered and documented, that the help response lists the supported commands, that throwaway spike code is removed, and that the complete build and both test suites (Vitest and pytest) pass. Verify that the demo journey works end to end with the backend running and, separately, with it stopped.
    - _Requirements: 8.2, 9.7, 10.4, 10.5, 14.3, 15.4, 18.5_

  - [ ] 10.10 Final checkpoint - Ensure all tests pass, ask the user if questions arise.
    - Demo check: run the full demo journey from `docs/demo-script.md` and the accessibility checklist, and confirm text is available throughout.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. Only test-related sub-tasks are optional. Core implementation tasks and the spike tasks are not.
- Each of the 33 correctness properties in the design has exactly one property-based test sub-task, placed next to the implementation it checks.
- Spikes A to E (tasks 1.1, 2.1, 5.1, 7.1, 8.1) are time-boxed development activities. They write throwaway code only, must not implement the full feature, and record their outcome in `docs/spike-results.md`. Spike D's outcome only switches the `VoiceInput` implementation.
- The allow-list has exactly eight actions. No task adds `GO_TO_SYMBOL`, `RUN_COMMAND` or any symbol navigation, and Requirement 3 (Git status) has no tasks.
- Checkpoint sub-tasks and top-level milestone tasks are not listed in the dependency graph. Milestones run in order, so each milestone's waves start after the previous milestone's waves.
- Each requirement reference points to the granular acceptance criteria the task satisfies. See the design document for the matching component descriptions.
- Automated checks cannot establish WCAG conformance. The accessibility checklist in task 10.6 requires manual testing with assistive technologies.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.4"] },
    { "id": 3, "tasks": ["1.5"] },
    { "id": 4, "tasks": ["1.6"] },
    { "id": 5, "tasks": ["2.1", "2.2"] },
    { "id": 6, "tasks": ["2.3", "2.5", "2.8"] },
    { "id": 7, "tasks": ["2.4", "2.6", "2.7", "2.9"] },
    { "id": 8, "tasks": ["2.10"] },
    { "id": 9, "tasks": ["2.11", "2.12"] },
    { "id": 10, "tasks": ["3.1", "3.5", "3.10", "3.12"] },
    { "id": 11, "tasks": ["3.2", "3.3", "3.6", "3.7", "3.11", "3.13", "3.17"] },
    { "id": 12, "tasks": ["3.4", "3.8", "3.9", "3.14", "3.18"] },
    { "id": 13, "tasks": ["3.15"] },
    { "id": 14, "tasks": ["3.16", "3.19"] },
    { "id": 15, "tasks": ["3.20"] },
    { "id": 16, "tasks": ["4.1", "4.5"] },
    { "id": 17, "tasks": ["4.2", "4.3", "4.8"] },
    { "id": 18, "tasks": ["4.4", "4.6", "4.9"] },
    { "id": 19, "tasks": ["4.7", "4.10"] },
    { "id": 20, "tasks": ["4.11", "4.12", "4.13"] },
    { "id": 21, "tasks": ["4.14"] },
    { "id": 22, "tasks": ["5.1", "5.2", "5.8"] },
    { "id": 23, "tasks": ["5.3", "5.4", "5.9"] },
    { "id": 24, "tasks": ["5.5", "5.6", "5.10"] },
    { "id": 25, "tasks": ["5.7", "5.11", "5.12"] },
    { "id": 26, "tasks": ["5.13", "5.14"] },
    { "id": 27, "tasks": ["5.15", "5.16"] },
    { "id": 28, "tasks": ["6.1"] },
    { "id": 29, "tasks": ["6.2", "6.4", "6.6", "6.8"] },
    { "id": 30, "tasks": ["6.3", "6.5", "6.7", "6.9", "6.14", "6.15"] },
    { "id": 31, "tasks": ["6.10", "6.11", "6.12"] },
    { "id": 32, "tasks": ["6.13", "6.16"] },
    { "id": 33, "tasks": ["6.17", "6.18", "6.19"] },
    { "id": 34, "tasks": ["7.1", "7.2", "7.3"] },
    { "id": 35, "tasks": ["7.4", "7.5", "7.6", "7.7", "7.10"] },
    { "id": 36, "tasks": ["7.8", "7.11"] },
    { "id": 37, "tasks": ["7.9", "7.12"] },
    { "id": 38, "tasks": ["7.13"] },
    { "id": 39, "tasks": ["8.1", "8.4"] },
    { "id": 40, "tasks": ["8.2", "8.5", "8.7"] },
    { "id": 41, "tasks": ["8.3", "8.6", "8.8"] },
    { "id": 42, "tasks": ["8.9"] },
    { "id": 43, "tasks": ["8.10", "8.11", "8.12", "8.13"] },
    { "id": 44, "tasks": ["9.1", "9.3"] },
    { "id": 45, "tasks": ["9.2", "9.4"] },
    { "id": 46, "tasks": ["9.5"] },
    { "id": 47, "tasks": ["9.6", "9.7"] },
    { "id": 48, "tasks": ["10.1", "10.4"] },
    { "id": 49, "tasks": ["10.2", "10.3", "10.5", "10.6", "10.7"] },
    { "id": 50, "tasks": ["10.8"] },
    { "id": 51, "tasks": ["10.9"] }
  ]
}
```
