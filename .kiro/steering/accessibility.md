# KiroSight — Accessibility Requirements

These requirements are not optional polish — they are the product. Every feature must be designed against them before implementation, not retrofitted afterward.

## Voice-first, but never voice-only

- The primary interaction mode is voice (push-to-talk), but every capability must also be fully operable via keyboard. No feature should require voice or a mouse.
- The webview panel must have a logical, discoverable keyboard interaction model (clear focus order, visible/announced focus, standard keyboard activation patterns).

## Never rely on color alone

- Any state that matters (recording/listening, processing, error, success, confirmation pending) must be conveyed through text/label and/or sound/speech, not color alone.
- If a visual indicator uses color, pair it with a text label, icon with accessible name, or ARIA live region update in the webview.

## Spoken response design

- Default to concise responses. Answer the question asked first; offer to elaborate rather than front-loading detail.
- Always ground spoken responses in concrete specifics: filenames, function/symbol names, line numbers, and (for actions) consequences of what will happen or happened. Avoid vague references like "the thing on the right" or "this area" — there is no "right" in a voice interface.
- Example of the bar to meet: instead of "there's an error over there," say "there's a type error on line 42 in `auth.ts`, in the `validateToken` function."
- Do not read large terminal outputs, stack traces, or file contents verbatim by default — summarize them, and offer a path to hear/view more detail on request (e.g. "12 tests failed, mostly timeout errors in the `auth` suite — want details?").
- Announce meaningful state changes proactively (e.g. a long-running test run finishing, a new diagnostic appearing after a save) rather than requiring the user to poll by asking.

## Confirmation and destructive actions

- Any destructive or state-changing action (running tests, modifying/writing files, git operations beyond read-only status checks, terminal commands, "fix this"/"make this change") must be confirmed by the user before execution — surfaced both visually in the webview and via spoken prompt, and confirmable via voice or keyboard.
- Confirmation prompts must state what will happen in concrete terms before the user confirms (e.g. "This will overwrite lines 10 through 25 of `auth.ts` to add null checks. Apply it?").

## Coexistence with existing screen readers and keyboard navigation

- KiroSight must preserve compatibility with the user's existing screen reader (NVDA, JAWS, VoiceOver, etc.) rather than replacing or competing with it. The webview must use proper semantic HTML/ARIA roles and live regions so the user's screen reader can still read it normally if they choose to use it directly, independent of KiroSight's voice layer.
- Do not suppress or intercept standard screen reader behavior/shortcuts within the webview.
- Voice interaction **supplements** existing screen readers and keyboard navigation — it never replaces them. Every capability KiroSight exposes through voice must also be reachable via existing keyboard navigation and typed text, not voice-exclusive.
- KiroSight's voice responses are additive — a user should be able to fall back to their screen reader at any point and get a coherent (if more verbose) experience.

## Text transcript always available

- The webview must maintain a visible, screen-reader-accessible text transcript of the conversation (queries and responses) at all times, **even when TTS is enabled and actively speaking**. TTS is a convenience layer on top of the transcript, not a replacement for it — a user relying on their own screen reader rather than Aura's voice output must still get the full response by reading the transcript.
- All commands must work through typed text input, not just voice, so a Deepgram STT/TTS failure degrades the experience to text-only rather than making KiroSight unusable (see `tech.md`).

## Testing accessibility

- Treat keyboard-only walkthroughs of every new feature as a required check before considering it done, not an afterthought.
- Full WCAG conformance validation requires manual testing with assistive technologies and expert review — automated checks (axe, linting) can catch some issues but cannot certify compliance. Call this out explicitly rather than claiming "WCAG compliant" based on tooling alone.
