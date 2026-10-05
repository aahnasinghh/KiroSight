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

Requirements below are organized by capability, not strictly by milestone, but each requirement states which milestone's components it depends on so implementation order can follow the staged build described in `tech.md`. Code-modifying actions (for example "fix this error" or "make this change") are explicitly out of scope for this MVP and are called out as a non-goal at the end of this document.

## Glossary

- **KiroSight_Extension**: The TypeScript VS Code/Kiro extension process. The only component with direct access to Kiro/VS Code editor, workspace, diagnostics, Git, and terminal state.
- **Backend_Service**: The local Python FastAPI + WebSocket process that orchestrates the Reasoning_Agent and the Speech_Interface. Introduced starting at Milestone 2. Not deployed remotely; binds to localhost only.
- **Context_Service**: The component within the KiroSight_Extension responsible for reading current file, cursor position, selection, and open editor state via VS Code Extension APIs and formatting it into plain data structures.
- **Diagnostics_Service**: The component within the KiroSight_Extension responsible for reading diagnostics (errors/warnings) via `vscode.languages.getDiagnostics` and formatting them into plain data structures.
- **Git_Status_Service**: The component within the KiroSight_Extension responsible for reading Git state (changed files, branch, ahead/behind) via VS Code's built-in Git extension API or an equivalent fallback.
- **Action_Dispatcher**: The component within the KiroSight_Extension that executes allow-listed Actions (for example `openFile`, `goToDiagnostic`, `runTests`, `readSelection`) requested by the user or by the Reasoning_Agent.
- **Activation_Command**: The VS Code command `kirosight.activate`, bound by default to Ctrl+Alt+K on Windows and Linux, and rebindable by the user through standard VS Code/Kiro keybinding customization. Invocable from anywhere in the editor, without first requiring keyboard focus inside the Webview_Panel. Opens or focuses the Webview_Panel and, where microphone permission has already been granted and the Speech_Interface is available, begins push-to-talk capture; otherwise leaves the user in a fully keyboard/text-operable state (see Requirement 18).
- **Allowlist_Registry**: The single, documented location (`backend/app/allowlist.py`) listing every Action the Reasoning_Agent may request, together with its risk classification (`safe` or `needs-confirmation`).
- **kirosight.testCommand**: The trusted VS Code user/workspace configuration setting holding the exact shell command the `RUN_TESTS` Action executes (for example `npm test`). Supplied only by the user or workspace configuration, never by the Reasoning_Agent.
- **Confirmation_Flow**: The interaction sequence that presents a pending destructive or state-changing Action to the user, in both the Webview_Panel and (when the Speech_Interface is active) by voice, and requires explicit user confirmation before the Action_Dispatcher executes it.
- **Reasoning_Agent**: The Amazon Bedrock-backed component, running inside the Backend_Service behind an interface in `backend/app/agent/`, that produces explanations, summaries, and Action requests grounded in IDE state supplied by the KiroSight_Extension. The sole LLM provider for the MVP; no fallback provider exists.
- **Speech_Interface**: The component spanning the Webview_Panel (microphone capture and audio playback UI), the KiroSight_Extension host process (relaying captured audio and playback requests between the Webview_Panel and the Backend_Service), and the Backend_Service (streaming audio to Deepgram Nova-2 for speech-to-text and rendering Reasoning_Agent responses through Deepgram Aura for text-to-speech).
- **Text_Input_Handler**: The component that accepts typed text from the Webview_Panel and routes it through the same intent-handling path used for voice input.
- **Webview_Panel**: The accessible VS Code Webview side panel, built with plain HTML/CSS/TypeScript, that hosts the push-to-talk control, the typed-text input, and the Transcript, and is responsible only for microphone audio capture, audio playback, and UI rendering. The Webview_Panel communicates with the rest of the KiroSight_Extension exclusively through the VS Code webview `postMessage` API; it does not hold any Deepgram or Amazon Bedrock credentials and does not open its own connection to the Backend_Service (see Requirement 19).
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

### Requirement 4: Navigate Files, Diagnostics, and Symbols

**User Story:** As a blind or low-vision developer, I want to open files and jump to specific errors or symbols by command, so that I can move through my project without manual tree navigation.

#### Acceptance Criteria

1. WHEN a user requests to open a named file that matches exactly one file in the current workspace, THE Action_Dispatcher SHALL open that file in the editor and report the file path that was opened.
2. IF a user requests to open a file that does not exist in the current workspace, THEN THE Action_Dispatcher SHALL report that the file was not found rather than opening an unrelated file.
3. IF a user requests to open a file name that matches more than one file in the current workspace, THEN THE Action_Dispatcher SHALL report the list of matching file paths and request clarification rather than opening an arbitrarily selected match.
4. WHEN a user requests to go to a specific diagnostic identified by ordinal position or description (for example "the first error"), THE Action_Dispatcher SHALL resolve the requested ordinal or description against the diagnostics reported by the Diagnostics_Service ordered by ascending file path and then ascending line number, move the editor cursor to that diagnostic's file and line, and report the file path, line number, severity, and message text of the diagnostic reached.
5. IF a user requests to go to a specific diagnostic and no diagnostic matches the requested ordinal position or description, THEN THE Action_Dispatcher SHALL report that no matching diagnostic was found rather than moving the cursor without feedback.
6. WHEN a user requests to go to a specific line or symbol in the active file, THE Action_Dispatcher SHALL move the editor cursor to that line or symbol and report the file path and line number reached.
7. IF a user requests to go to a specific line or symbol and no editor is currently active, the requested line number falls outside the active file's line range, or the requested symbol name does not match any symbol in the active file, THEN THE Action_Dispatcher SHALL report that the requested location could not be found rather than moving the cursor.
8. THE Action_Dispatcher SHALL implement each navigation Action in Acceptance Criteria 1 through 7 as a specific, named handler rather than a generic passthrough that accepts arbitrary command strings.

### Requirement 5: Enforce the Autonomous Action Allow-List

**User Story:** As a developer relying on an AI agent inside my IDE, I want the agent restricted to a fixed set of known actions, so that it cannot execute arbitrary or unintended operations against my project.

#### Acceptance Criteria

1. THE Allowlist_Registry SHALL define, in one documented location, every Action the Reasoning_Agent may request and each such Action's risk classification of exactly one of `safe` or `needs-confirmation`.
2. WHEN the Reasoning_Agent requests an Action that is present in the Allowlist_Registry and classified as `safe`, THE Action_Dispatcher SHALL execute that Action according to its documented handler.
3. WHEN the Reasoning_Agent requests an Action that is present in the Allowlist_Registry and classified as `needs-confirmation`, THE Action_Dispatcher SHALL request explicit user confirmation before invoking that Action's documented handler, and SHALL invoke the handler only upon receiving that confirmation.
4. IF a user does not provide confirmation for an Action classified as `needs-confirmation`, THEN THE Action_Dispatcher SHALL NOT invoke that Action's handler and SHALL leave IDE and workspace state unchanged.
5. IF the Reasoning_Agent requests an Action that is not present in the Allowlist_Registry, THEN THE Action_Dispatcher SHALL reject the request without invoking any handler and SHALL return a response to the Reasoning_Agent indicating that the requested Action is not permitted.
6. THE Allowlist_Registry SHALL NOT include an Action shaped so that its underlying shell or process command is supplied as free-form text by the Reasoning_Agent.
7. WHERE an Action invokes a shell or process command (for example the `RUN_TESTS` Action invoking the command configured in `kirosight.testCommand`), THE Action_Dispatcher SHALL source that command from trusted extension/workspace configuration rather than from Reasoning_Agent-generated text, and THE Reasoning_Agent SHALL have no ability to supply or alter that command's content.

### Requirement 6: Confirm Destructive or State-Changing Actions

**User Story:** As a developer, I want to approve any action that changes my files, runs code, or modifies Git state before it happens, so that the agent never surprises me with an unreviewed change.

#### Acceptance Criteria

1. WHEN the Reasoning_Agent requests an Action classified as `needs-confirmation` in the Allowlist_Registry, THE Confirmation_Flow SHALL present the pending Action's name and the specific target(s) and change(s) it will produce (for example the affected file path, line range, branch, or test command) to the user before the Action_Dispatcher executes it.
2. THE Confirmation_Flow SHALL surface every pending Action, including the information required by Acceptance Criterion 1, in the Webview_Panel.
3. WHERE the Speech_Interface is active, THE Confirmation_Flow SHALL additionally surface the pending Action by a spoken prompt containing the same information presented in the Webview_Panel.
4. WHEN a user confirms a pending Action through typed text, keyboard activation, or a spoken confirmation utterance (where the Speech_Interface is active), THE Action_Dispatcher SHALL execute that Action.
5. WHEN a user declines a pending Action through typed text, keyboard activation, or a spoken decline utterance (where the Speech_Interface is active), THE Action_Dispatcher SHALL discard the pending Action without executing it.
6. IF a user's response to a pending confirmation request is not recognized as a confirmation or a decline, THEN THE Confirmation_Flow SHALL keep the Action pending and SHALL prompt the user again rather than executing or discarding the Action.
7. IF an Action is already pending confirmation when the Reasoning_Agent requests another Action classified as `needs-confirmation`, THEN THE Confirmation_Flow SHALL hold the new request until the pending Action is confirmed or declined, rather than presenting more than one pending Action at a time.
8. IF no Action is currently pending confirmation, THEN THE Confirmation_Flow SHALL treat a general affirmative utterance (for example "just do it") as having no effect, rather than authorizing a prior or future Action.

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

1. WHERE the Speech_Interface is active, WHEN a user activates push-to-talk and speaks, THE Speech_Interface SHALL capture the audio and transcribe it using Deepgram Nova-2.
2. WHEN Deepgram Nova-2 returns a non-empty transcription of the captured audio, THE Speech_Interface SHALL route the resulting text through the same intent-handling path used for typed text input and SHALL record the transcribed text in the Transcript as the user's query.
3. IF Deepgram Nova-2 transcription fails, is unavailable, or returns no detectable speech in the captured audio, THEN THE Speech_Interface SHALL NOT route any text through the intent-handling path, SHALL record a message in the Transcript indicating that the voice input could not be processed, and SHALL remain available for the user to submit the same query or command as typed text.
4. WHERE the Speech_Interface is active, WHEN KiroSight produces a response to a voice query, THE Speech_Interface SHALL render that response as speech using Deepgram Aura while simultaneously displaying the full text of that response in the Transcript, including for the duration of speech playback.
5. IF Deepgram Aura playback fails or is unavailable, THEN THE Speech_Interface SHALL display the full text of the response in the Transcript and SHALL indicate to the user that spoken playback is unavailable, without blocking the user's ability to continue interacting via typed text.
6. THE Speech_Interface SHALL NOT expose any capability that is unreachable through typed text.
7. THE KiroSight_Extension SHALL register the Activation_Command as the VS Code command `kirosight.activate`, bound by default to Ctrl+Alt+K on Windows and Linux, rebindable by the user through standard VS Code/Kiro keybinding customization, such that invoking it opens or focuses the Webview_Panel without requiring the user to first click or otherwise bring keyboard focus into the Webview_Panel through a separate step. Detailed activation behavior under varying microphone-permission states is specified in Requirement 18.

### Requirement 10: Graceful Degradation on Speech Service Failure

**User Story:** As a developer, I want KiroSight to keep working through text even if the voice services are unavailable, so that a third-party outage never makes the tool unusable.

#### Acceptance Criteria

1. IF a Deepgram Nova-2 transcription request fails (for example due to a network error, timeout, or an error response from Deepgram), THEN THE Speech_Interface SHALL report that the transcription failed in the Transcript, SHALL continue to accept typed-text input, and SHALL leave the push-to-talk control available for the user to attempt another voice request.
2. IF a Deepgram Aura speech-synthesis request fails (for example due to a network error, timeout, or an error response from Deepgram), THEN THE Speech_Interface SHALL record in the Transcript both the full response text and an indication that spoken playback failed, rather than only displaying the response text without noting the failure.
3. IF the Speech_Interface fails to initialize or connect at session start (for example due to missing credentials or an inability to reach Deepgram or the Backend_Service), THEN THE Webview_Panel SHALL record in the Transcript that voice input and output are unavailable for the session and SHALL remain fully operable through typed text.

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

**User Story:** As the project maintainer, I want the Webview_Panel restricted to microphone capture and UI rendering, so that backend communication and secrets stay isolated from inspectable webview code.

#### Acceptance Criteria

1. THE Webview_Panel SHALL be responsible only for microphone audio capture, audio playback, and rendering the user interface (push-to-talk control, typed-text input, confirmation controls, Transcript); it SHALL NOT implement the WebSocket client that connects to the Backend_Service.
2. THE KiroSight_Extension host process, not the Webview_Panel, SHALL own and maintain the WebSocket connection to the Backend_Service described in Requirement 11.
3. THE Webview_Panel SHALL communicate with the KiroSight_Extension host process exclusively through the VS Code webview `postMessage` API (and its corresponding message-receiving handler), rather than opening its own network connection to the Backend_Service or any other external service.
4. THE Webview_Panel SHALL NOT contain, embed, or have access to Deepgram or Amazon Bedrock credentials or any other secret value; such credentials SHALL remain confined to the Backend_Service and (where applicable) the KiroSight_Extension host process's use of `SecretStorage`, consistent with Requirement 17.
5. WHEN the KiroSight_Extension host process receives captured audio or a typed-text submission from the Webview_Panel via `postMessage`, THE KiroSight_Extension host process SHALL relay that data to the Backend_Service over the Protocol on the Webview_Panel's behalf, and SHALL relay the Backend_Service's response back to the Webview_Panel via `postMessage`.

## Non-Goals for This MVP

- **No arbitrary shell/OS commands generated by AI.** The Reasoning_Agent cannot supply free-form shell or command text (Requirement 5); there is no `RUN_COMMAND(command: string)`-shaped action, no arbitrary OS control, and no mouse automation of any kind.
- **No screenshot-driven or computer-vision analysis.** Structured IDE state via VS Code Extension APIs (Requirements 1 through 3) is the sole source of truth for this MVP; no screenshot capture or vision-based UI control is in scope.
- **No fully autonomous coding and no automatic code modification.** Code-modifying Actions (for example "fix this error" or "make this change") are explicitly out of scope for this MVP. If built in a later iteration, such an Action must go through the same Allowlist_Registry and Confirmation_Flow as every other state-changing Action described in Requirements 5 and 6, with no shortcut.
- **No remote-hosted backend.** The Backend_Service binds to a loopback address only (Requirement 11) and is not deployed as a network-accessible service for this MVP.
- **No multiple LLM providers.** Amazon Bedrock is the sole reasoning provider (Requirement 13); no fallback or secondary LLM provider is introduced even on failure.
- **No screen-reader replacement.** KiroSight is not a replacement for the user's screen reader; Requirement 14 and Requirement 15 exist specifically to preserve coexistence rather than to reimplement screen reader functionality.
