# KiroSight accessibility review checklist

This is a manual checklist. A person has to run every step with the keyboard, a screen reader and the themes named below. Nothing in this file has been run by the tooling, and every result box starts empty.

**What this checklist cannot do.** Automated tests (Vitest with jsdom) prove DOM structure, focus targets, text content and which regions are live. They do not prove what a screen reader says, how a theme renders, or whether the product is usable. Full WCAG validation needs testing with assistive technology and review by an accessibility expert. Passing this checklist is evidence for the demo, not a conformance claim.

Related requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 15.4.

## Current status: NOT TESTED

| Section | Status |
|---|---|
| 1 Keyboard-only walkthrough | NOT TESTED |
| 2 Screen reader pass (NVDA, JAWS or VoiceOver) | NOT TESTED |
| 3 Speech off and backend stopped | NOT TESTED |
| 4 Focus indicator contrast and high contrast | NOT TESTED |

This checklist is written but has not been executed. No keyboard, screen reader, high-contrast or contrast measurement result is recorded here. Executing it is pending and is required before final demo sign-off (Task 10.10). Change a status only after you have run that section yourself.

## How to use this document

- Work top to bottom. Tick a box only after you observed the result yourself.
- When a step fails, write what you saw in the Notes line. Do not tick it.
- Fill in the record below before you start, so a result can be repeated.

| Item | Value |
|---|---|
| Date | |
| Tester | |
| Kiro version | |
| KiroSight commit or build | |
| Operating system | |
| Screen reader and version | |
| Speech voice or rate (screen reader) | |
| Themes tested | |

## 0. Setup

1. Open the `demo-project/` folder as the workspace root (File, Open Folder). It holds one deliberate type error and one failing test.
2. Trust the workspace. `kirosight.testCommand` is a restricted setting and is ignored in an untrusted workspace.
3. Start the backend, or confirm the extension starts it, so the panel shows a connected backend. Typed commands do not need it, but section 4 compares both states.
4. Open the command palette and run `KiroSight: Activate`. On Windows and Linux `Ctrl+Alt+K` does the same. On macOS there is no default keybinding, so use the palette.

- [ ] The KiroSight panel opened and the cursor is in the Command field.

Notes:

## 1. Keyboard-only walkthrough

Put the mouse and trackpad aside. Do not use them for the whole section. Use the screen reader only if you need it to know where you are. Section 2 repeats the main steps with the screen reader as the focus.

### 1.1 Tab order and controls (Req 14.1)

Press `Tab` from the Command field, then keep going. Then press `Shift+Tab` back the same way.

Expected forward order with no confirmation showing: Transcript, Command field, Send, Push to talk. This matches the top to bottom reading order. While a confirmation is showing the order is: Transcript, Confirm, Decline, Command field, Send, Push to talk. The confirmation prompt text itself is not a Tab stop; it receives focus from the panel when it appears.

- [ ] Every control is reachable with Tab and Shift+Tab, in the order above.
- [ ] No control is skipped.
- [ ] No control gets focus twice in one pass.
- [ ] Focus never disappears into the page (a point where nothing seems focused).
- [ ] Focus can leave the panel with the usual Kiro shortcuts (for example the editor group or view switching keys) and come back.

Notes:

### 1.2 Activating controls (Req 14.6)

| Control | Keys to test | Expected |
|---|---|---|
| Command field | type text, then `Enter` | The command is sent. |
| Send | `Enter`, then `Space` | The command is sent once per key press. |
| Push to talk | `Enter`, then `Space` | Starts or stops listening when voice is available. When voice is unavailable it starts nothing and the status line states the reason. |
| Confirm | `Enter`, then `Space` | Confirms the pending action. |
| Decline | `Enter`, then `Space` | Declines it. |
| Any control | `Escape` | Stops speech and interrupts the pending request. |

- [ ] Enter activates each control above.
- [ ] Space activates each button above (Send, Push to talk, Confirm, Decline).
- [ ] Escape stops speech and does not cause any other change.
- [ ] Each activation happens once, not twice.

Notes:

### 1.3 Focus movement (Req 14.1, 14.3)

- [ ] Open the panel with `KiroSight: Activate`. Focus lands in the Command field.
- [ ] Focus Send with Tab and press Enter with some text typed. Focus returns to the Command field.
- [ ] Type a draft but do not send it, then trigger a confirmation (see 1.4). The draft is still there afterwards.
- [ ] When a confirmation appears, focus moves to the prompt text.
- [ ] After you press Confirm or Decline, focus is in the Command field and not lost.
- [ ] Typing "run my tests" twice in a row (decline in between) moves focus to the prompt both times.

Notes:

### 1.4 Demo journey by keyboard only

Type each command into the Command field and press Enter. Read the answer in the Transcript (Tab to it, then use your normal reading keys, or look at it).

1. [ ] `where am I` gives a concrete answer naming the file, line and function.
2. [ ] `what errors are there` names the type error in `cart.ts` with file, line and function.
3. [ ] `go to the first error` moves the editor cursor to that error. Check with the editor that the cursor moved.
4. [ ] `explain this error` is routed to the backend agent, not answered locally. Live Bedrock verification is still pending (Task 7.14), so record which of these happened: a short grounded answer (backend and Bedrock available), or a clear stated error with typed local commands still working (Bedrock or the backend unavailable). Either is acceptable for this checklist; a hang or silence is not.
5. [ ] `run my tests` shows a confirmation prompt that names the exact command.
6. [ ] Press Decline. The tests do not run. Ask again.
7. [ ] Press Confirm. The tests run and a short pass and fail summary appears. The summary names how many passed and how many failed.
8. [ ] `help` (also `what can you do`) lists the supported local commands. This is a local command and works with the backend stopped.

Phrases checked against the local router: `where am I`, `what errors are there`, `go to the first error` (first, second and third are accepted), `open discount.ts`, `run my tests`, `help`. The file `discount.ts` is `demo-project/src/discount.ts`.

Notes:

## 2. Screen reader pass (Req 14.3, 14.4, 15.4)

Use NVDA or JAWS on Windows, or VoiceOver on macOS. Record the screen reader and version at the top. Turn KiroSight speech off first for 2.1 to 2.5 (see section 3) so you hear only the screen reader.

### 2.1 Structure (Req 14.4)

Use the screen reader's own navigation: headings, landmarks and form field lists, not KiroSight.

- [ ] There is one main landmark and the page heading "KiroSight".
- [ ] Headings exist for Transcript and Latest response (and Confirmation required while a confirmation is showing).
- [ ] The Transcript is announced with the name "Transcript" and as a log.
- [ ] The Command field is announced with the name "Command" and as an edit field.
- [ ] Send, Confirm and Decline are announced as buttons with those names.
- [ ] Push to talk is announced as a button, with its pressed state, and its explanation (the note text) is read or can be read.
- [ ] When voice is unavailable, Push to talk is still found by Tab and says that it is unavailable, and why.

Notes:

### 2.2 The transcript is read (Req 15.4)

- [ ] Send two or three commands. Move to the Transcript with Tab and read it line by line with the screen reader's normal reading commands. Each line starts with who it is from ("You", "KiroSight" or "System").
- [ ] Browse or virtual cursor mode still works inside the panel. Arrow keys read lines. KiroSight does not take over any screen reader key.
- [ ] Older entries are still there after the panel has been hidden and shown again.

Notes:

### 2.3 New entries are announced once (Req 14.3, 15.4)

Send `where am I` and listen without touching the keyboard.

- [ ] The answer is announced once, not twice (the Latest response block must not repeat it).
- [ ] The status change (for example Processing, then Idle) is announced once per change, and does not repeat when nothing changed.
- [ ] Nothing re-reads the whole transcript when one entry is added.
- [ ] The wording heard matches the visible text.

Notes:

### 2.4 Confirmation prompt (Req 14.3)

Send `run my tests`.

- [ ] The prompt is announced, and it names the exact command that will run.
- [ ] Keyboard focus is on the prompt text when it is announced.
- [ ] Tab reaches Confirm, then Decline, with their names announced.
- [ ] After Decline, focus is back in the Command field and it is announced.
- [ ] The status line says "Confirmation pending" (or the equivalent text) while it is showing, and that is not announced a second time without a change.

Notes:

### 2.5 Status text (Req 14.3)

Check that every state has words, not just a look or a sound. Trigger each state you can.

| State | How to see it | Text seen | Announced once |
|---|---|---|---|
| Idle | open the panel | | [ ] |
| Processing | send a command that takes a moment | | [ ] |
| Listening | start Push to talk (voice available) | | [ ] |
| Speaking | with speech on and Deepgram configured, send a voice command (speech is spoken only for voice requests); mark NOT TESTED if no Deepgram key is available | | [ ] |
| Confirmation pending | `run my tests` | | [ ] |
| Error | stop the backend, then ask `explain this error` | | [ ] |
| Voice unavailable | start with no microphone or voice off | | [ ] |

Notes:

## 3. Operation with speech off and with the backend stopped

### 3.1 Speech (TTS) disabled

1. Open Settings and set `kirosight.voice.enabled` to false (or leave the Deepgram variables unset so speech is unavailable).
2. Reload the window if the setting says so.

- [ ] The panel opens and every command in 1.4 still works by typing.
- [ ] The full text of each answer is in the Transcript.
- [ ] Nothing is spoken by KiroSight. Your own screen reader still reads everything.
- [ ] When speech is unavailable and not just off, a text note says so and nothing else breaks.

Notes:

### 3.2 Backend stopped

1. Stop the Python backend, or run the panel without starting it.
2. Reload the window.

- [ ] The panel opens and the status line says in words that the backend is not running.
- [ ] `where am I`, `what errors are there`, `go to the first error`, `open discount.ts` (opens `demo-project/src/discount.ts`), `run my tests` and `help` still work with the backend stopped.
- [ ] A question that needs the backend (for example `explain this error`) gives a clear stated reason and does not hang.
- [ ] Your typed draft is not lost when that message appears.
- [ ] Starting the backend again (`KiroSight: Start Backend` or your usual way) reconnects and the status line says so.

Notes:

## 4. Focus indicator contrast (Req 14.2)

The requirement is an outline at least 2 pixels wide with at least 3:1 contrast against the control's adjacent background. KiroSight draws a 3 pixel outline in the theme's focus color, with a fixed fallback (`#0078d4`) used only if a theme defines none. The theme's own color depends on the theme, so it has to be checked by hand.

### How to measure

1. Run `Developer: Open Webview Developer Tools` from the command palette.
2. In the Elements panel, select a control (for example the Command field) and focus it with the keyboard so the outline is drawn.
3. Read the computed `outline-color` and the background color of the area next to the control. Use the color picker in the developer tools, which shows a contrast ratio, or a contrast checker.
4. Repeat for the Command field, Send, Push to talk, Confirm, Decline and the Transcript.

You only need to measure one control per theme if all of them show the same outline color and sit on the same background. Say so in the Notes.

| Theme | Outline color (computed) | Background next to it | Ratio | 3:1 or better |
|---|---|---|---|---|
| Light (for example Light Modern) | | | | [ ] |
| Dark (for example Dark Modern) | | | | [ ] |
| Dark High Contrast | | | | [ ] |
| Light High Contrast | | | | [ ] |

- [ ] The outline is clearly visible on every control in every theme above.
- [ ] The outline is at least 2 pixels wide (the panel draws 3).
- [ ] In the Command field, the border also gets thicker when focused (a cue that does not depend on color).

Notes:

### High contrast and forced colors

- [ ] In both High Contrast themes, the status line, the Transcript and every button have a visible border, and the text is easy to read.
- [ ] If you can use a Windows contrast theme (Settings, Accessibility, Contrast themes), enable one. The panel stays readable, the focus ring is visible, and the unavailable Push to talk button still looks different from an available one by its dashed border and its note text.
- [ ] No state in the panel is shown by color alone. Each has a text label.

Notes:

## 5. Summary

| Section | Result (replace NOT TESTED with pass, fail or partial after you run it) | Issues found |
|---|---|---|
| 1 Keyboard-only walkthrough | NOT TESTED | |
| 2 Screen reader pass | NOT TESTED | |
| 3 Speech off and backend stopped | NOT TESTED | |
| 4 Focus indicator contrast | NOT TESTED | |

Tester sign-off (name, date):

## What this does not cover

- Full WCAG validation. It needs assistive technology testing and review by an accessibility expert.
- More than one screen reader and browser engine combination. This pass covers the one you record at the top.
- Speech quality of the Deepgram voice, and the speech recognition accuracy of your voice. Those are product quality checks, not accessibility conformance.
- Real contrast of themes not listed in section 4, and any third party theme.
