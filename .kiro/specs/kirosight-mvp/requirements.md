# Requirements Document

## Introduction

KiroSight is an accessibility agent for blind and low-vision software developers using the Kiro IDE. It supplements, rather than replaces, the developer's existing screen reader by exposing structured IDE/project state through a voice- and text-driven interface backed by an AI agent. This document captures the requirements for the KiroSight MVP: describing IDE state, navigating files and diagnostics, explaining code and errors, running trusted test workflows under an allow-list and confirmation model, and supporting both voice and typed-text interaction with full accessibility.

Per project steering, the MVP is built in four milestones:

1. **Milestone 1** — Extension-only. The Context_Service, Diagnostics_Service, Git_Status_Service, and allow-listed navigation Actions work purely through VS Code Extension APIs, with no Backend_Service, no Reasoning_Agent, and no Speech_Interface.
2. **Milestone 2** — Introduces the Backend_Service and the Protocol between the Extension and the Backend_Service.
3. **Milestone 3** — Introduces the Reasoning_Agent (Amazon Bedrock) for explanation and summarization.
4. **Milestone 4** — Introduces the Speech_Interface (Deepgram Nova-2 STT, Deepgram Aura TTS) layered on top of the already-working typed-text experience.

To keep hackathon scope focused, each requirement below is tagged with a demo priority reflecting its role in the core demo journey (invoke the `kirosight.activate` command, ask what's happening, go to the error, explain it, run tests, get a summary, with text always available):

| Priority | Meaning |
|---|---|
| **Core** | Directly exercised by the primary demo journey; must work for the demo to succeed. |
| **Supporting** | Required by steering/product scope but not directly exercised by the primary demo journey; needed for a complete MVP but safe to simplify or stub first if time runs short. |
| **Foundational** | Cross-cutting safety/architecture requirement (allow-list, confirmation, protocol, secrets) that every other requirement depends on; not independently demoed but required for every demoed action to be safe. |
| **Stretch** | Documented for completeness but explicitly deferred past the initial MVP implementation; initial implementation tasks must not depend on it. |

- **Core**: Requirements 1, 2, 4, 7, 8, 9, 10, 12, 15, 16, 18.
- **Foundational**: Requirements 5, 6, 11, 13, 14, 17, 19.
- **Stretch**: Requirement 3 (Git status is documented per `product.md` but is deferred past the initial MVP implementation; initial implementation tasks must not depend on Git integration, and the primary demo does not require Git).
- **Stretch (Action scope)**: Voice-driven symbol navigation (a `GO_TO_SYMBOL` Action, i.e. "go to function foo") is deferred past the initial MVP implementation. Requirement 4 requires navigation to a specific line only; initial implementation tasks must not include or depend on `GO_TO_SYMBOL`. Current-symbol detection (Requirements 1.3 and 1.4) and the use of symbols as explanation context (Requirement 12) remain in scope because they describe code and never move the cursor.
- **Post-MVP (Confirmation)**: Answering arbitrary read-only questions while an Action is pending confirmation is a post-MVP enhancement; in the MVP the Confirmation_Flow accepts only confirm, decline, cancel, and repeat replies while an Action is pending (Requirement 6).

Requirements below are organized by capability, not strictly by milestone, but each requirement states which milestone's components it depends on so implementation order can follow the staged build described in `tech.md`. Code-modifying actions (for example "fix this error" or "make this change") are explicitly out of scope for this MVP and are called out as a non-goal at the end of this document.

## Glossary

- **KiroSight_Extension**: The TypeScript VS Code/Kiro extension process. The only component with direct access to Kiro/VS Code editor, workspace, diagnostics, Git, and terminal state.
- **Backend_Service**: The local Python FastAPI + WebSocket process that orchestrates the Reasoning_Agent and the Speech_Interface. Introduced starting at Milestone 2. Not deployed remotely; binds to localhost only.
- **Context_Service**: The component within the KiroSight_Extension responsible for reading current file, cursor position, selection, and open editor state via VS Code Extension APIs and formatting it into plain data structures.
- **Diagnostics_Service**: The component within the KiroSight_Extension responsible for reading diagnostics (errors/warnings) via `vscode.languages.getDiagnostics` and formatting them into plain data structures.
- **Git_Status_Service**: The component within the KiroSight_Extension responsible for reading Git state (changed files, branch, ahead/behind) via VS Code's built-in Git extension API or an equivalent fallback.
- **Action_Dispatcher**: The component within the KiroSight_Extension that executes allow-listed Actions (for example `OPEN_FILE`, `GO_TO_DIAGNOSTIC`, `GO_TO_LINE`, `RUN_TESTS`) requested by the user or by the Reasoning_Agent.
- **Activation_Command**: The VS Code command `kirosight.activate`, which is the canonical activation mechanism for KiroSight. It works with no keybinding at all (through the command palette or any keybinding the user assigns) and remains rebindable through standard VS Code/Kiro keybinding customization. Ctrl+Alt+K is only a proposed default keybinding for Windows and Linux, included in the extension manifest only when an early keybinding conflict check on the demonstration machine finds no conflict; no macOS default keybinding is defined for the MVP. Invocable from anywhere in the editor, without first requiring keyboard focus inside the Webview_Panel. Opens or focuses the Webview_Panel and, where microphone permission has already been granted and the Speech_Interface is available, begins push-to-talk capture; otherwise leaves the user in a fully keyboard/text-operable state (see Requirement 18).
- **Allowlist_Registry**: The single, documented registry (`backend/app/allowlist.py`) listing every Action the Reasoning_Agent may request, together with its risk classification (`safe` or `needs-confirmation`). The KiroSight_Extension keeps an execution-time registry containing exactly the same Actions and risk classifications, verified by an automated parity check, and the Action_Dispatcher consults only that extension-side registry at execution time (see Requirement 5, Acceptance Criterion 1). The MVP action set is enumerated in Requirement 5, Acceptance Criterion 8.
- **kirosight.testCommand**: The trusted VS Code user/workspace configuration setting holding the exact shell command the `RUN_TESTS` Action executes (for example `npm test`). Supplied only by the user or workspace configuration, never by the Reasoning_Agent.
- **Confirmation_Flow**: The interaction sequence that presents a pending destructive or state-changing Action to the user, in both the Webview_Panel and (when the Speech_Interface is active) by voice, and requires explicit user confirmation before the Action_Dispatcher executes it. While an Action is pending, the Confirmation_Flow accepts exactly four replies: confirm, decline, cancel (which behaves like decline), and repeat (which re-presents the pending prompt without changing state); any other input receives a concise re-prompt (see Requirement 6).
- **Reasoning_Agent**: The Amazon Bedrock-backed component, running inside the Backend_Service behind an interface in `backend/app/agent/`, that produces explanations, summaries, and Action requests grounded in IDE state supplied by the KiroSight_Extension. The sole LLM provider for the MVP; no fallback provider exists.
- **Speech_Interface**: The component spanning the Webview_Panel (preferred microphone capture and audio playback UI), the KiroSight_Extension host process (relaying captured audio and playback requests between the Webview_Panel and the Backend_Service), and the Backend_Service (streaming audio to Deepgram Nova-2 for speech-to-text and rendering Reasoning_Agent responses through Deepgram Aura for text-to-speech). Microphone capture is provided by a VoiceInput implementation selected behind the VoiceInput interface, so a change of capture mechanism does not change the rest of the command pipeline (see Requirement 19).
- **VoiceInput**: The interface behind which the Speech_Interface obtains microphone audio. It has two implementations: the preferred Webview_Panel capture implementation, and an allowed backend-local fallback implementation in which the Backend_Service records the audio instead of the Webview_Panel. Text transcribed from either implementation enters the same intent-handling path as typed text.
- **Text_Input_Handler**: The component that accepts typed text from the Webview_Panel and routes it through the same intent-handling path used for voice input.
- **Webview_Panel**: The accessible VS Code Webview side panel, built with plain HTML/CSS/TypeScript, that hosts the push-to-talk control, the typed-text input, and the Transcript, and is responsible only for audio playback, UI rendering, and (as the preferred VoiceInput implementation) microphone audio capture. The Webview_Panel communicates with the rest of the KiroSight_Extension exclusively through the VS Code webview `postMessage` API; it does not hold any Deepgram or Amazon Bedrock credentials and does not open its own connection to the Backend_Service (see Requirement 19).
- **Transcript**: The persistent, screen-reader-accessible, visible log of queries and responses rendered inside the Webview_Panel.
- **Protocol**: The documented, versioned, typed set of JSON message shapes exchanged between the KiroSight_Extension and the Backend_Service over the local WebSocket connection owned and maintained by the KiroSight_Extension host process (not the Webview_Panel), each carrying a `version` field and a discriminating `type` field.
- **Protocol_Validator**: The validation logic on each side of the Protocol (TypeScript on the KiroSight_Extension side, Pydantic models on the Backend_Service side) that checks every incoming message against its documented schema before it is acted on.
- **Response_Formatter**: The component responsible for shaping KiroSight's reported outcomes (diagnostics, test results, Action outcomes) into concise, concrete text and speech content before it reaches the Transcript or the Speech_Interface.

## Requirements

### Requirement 1: Describe Current Editor Context

**User Story:** As a blind or low-vision developer, I want to ask what file and location I am currently working in, so that I can orient myself without visually scanning the editor.

#### Acceptance Criteria

1. WHEN a user requests the current editor context, THE Context_Service SHALL report the active text editor's file path, the cursor position as a 1-indexed line number and 1-indexed column number, and the current selection state: when the selection is non-empty, as 1-indexed start and end line and column numbers, and when the selection is empty, as an explicit indication that no selection exists.
2. IF no text editor is currently active, or the active editor is not displaying a text document, THEN THE Context_Service SHALL report that no file is open rather than returning an empty or malformed result.
3. WHEN a user requests the current function or enclosing symbol, THE Context_Service SHALL report the enclosing symbol's name and kind obtained from document symbol information for the active text editor's file.
4. IF a user requests the current function or enclosing symbol and no enclosing symbol can be determined because document symbol information is unavailable for the active file or the cursor position is not enclosed by any symbol, THEN THE Context_Service SHALL report that no enclosing symbol was found rather than returning an empty or malformed result.
5. THE Context_Service SHALL gather all data required by Acceptance Criteria 1 through 4 using only VS Code Extension APIs, without depending on the Backend_Service, the Reasoning_Agent, or the Speech_Interface.

### Requirement 2: Describe Diagnostics

**User Story:** As a blind or low-vision developer, I want to ask what errors and warnings exist in my project or current file, so that I can address them without manually navigating the Problems panel.

#### Acceptance Criteria

1. WHEN a user requests diagnostics scoped to the entire workspace, THE Diagnostics_Service SHALL report, for each diagnostic, its severity (Error, Warning, Information, or Hint), file path, line number, and message text, ordered first by severity (Error, then Warning, then Information, then Hint), then by ascending file path, then by ascending line number.
2. WHEN a user requests diagnostics scoped to the current file, THE Diagnostics_Service SHALL report only diagnostics whose file path matches the active editor's file path, ordered by ascending line number.
3. IF a user requests diagnostics scoped to the current file and no editor is currently active, THEN THE Diagnostics_Service SHALL report that no file is open rather than returning an empty list or an error without explanation.
4. IF no diagnostics exist in the requested scope, THEN THE Diagnostics_Service SHALL report that no diagnostics were found rather than returning an empty list without explanation.
5. THE Diagnostics_Service SHALL gather all diagnostic data using `vscode.languages.getDiagnostics` and other VS Code Extension APIs, without depending on the Backend_Service, the Reasoning_Agent, or the Speech_Interface.

### Requirement 3: Describe Git Status

*Priority: Stretch — see Introduction. Initial implementation tasks must not depend on this requirement.*

**User Story:** As a blind or low-vision developer, I want to ask what changed in my project's Git state, so that I can understand pending changes without opening the Source Control view.

#### Acceptance Criteria

1. WHEN a user requests the current Git status, THE Git_Status_Service SHALL report the current branch name (or an explicit indication of detached-HEAD state), the list of changed files with their change type (added, modified, deleted, renamed, or untracked), and the ahead/behind commit counts relative to the upstream branch when an upstream is configured.
2. IF the current workspace is not a Git repository when a user requests the current Git status, THEN THE Git_Status_Service SHALL report that no Git repository was found rather than returning an error without explanation.
3. IF the VS Code Git extension API and any equivalent read-only fallback are both unavailable when a user requests the current Git status, THEN THE Git_Status_Service SHALL report that Git status could not be determined rather than returning an error without explanation.
4. IF the current workspace contains more than one Git repository, THEN THE Git_Status_Service SHALL report status for the repository containing the active editor's file, or, if no editor is active, SHALL report that a specific repository could not be determined and SHALL list the available repositories.
5. THE Git_Status_Service SHALL gather Git state using a read-only `git` command-line fallback as its primary mechanism for the initial MVP implementation, and MAY additionally use VS Code's built-in (undocumented) Git extension API as a future enhancement; in all cases without depending on the Backend_Service, the Reasoning_Agent, or the Speech_Interface.

### Requirement 4: Navigate Files and Diagnostics

**User Story:** As a blind or low-vision developer, I want to open files and jump to specific errors or lines by command, so that I can move through my project without manual tree navigation.

#### Acceptance Criteria

1. WHEN a user requests to open a file by file name or workspace-relative path and exactly one file in the current workspace matches that name or path, THE Action_Dispatcher SHALL open that file in the editor and report the workspace-relative path of the file that was opened.
2. IF a user requests to open a file by file name or workspace-relative path and no file in the current workspace matches, THEN THE Action_Dispatcher SHALL report that the file was not found, SHALL NOT open any file, and SHALL leave the active editor unchanged.
3. IF a user requests to open a file by file name and more than one file in the current workspace matches that name, THEN THE Action_Dispatcher SHALL report the workspace-relative paths of up to 10 matching files (and the total match count if more than 10 match), SHALL request clarification, SHALL NOT open any file, and SHALL leave the active editor unchanged.
4. WHEN a user requests to go to a specific diagnostic identified by ordinal position or description (for example "the first error"), where ordinal positions such as "first" and "second" are 1-based from the user's perspective, THE Action_Dispatcher SHALL build the candidate list from the diagnostics reported by the Diagnostics_Service, restricted to the severity named in the request if one is named, ordered by ascending file path and then ascending line number (diagnostics with the same file path and line number keeping the order reported by the Diagnostics_Service), resolve a 1-based ordinal position against that list, move the editor cursor to the start of that diagnostic's line in its file (opening the file if it is not already active), and report the file path, line number, severity, and message text of the diagnostic reached.
5. IF a user requests to go to a specific diagnostic and no diagnostic in the candidate list matches the requested ordinal position or description, THEN THE Action_Dispatcher SHALL report that no matching diagnostic was found, SHALL NOT move the cursor, and SHALL leave the active editor unchanged.
6. WHEN a user requests to go to a specific line in the active file and the requested 1-based line number is an integer from 1 to the active file's last line number inclusive, THE Action_Dispatcher SHALL move the editor cursor to the start of that line and report the file path and line number reached.
7. IF a user requests to go to a specific line and either no editor is currently active or the requested line number is not an integer from 1 to the active file's last line number inclusive, THEN THE Action_Dispatcher SHALL report that the requested location could not be found, SHALL NOT move the cursor, and SHALL leave the active editor unchanged.
8. THE Action_Dispatcher SHALL implement each MVP navigation Action (`OPEN_FILE`, `GO_TO_DIAGNOSTIC`, `NEXT_DIAGNOSTIC`, `PREVIOUS_DIAGNOSTIC`, `GO_TO_LINE`, and `FOCUS_EDITOR`) as its own specific, named handler that accepts only the parameters defined for that Action, rather than a generic passthrough that accepts arbitrary command strings.

### Requirement 5: Enforce the Autonomous Action Allow-List

**User Story:** As a developer relying on an AI agent inside my IDE, I want the agent restricted to a fixed set of known actions, so that it cannot execute arbitrary or unintended operations against my project.

#### Acceptance Criteria

1. THE Allowlist_Registry SHALL define, in a single documented registry definition at `backend/app/allowlist.py`, every Action the Reasoning_Agent may request and each such Action's risk classification of exactly one of `safe` or `needs-confirmation`. THE KiroSight_Extension SHALL maintain an execution-time registry that contains exactly the same Actions and risk classifications as the Allowlist_Registry, verified by an automated parity check, and THE Action_Dispatcher SHALL consult only that extension-side registry when deciding whether and how to execute an Action.
2. WHEN the Reasoning_Agent requests an Action whose name exactly matches (case-sensitive) an Action in the Allowlist_Registry classified as `safe`, and the request does not carry a confirmation-required indication of true, THE Action_Dispatcher SHALL execute that Action according to its documented handler without requesting user confirmation.
3. WHEN the Reasoning_Agent requests an Action whose name exactly matches (case-sensitive) an Action in the Allowlist_Registry classified as `needs-confirmation`, THE Action_Dispatcher SHALL request explicit user confirmation before invoking that Action's documented handler, and SHALL invoke the handler only upon receiving that confirmation.
4. IF the user declines, cancels, or dismisses the confirmation request for an Action classified as `needs-confirmation`, THEN THE Action_Dispatcher SHALL NOT invoke that Action's handler, SHALL leave IDE and workspace state unchanged, and SHALL return a response to the Reasoning_Agent (where the request originated from it) indicating that the Action was not confirmed. A pending confirmation has no automatic expiry (see Requirement 6, Acceptance Criterion 10).
5. IF the Reasoning_Agent requests an Action whose name does not exactly match (case-sensitive) any Action in the Allowlist_Registry, THEN THE Action_Dispatcher SHALL reject the request without invoking any handler, SHALL leave IDE and workspace state unchanged, and SHALL return a response to the Reasoning_Agent indicating that the requested Action is not permitted.
6. THE Allowlist_Registry SHALL NOT include an Action that accepts, as a Reasoning_Agent-supplied parameter, a free-form text string that is used as a shell or process command.
7. WHEN the Action_Dispatcher invokes a handler that runs a shell or process command (for example the `RUN_TESTS` Action running the command configured in `kirosight.testCommand`), THE Action_Dispatcher SHALL run only the command value read from trusted extension/workspace configuration, and SHALL ensure that no command text, arguments, or modifications present in a Reasoning_Agent request affect the executed command (an Action request that carries such fields MAY be rejected as malformed).
8. THE Allowlist_Registry SHALL contain exactly the following Actions for the MVP and no others: `NO_ACTION`, `GO_TO_DIAGNOSTIC`, `NEXT_DIAGNOSTIC`, `PREVIOUS_DIAGNOSTIC`, `OPEN_FILE`, `GO_TO_LINE`, `FOCUS_EDITOR`, and `RUN_TESTS`, so that the Allowlist_Registry contains no `RUN_COMMAND` Action and no `GO_TO_SYMBOL` Action.
9. IF the Reasoning_Agent requests an Action classified as `needs-confirmation` and the request carries a confirmation-required indication that is false or absent, THEN THE Action_Dispatcher SHALL still request explicit user confirmation as specified in criterion 3, because the Allowlist_Registry classification determines the minimum confirmation requirement and the Reasoning_Agent's indication SHALL NOT weaken it.
10. IF the Reasoning_Agent requests an Action classified as `safe` and the request carries a confirmation-required indication of true, THEN THE Action_Dispatcher SHALL request explicit user confirmation before invoking that Action's documented handler and SHALL apply criterion 4 if confirmation is not provided.
11. IF the Action_Dispatcher is to invoke a handler that runs a shell or process command and the configured command value is absent or empty, THEN THE Action_Dispatcher SHALL NOT run any command, SHALL leave IDE and workspace state unchanged, and SHALL return a response indicating that the command is not configured.

### Requirement 6: Confirm Destructive or State-Changing Actions

**User Story:** As a developer, I want to approve any action that changes my files, runs code, or modifies Git state before it happens, so that the agent never surprises me with an unreviewed change.

#### Acceptance Criteria

1. WHEN the Reasoning_Agent requests an Action classified as `needs-confirmation` in the Allowlist_Registry, THE Confirmation_Flow SHALL present the pending Action's name and the specific target(s) and change(s) it will produce (for example the affected file path, line range, branch, or test command) to the user before the Action_Dispatcher executes it, and THE Action_Dispatcher SHALL NOT execute the Action until it is confirmed.
2. THE Confirmation_Flow SHALL surface every pending Action, including the information required by Acceptance Criterion 1, in the Webview_Panel together with Confirm and Decline controls that can each be focused and activated using the keyboard alone, without a pointing device.
3. WHERE the Speech_Interface is active, THE Confirmation_Flow SHALL additionally surface the pending Action by a spoken prompt that includes the same Action name, target(s), and change(s) presented in the Webview_Panel.
4. WHEN a user replies with a CONFIRM intent through typed text, keyboard activation of the Confirm control, or a spoken confirmation utterance (where the Speech_Interface is active), THE Action_Dispatcher SHALL execute the pending Action exactly once.
5. WHEN a user replies with a DECLINE or CANCEL intent through typed text, keyboard activation of the Decline control, or a spoken decline or cancel utterance (where the Speech_Interface is active), THE Action_Dispatcher SHALL discard the pending Action without executing it.
6. IF the Confirmation_Flow receives any input other than a CONFIRM, DECLINE, CANCEL, or REPEAT_CONFIRMATION reply while an Action is pending confirmation, THEN THE Confirmation_Flow SHALL respond with a re-prompt of no more than 30 words that names the pending Action and lists the accepted replies (for example "Run tests is waiting for confirmation. Say confirm, decline, or cancel."), SHALL keep the Action pending, and SHALL route that input neither to the Reasoning_Agent nor to the normal intent-handling rules.
7. IF an Action is already pending confirmation when the Reasoning_Agent requests another Action classified as `needs-confirmation`, THEN THE Confirmation_Flow SHALL hold the new request in the order received and SHALL present it only after the pending Action is confirmed, declined, or cancelled, so that no more than one Action is presented as pending at a time.
8. IF no Action is currently pending confirmation, THEN THE Confirmation_Flow SHALL treat a general affirmative utterance (for example "yes", "ok", or "just do it") as having no effect, such that no Action is executed and the utterance is not retained as authorization for any prior or later Action.
9. WHEN a user replies with a REPEAT_CONFIRMATION intent through typed text or a spoken utterance (where the Speech_Interface is active), THE Confirmation_Flow SHALL present the pending prompt again, including the information required by Acceptance Criterion 1, through the same channels used in Acceptance Criteria 2 and 3, and SHALL keep the Action pending and its position relative to any held requests unchanged.
10. WHILE an Action is pending confirmation, THE Confirmation_Flow SHALL accept exactly four kinds of reply (confirm, decline, cancel, and repeat), SHALL treat all other input as other input under Acceptance Criterion 6, and SHALL keep the Action pending with no automatic expiry until it is confirmed, declined, or cancelled.

### Requirement 7: Run and Summarize Tests via a Trusted Workflow

**User Story:** As a developer, I want to ask KiroSight to run my project's tests and summarize the results, so that I can learn the outcome without reading a full terminal transcript.

#### Acceptance Criteria

1. WHEN a user requests that tests be run, THE Confirmation_Flow SHALL request confirmation before THE Action_Dispatcher invokes the configured `RUN_TESTS` Action.
2. WHEN the user confirms a pending `RUN_TESTS` Action, THE Action_Dispatcher SHALL invoke exactly the shell command configured in the `kirosight.testCommand` user or workspace setting (for example `npm test`), without modification, substitution, or input from the Reasoning_Agent.
3. WHEN a test run invoked by the `RUN_TESTS` Action completes with the test runner reporting results, THE Action_Dispatcher SHALL report the number of tests passed and failed and the names of up to 20 failing tests.
4. IF a completed test run reports more than 20 failing tests, THEN THE Action_Dispatcher SHALL state the total number of failing tests and offer the user a path to view or hear the complete list, rather than listing all failing test names.
5. WHERE the Reasoning_Agent is available, WHEN a test run completes with failures, THE Reasoning_Agent SHALL produce a summary of the failures, limited to 5 sentences or fewer, grounded in the actual test output and grouping failures by common cause where discernible, rather than reproducing the full raw output.
6. IF a user requests that tests be run and the `kirosight.testCommand` setting is unset or empty, THEN THE Action_Dispatcher SHALL NOT invoke the `RUN_TESTS` Action and SHALL report a concise, accessible message explaining that test execution has not been configured and how to configure the `kirosight.testCommand` setting.
7. IF the `RUN_TESTS` Action's invoked process fails to execute (for example due to a missing executable or a non-test-related startup error) rather than completing with test results, THEN THE Action_Dispatcher SHALL report that the test run failed to execute and SHALL distinguish this failure from a completed run that reports failing tests.
8. THE Action_Dispatcher SHALL NOT depend on VS Code's Test Explorer API or any test-framework-specific test-running integration for the initial MVP implementation; such integration MAY be added as a future enhancement without changing the `RUN_TESTS` Action's allow-listed interface.

### Requirement 8: Typed-Text Interaction as the Baseline Input Method

**User Story:** As a developer who may not always use voice, I want every KiroSight capability available through typed text, so that I am never blocked by a voice-only feature.

#### Acceptance Criteria

1. WHEN a user submits typed-text input, via the Enter key or an equivalent accessible submit control, as a query or command, THE Text_Input_Handler SHALL route that input through the same intent-handling path used for voice input.
2. WHERE a capability is exposed through the Speech_Interface, THE Text_Input_Handler SHALL expose an equivalent typed-text path that produces the same response content, and where applicable the same Action request, as the voice-driven path, differing only in input and output modality.
3. THE Webview_Panel SHALL accept typed-text input through a text field that is reachable in the keyboard focus order, supports standard text editing and navigation keys, accepts at least 1,000 characters without truncation, and is submitted via the Enter key or an equivalent accessible submit control, without requiring the Speech_Interface to be active.
4. IF a user submits typed-text input that is empty or contains only whitespace, THEN THE Text_Input_Handler SHALL discard the submission without routing it through the intent-handling path.

### Requirement 9: Voice Interaction as an Additive Layer

**User Story:** As a blind or low-vision developer, I want to ask questions and give commands by push-to-talk voice, so that I can interact with KiroSight hands-free and without needing to type.

#### Acceptance Criteria

1. WHERE the Speech_Interface is active, WHEN a user activates push-to-talk and speaks, THE Speech_Interface SHALL capture the audio from activation until the user ends push-to-talk (by releasing the control or by activating it again to stop) or 60 seconds have elapsed, whichever occurs first, and SHALL transcribe the captured audio using Deepgram Nova-2.
2. WHEN Deepgram Nova-2 returns a non-empty transcription of the captured audio, THE Speech_Interface SHALL route the resulting text through the same intent-handling path used for typed text input and SHALL record the transcribed text in the Transcript as the user's query.
3. IF Deepgram Nova-2 transcription fails, returns no response within 10 seconds, or returns an empty transcription for the captured audio, THEN THE Speech_Interface SHALL NOT route any text through the intent-handling path, SHALL record a message in the Transcript indicating that the voice input could not be processed, and SHALL remain available for the user to submit the same query or command as typed text.
4. WHERE the Speech_Interface is active, WHEN KiroSight produces a response to a voice query, THE Speech_Interface SHALL render that response as speech using Deepgram Aura and SHALL display the full text of that response in the Transcript no later than the start of speech playback and continuously until playback ends.
5. IF Deepgram Aura playback fails or does not begin within 10 seconds of the response being produced, THEN THE Speech_Interface SHALL display the full text of the response in the Transcript, SHALL indicate to the user that spoken playback is unavailable, and SHALL continue to accept typed text input.
6. THE Speech_Interface SHALL NOT expose any capability that cannot also be invoked through typed text.
7. THE KiroSight_Extension SHALL register the Activation_Command as the VS Code command `kirosight.activate`, invocable through the command palette and through any keybinding the user assigns, with no default keybinding required, and rebindable through standard VS Code/Kiro keybinding customization, such that a single invocation opens the Webview_Panel or, if already open, moves keyboard focus to it, without requiring the user to first click or otherwise bring keyboard focus into the Webview_Panel through a separate step. Detailed activation behavior under varying microphone-permission states is specified in Requirement 18.
8. WHERE the early keybinding conflict check on the demonstration machine finds that Ctrl+Alt+K is not bound to any other command in the default Kiro/VS Code keybindings or in any extension installed on that machine, THE KiroSight_Extension SHALL include Ctrl+Alt+K in its manifest as the default keybinding for the Activation_Command on Windows and Linux.
9. IF the early keybinding conflict check on the demonstration machine finds that Ctrl+Alt+K is bound to any other command in the default Kiro/VS Code keybindings or in any extension installed on that machine, THEN THE KiroSight_Extension SHALL ship with no default keybinding for the Activation_Command on any platform.
10. THE KiroSight_Extension SHALL define no default keybinding for the Activation_Command on macOS for the MVP.

### Requirement 10: Graceful Degradation on Speech Service Failure

**User Story:** As a developer, I want KiroSight to keep working through text even if the voice services are unavailable, so that a third-party outage never makes the tool unusable.

#### Acceptance Criteria

1. IF a Deepgram Nova-2 transcription request fails (a network error, no response within 10 seconds, or an error response from Deepgram), THEN THE Speech_Interface SHALL, within 1 second of detecting the failure, add an entry to the Transcript stating that the transcription failed, SHALL continue to accept typed-text input, SHALL preserve any text already entered in the typed-text input, and SHALL leave the push-to-talk control enabled so the user can start another voice request.
2. IF a Deepgram Aura speech-synthesis request fails (a network error, no response within 10 seconds, or an error response from Deepgram), THEN THE Speech_Interface SHALL add to the Transcript the complete response text and, within 1 second of detecting the failure, a separate entry stating that spoken playback failed.
3. IF the Speech_Interface does not finish initializing or connecting within 10 seconds of session start, or fails earlier (for example due to missing credentials or an inability to reach Deepgram or the Backend_Service), THEN THE Webview_Panel SHALL add an entry to the Transcript stating that voice input and output are unavailable for the session, SHALL indicate in text (not by color alone) that push-to-talk is unavailable while keeping that control focusable, and SHALL remain fully operable through typed text.
4. IF the microphone is unavailable, microphone permission is denied, voice capture fails, or Deepgram is unavailable, THEN THE KiroSight_Extension SHALL continue to accept and execute typed commands and SHALL keep the following deterministic local features operable, with the same results as when voice is available: editor context (Requirement 1), diagnostics (Requirement 2), navigation Actions (Requirement 4), the Confirmation_Flow (Requirement 6), and the `RUN_TESTS` workflow (Requirement 7).
5. IF any interaction tier in the ordered list (1) voice interaction, (2) typed command interaction, (3) deterministic local accessibility features (the features listed in criterion 4) is unavailable, THEN THE KiroSight_Extension SHALL keep every tier that comes later in that list operable, such that a failure of tier 1 leaves tiers 2 and 3 operable and a failure of tier 2 leaves tier 3 operable.

### Requirement 11: Extension-Backend Protocol Communication

**User Story:** As a developer relying on KiroSight's AI features, I want the extension and backend to communicate over a documented, validated protocol, so that malformed or unexpected messages cannot reach IDE action handlers.

#### Acceptance Criteria

1. THE Protocol SHALL require every message, in both directions, to include a `version` field identifying the protocol version and a `type` field identifying the message's discriminator.
2. WHEN the KiroSight_Extension or the Backend_Service receives a message over the Protocol, THE Protocol_Validator SHALL validate that the message includes a `version` field matching a protocol version supported by the receiving component and a `type` field matching one of the documented message types for the direction received, and SHALL validate that the message's structure conforms to the documented schema for that `type`, before any component acts on its contents.
3. IF a message received over the Protocol cannot be parsed, is missing a required field, specifies an unsupported `version`, specifies an unrecognized `type`, or otherwise fails validation against its documented schema, THEN THE Protocol_Validator SHALL discard the message without forwarding it to any Action handler, SHALL send an error response message back to the sender indicating that validation failed, and SHALL keep the underlying WebSocket connection open.
4. THE Backend_Service SHALL bind its WebSocket server exclusively to a loopback network address (e.g., 127.0.0.1) and SHALL NOT bind to 0.0.0.0 or any non-loopback network interface.

### Requirement 12: AI-Grounded Explanation of Code and Diagnostics

**User Story:** As a blind or low-vision developer, I want KiroSight to explain an error or a piece of code in plain language, so that I understand what is wrong or what the code does without reading raw syntax.

#### Acceptance Criteria

1. WHERE the Reasoning_Agent is available, WHEN a user requests an explanation of a specific diagnostic that matches a diagnostic reported by the Diagnostics_Service, THE Reasoning_Agent SHALL produce an explanation grounded in that diagnostic's message, file, line number, and surrounding code (the diagnostic line's enclosing function or symbol when one is resolvable, otherwise the 5 lines immediately before and the 5 lines immediately after the diagnostic's line) supplied by the Context_Service and Diagnostics_Service.
2. WHERE the Reasoning_Agent is available, WHEN a user requests an explanation of the current function or selection and the Context_Service reports an enclosing function or a non-empty selection, THE Reasoning_Agent SHALL produce an explanation grounded in that code supplied by the Context_Service rather than from general knowledge unrelated to that code.
3. IF the Reasoning_Agent cannot complete a request because the underlying Amazon Bedrock call fails, THEN THE Reasoning_Agent SHALL report, in the Transcript and (WHERE the Speech_Interface is active) by voice, an error message stating that the explanation could not be generated due to a Reasoning_Agent failure, rather than retrying against a different LLM provider or returning no response.
4. IF a user requests an explanation of a specific diagnostic that does not match any diagnostic reported by the Diagnostics_Service, THEN THE Reasoning_Agent SHALL report that no matching diagnostic was found rather than producing an explanation.
5. IF a user requests an explanation of the current function or selection and the Context_Service reports neither an enclosing function nor a non-empty selection, THEN THE Reasoning_Agent SHALL report that no function or selection is available to explain rather than producing an explanation.
6. WHEN the Reasoning_Agent produces an explanation under Acceptance Criteria 1 or 2, THE Reasoning_Agent SHALL limit the initial explanation to 5 sentences or fewer and SHALL offer the user a path to request additional detail.

### Requirement 13: Bedrock as the Sole Reasoning Provider

**User Story:** As the project maintainer, I want the Reasoning_Agent restricted to a single, well-understood LLM provider, so that the system's behavior and failure modes stay predictable and auditable.

#### Acceptance Criteria

1. THE Reasoning_Agent SHALL use Amazon Bedrock as its only large-language-model provider.
2. THE Reasoning_Agent SHALL access Amazon Bedrock through an interface in `backend/app/agent/` such that automated tests can substitute a mocked client in place of a live Amazon Bedrock call to exercise agent orchestration logic.
3. THE Backend_Service SHALL NOT invoke any large-language-model provider other than Amazon Bedrock.
4. IF a call to Amazon Bedrock fails or is unavailable, THEN THE Backend_Service SHALL surface an error indication to the user through both the spoken response channel and the text transcript, and SHALL NOT automatically retry the request against any other large-language-model provider.

### Requirement 14: Accessible, Keyboard-Operable Webview Panel

**User Story:** As a blind or low-vision developer using a screen reader and keyboard, I want the KiroSight panel to be fully operable without a mouse, so that I can use every feature through my existing workflow.

#### Acceptance Criteria

1. THE Webview_Panel SHALL expose every interactive control (push-to-talk button, typed-text input field, confirmation controls, transcript region) in a single Tab/Shift+Tab-navigable sequence that matches the panel's visual top-to-bottom reading order, with no control skipped and no control receiving focus more than once per full forward or backward traversal.
2. WHEN a control in the Webview_Panel receives keyboard focus, THE Webview_Panel SHALL, within 100 milliseconds, render a focus indicator with a minimum 2-pixel-wide outline and a minimum 3:1 contrast ratio against the control's adjacent background, and SHALL expose that control's accessible name, role, and focus state to assistive technology.
3. WHEN the Webview_Panel's listening, processing, error, success, or confirmation-pending state changes, THE Webview_Panel SHALL, within 500 milliseconds of the change, update the visible text label for that state and update an accessible live region so the change is announced to assistive technology without requiring the user to move focus or re-query the state.
4. THE Webview_Panel SHALL use semantic HTML and ARIA roles so that a screen reader can read its content directly, independent of KiroSight's voice layer.
5. THE Webview_Panel SHALL NOT override or capture standard screen reader navigation input (including arrow-key browse-mode navigation, Tab, Shift+Tab, and screen-reader-specific shortcuts) except for the keyboard activation of its own interactive controls, and SHALL NOT disable or suppress the user's screen reader's virtual cursor or reading mode.
6. WHEN a control in the Webview_Panel has keyboard focus, THE Webview_Panel SHALL activate that control upon an Enter key press, and SHALL additionally activate button-type controls upon a Space key press.

### Requirement 15: Persistent Text Transcript

**User Story:** As a developer who relies on my own screen reader rather than synthesized speech, I want a full text record of every query and response, so that I never lose information to a spoken-only response.

#### Acceptance Criteria

1. WHEN a user submits a query or command through typed text or transcribed voice input, THE Webview_Panel SHALL append that query to the Transcript, labeled as originating from the user, preserving the chronological order of all existing Transcript entries.
2. WHEN KiroSight produces a response to a query or command, THE Webview_Panel SHALL append that response's full text to the Transcript, labeled as originating from KiroSight, immediately following the corresponding query entry.
3. WHEN the Speech_Interface begins rendering a spoken response, THE Webview_Panel SHALL display that response's full text in the Transcript no later than the onset of audio playback, rather than only after playback completes.
4. THE Transcript SHALL remain visible, reachable via the user's screen reader's standard reading and navigation commands, and SHALL expose newly appended entries through an accessible live region, for the entire duration of the Webview_Panel session, independent of whether the Speech_Interface is active.

### Requirement 16: Concise, Concrete Response Content

**User Story:** As a blind or low-vision developer, I want KiroSight's answers to be short and specific, so that I can quickly act on them instead of parsing a long, vague summary.

#### Acceptance Criteria

1. WHEN KiroSight reports a diagnostic for which an enclosing function or symbol name is available, THE Response_Formatter SHALL include the file name, line number, and enclosing function or symbol name, rather than a generic reference to the diagnostic's location.
2. IF KiroSight reports a diagnostic for which no enclosing function or symbol name is available, THEN THE Response_Formatter SHALL include the file name and line number without a symbol name, rather than omitting the diagnostic's location.
3. WHEN KiroSight reports test results, THE Response_Formatter SHALL summarize the pass/fail counts and list up to 5 failing test names, rather than reproducing the full raw test-runner output.
4. IF a test run reports more than 5 failing tests, THEN THE Response_Formatter SHALL state the total number of failing tests and offer the user a path to view or hear the complete list of failing test names, rather than enumerating all failing test names in the summary.
5. WHEN KiroSight reports a completed Action, THE Response_Formatter SHALL state the concrete outcome of that Action (for example which file was opened or which diagnostic was reached), rather than a generic acknowledgment.
6. IF an Action fails to execute or is declined by the user, THEN THE Response_Formatter SHALL state the specific reason for the failure or decline (for example that the user declined the Action, or that the requested file was not found), rather than a generic acknowledgment.

### Requirement 17: Secrets and Configuration Management

**User Story:** As the project maintainer, I want API keys and credentials kept out of source control and out of the webview, so that KiroSight does not leak secrets.

#### Acceptance Criteria

1. THE Backend_Service SHALL load Deepgram and Amazon Bedrock credentials from environment variables at runtime rather than from values committed to source control.
2. THE KiroSight_Extension SHALL store any secret values it holds locally (such as API keys or authentication tokens) using the VS Code `SecretStorage` API rather than embedding them in Webview_Panel code or any other extension source file.
3. THE repository SHALL exclude from version control, through `.gitignore`, all `.env` files, dependency directories (including `node_modules` and Python virtual environment directories), Python bytecode cache directories (`__pycache__`), and build output directories.
4. THE repository SHALL maintain a documented list of every environment variable name required by the Backend_Service and the KiroSight_Extension, without including real credential values, and SHALL keep that list consistent with the environment variables actually referenced in the Backend_Service and KiroSight_Extension source code.
5. IF a required credential environment variable is missing or empty when the Backend_Service attempts to initialize a Deepgram or Amazon Bedrock client, THEN THE Backend_Service SHALL NOT attempt to call that provider and SHALL surface an error indicating which credential is missing, while leaving unrelated Backend_Service functionality operable.
6. THE Backend_Service and KiroSight_Extension SHALL exclude credential values from any diagnostic, debug, or console log output they produce.

### Requirement 18: Keyboard Activation and Microphone Permission Handling

**User Story:** As a blind or low-vision developer, I want the activation command to always leave me in a usable state regardless of microphone permission status, so that invoking it never strands me or fails silently.

#### Acceptance Criteria

1. WHEN a user invokes the Activation_Command and the Webview_Panel is not already open, THE KiroSight_Extension SHALL open and focus the Webview_Panel.
2. WHEN a user invokes the Activation_Command and the Speech_Interface is available and microphone permission has already been granted, THE KiroSight_Extension SHALL begin push-to-talk listening as part of handling that invocation.
3. IF a user invokes the Activation_Command and microphone permission has not yet been granted, THEN THE KiroSight_Extension SHALL present an accessible, keyboard-operable microphone permission request to the user, SHALL leave the Webview_Panel fully operable through typed text while permission is pending or undetermined, and SHALL NOT block the user from submitting typed-text queries or commands during this time.
4. IF a user invokes the Activation_Command and the Speech_Interface is unavailable (for example because the Backend_Service, Deepgram, or microphone hardware cannot be reached), THEN THE KiroSight_Extension SHALL open or focus the Webview_Panel, SHALL record in the Transcript that voice is unavailable, and SHALL leave the Webview_Panel fully operable through typed text.
5. THE Activation_Command SHALL complete successfully, opening or focusing the Webview_Panel, regardless of whether microphone permission is granted, denied, undetermined, or whether the Speech_Interface is available; a failure to begin voice capture SHALL NOT cause the Activation_Command itself to fail or report an error in place of opening the panel.
6. WHEN a user grants microphone permission after a prior denial or undetermined state, THE KiroSight_Extension SHALL allow subsequent invocations of the Activation_Command to begin push-to-talk listening per Acceptance Criterion 2, without requiring the Webview_Panel to be reloaded or the extension to be restarted.

### Requirement 19: Webview and Extension-Host Communication Boundary

**User Story:** As the project maintainer, I want the Webview_Panel restricted to UI rendering, audio playback, and (preferably) microphone capture, so that backend communication and secrets stay isolated from inspectable webview code.

#### Acceptance Criteria

1. THE Webview_Panel SHALL be responsible only for audio playback, rendering the user interface (push-to-talk control, typed-text input, confirmation controls, Transcript), and, as the preferred VoiceInput implementation (subject to Acceptance Criterion 6), microphone audio capture; it SHALL NOT implement the WebSocket client that connects to the Backend_Service.
2. THE KiroSight_Extension host process, not the Webview_Panel, SHALL own and maintain the WebSocket connection to the Backend_Service described in Requirement 11.
3. THE Webview_Panel SHALL communicate with the KiroSight_Extension host process exclusively through the VS Code webview `postMessage` API (and its corresponding message-receiving handler), and SHALL open zero network connections of its own to the Backend_Service or any other external service.
4. THE Webview_Panel SHALL NOT contain, embed, or receive in any message from the KiroSight_Extension host process, Deepgram or Amazon Bedrock credentials or any other secret value (API key, token, or password); such credentials SHALL remain confined to the Backend_Service and (where applicable) the KiroSight_Extension host process's use of `SecretStorage`, consistent with Requirement 17.
5. WHEN the KiroSight_Extension host process receives captured audio, or a typed-text submission that the deterministic local intent routing cannot handle and that must therefore be sent to the Reasoning_Agent or the Speech_Interface, from the Webview_Panel via `postMessage`, THE KiroSight_Extension host process SHALL begin relaying that data to the Backend_Service over the Protocol within 500 milliseconds of receipt, preserving the order in which it was received, and SHALL relay each Backend_Service response back to the Webview_Panel via `postMessage` within 500 milliseconds of receiving it. Typed-text submissions handled by the deterministic local intent routing (Requirements 1, 2, 4, 6, and 7) are processed locally by the KiroSight_Extension host process and are not relayed to the Backend_Service.
6. IF the early microphone capture check (a time-boxed check performed during development, before voice work begins) finds Webview_Panel microphone capture unreliable, THEN THE Speech_Interface SHALL obtain microphone audio through a backend-local VoiceInput implementation in which the Backend_Service, rather than the Webview_Panel, records the audio, selected behind the VoiceInput interface. Webview_Panel microphone capture SHALL be deemed unreliable if either (a) microphone permission is denied or microphone capture is unavailable in the Webview_Panel, or (b) the KiroSight_Extension host process does not receive, via `postMessage`, at least one audio sample of non-zero length within 5 seconds of the Webview_Panel starting capture.
7. THE Speech_Interface SHALL route text transcribed from any VoiceInput implementation through the same intent-handling path used for typed text, such that, for identical text, the resulting intent routing, confirmation prompts, and accessibility outputs are identical regardless of which VoiceInput implementation produced the text.
8. WHERE a backend-local VoiceInput implementation is selected, THE Speech_Interface SHALL keep Deepgram and Amazon Bedrock credentials out of the Webview_Panel and out of the KiroSight_Extension source, consistent with Requirement 17.
9. IF the WebSocket connection to the Backend_Service is not open when the KiroSight_Extension host process receives audio, or typed text that the local intent routing cannot handle, from the Webview_Panel, THEN THE KiroSight_Extension host process SHALL send the Webview_Panel, within 2 seconds of receipt, a `postMessage` indicating that the Backend_Service is unavailable, SHALL NOT relay the data, and SHALL leave the submitted typed text available in the Webview_Panel's typed-text input for resubmission. Typed commands that are handled locally (Requirements 1, 2, 4, 6, and 7) are not relayed to the Backend_Service and are unaffected by the Backend_Service being unavailable.
10. IF the KiroSight_Extension host process receives a `postMessage` from the Webview_Panel that is not one of the message types defined for the Webview_Panel-to-host interface, THEN THE KiroSight_Extension host process SHALL discard the message without relaying it to the Backend_Service.

## Non-Goals for This MVP

- **No arbitrary shell/OS commands generated by AI.** The Reasoning_Agent cannot supply free-form shell or command text (Requirement 5); there is no `RUN_COMMAND(command: string)`-shaped action, no arbitrary OS control, and no mouse automation of any kind.
- **No screenshot-driven or computer-vision analysis.** Structured IDE state via VS Code Extension APIs (Requirements 1 through 3) is the sole source of truth for this MVP; no screenshot capture or vision-based UI control is in scope.
- **No fully autonomous coding and no automatic code modification.** Code-modifying Actions (for example "fix this error" or "make this change") are explicitly out of scope for this MVP. If built in a later iteration, such an Action must go through the same Allowlist_Registry and Confirmation_Flow as every other state-changing Action described in Requirements 5 and 6, with no shortcut.
- **No remote-hosted backend.** The Backend_Service binds to a loopback address only (Requirement 11) and is not deployed as a network-accessible service for this MVP.
- **No multiple LLM providers.** Amazon Bedrock is the sole reasoning provider (Requirement 13); no fallback or secondary LLM provider is introduced even on failure.
- **Out of scope / Stretch: voice-driven symbol navigation.** A `GO_TO_SYMBOL` Action and arbitrary "go to function foo" navigation are not part of the MVP; Requirement 4 covers going to a specific line only. Initial implementation tasks must not include or depend on `GO_TO_SYMBOL`. If built later, it must be added to the Allowlist_Registry deliberately with a `safe` risk classification and Requirement 4 must be amended at that time. Current-symbol detection for description and explanation context (Requirements 1.3, 1.4, and 12) is unaffected.
- **Post-MVP: read-only questions during a pending confirmation.** While an Action is pending confirmation, the Confirmation_Flow accepts only confirm, decline, cancel, and repeat replies (Requirement 6). Answering arbitrary read-only questions during a pending confirmation is a post-MVP enhancement.
- **No screen-reader replacement.** KiroSight is not a replacement for the user's screen reader; Requirement 14 and Requirement 15 exist specifically to preserve coexistence rather than to reimplement screen reader functionality.
