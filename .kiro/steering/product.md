# KiroSight — Product

## What it is

KiroSight is an accessibility agent for blind and low-vision software developers using the Kiro IDE. It is not a screen reader replacement. It is a voice-driven layer that lets a developer understand IDE state and control common development workflows through natural-language interaction, working alongside the developer's existing screen reader.

## Problem

Screen readers expose text and UI structure, but they don't understand development context: what a diagnostic means, what changed in Git, what a function does, or what "fix this" should actually touch. Blind and low-vision developers currently have to manually stitch together screen reader output to answer questions a sighted developer answers with a glance. KiroSight closes that gap by giving the IDE a voice interface backed by an AI agent that understands project state.

## Target user

A blind or low-vision software developer using Kiro (VS Code-based), who already relies on a screen reader (e.g. NVDA, JAWS, VoiceOver) and wants faster, more direct answers about IDE and project state instead of navigating UI tree-by-tree.

## Core experience

Voice-first, push-to-talk interaction. The user asks a question or gives a command; KiroSight answers concisely by voice, grounded in real IDE state. Example interactions this product must support:

- "What's happening in my project?"
- "What file am I in?"
- "Read the current function."
- "What errors are there?"
- "Go to the first error."
- "Explain this error."
- "Open auth.ts."
- "Run my tests."
- "Summarize the test failures."
- "What changed in Git?"
- Eventually: "Fix this error" or "make this change."

## Explicit non-goals

- KiroSight is NOT another screen reader. It does not re-implement generic accessible text/UI navigation that NVDA/JAWS/VoiceOver already do well.
- Not a general chatbot. Every answer should be grounded in actual IDE/workspace state, not generic knowledge.
- Not a fully autonomous coding agent at MVP. Read/query/navigate actions come first; code-modifying actions ("fix this", "make this change") are a later-stage capability gated behind the allow-list and confirmation model.
- Not a vision-first product. Screenshot/computer-vision analysis is a fallback, not the primary mechanism, used only when structured IDE state can't answer the question.

## MVP priorities (in rough order)

1. **First usable milestone, no external dependencies:** describe IDE/project state (current file, cursor/function context, diagnostics, Git status) purely through VS Code Extension APIs — no Bedrock, no Deepgram, no Python backend yet. See `tech.md` "Development milestones."
2. Navigate the editor (open file, go to error, go to line/symbol) — initially via typed text, with voice layered on afterward.
3. Read code aloud in a structured, non-overwhelming way (current function, current error, current selection).
4. Run and summarize common workflows (run tests, summarize failures, summarize terminal output) via named, allow-listed actions (e.g. `RUN_TESTS`), never a model-supplied shell command.
5. **Stretch goal:** agent-proposed code edits ("fix this error", "make this change") — explicitly out of initial MVP scope. If and when it's built, it must go through the same allow-list and explicit user confirmation model as every other state-changing action; it does not get a shortcut.

Voice (push-to-talk via Deepgram) and AI reasoning (Bedrock) are additive layers on top of milestone 1, not prerequisites for it — see `tech.md` for the staged build order.

## Success criteria for the hackathon demo

- A blind or low-vision presenter (or a sighted presenter simulating the workflow) can ask the example questions above by voice and get fast, accurate, concise spoken answers.
- The demo shows the agent grounding answers in real Kiro/VS Code state (diagnostics, Git diff, file content), not hallucinated summaries.
- At least one guarded "action" flow (e.g. run tests, go to error) demonstrates the allow-list + confirmation model end-to-end.
- Polish and reliability of a narrow flow matter more than breadth of supported commands.
