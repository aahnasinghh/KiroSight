# KiroSight Backend Protocol (version 1)

This document is the contract between the KiroSight extension host (TypeScript) and the local Python backend. It describes the wire format only. The matching code is:

| Side | Types | Runtime validation |
|---|---|---|
| Extension host | `extension/src/protocol/messages.ts`, `constants.ts` | `extension/src/protocol/validators.ts` (Zod): `validateProtocolMessage` |
| Backend | `backend/app/protocol/messages.py` | `backend/app/protocol/validators.py` (Pydantic v2): `parse_message` |

The two implementations are maintained by hand and kept in step by the shared fixtures described in [Shared fixtures](#shared-fixtures).

## Status: defined, not yet running

This document defines message shapes. A message being defined does not mean the feature behind it exists yet. At the time of writing there is no running WebSocket server, no extension-side backend client, and no Amazon Bedrock, speech-to-text, text-to-speech or microphone integration. For example, `speech_audio` and `transcription_result` exist as data definitions only.

## Purpose and boundaries

- The protocol connects the **extension host** and the **backend** over a local WebSocket. The backend binds to a loopback address only (Requirement 11.4).
- It is **not** the webview bridge. The webview and the extension host talk through `extension/src/protocol/bridgeMessages.ts`, which has its own unrelated message set. The webview never opens a connection to the backend.
- All messages are JSON objects. The size limit is 2 MB per message.

## Envelope

Every message, in both directions, has:

| Field | Type | Notes |
|---|---|---|
| `version` | the JSON number `1` | Spellings that decode to the number 1 (`1`, `1.0`, `1e0`) are equivalent. Strings such as `"1"`, booleans, `null` and any other number are not accepted |
| `type` | string | One of the 14 message types below |

Field names are camelCase on the wire (`replyTo`, `mimeType`, `supportedVersions`, ...). Both sides keep those exact names.

Every message and every nested payload is **strict**: unknown properties are rejected, never silently dropped. The one exception is the [action envelope](#action-envelope-and-the-allow-list-boundary).

Optional fields may be absent, but an explicit `null` is not accepted for them (a field that is nullable says so below).

Fields documented as integers accept JSON numeric values that are mathematically integral, within JavaScript's safe-integer range (-9007199254740991 to 9007199254740991), and within the field's documented bounds (`5`, `5.0` and `5e0` are the same value). The backend normalizes them to integer values. Booleans, strings, fractions and non-finite numbers are not accepted. Loose action-envelope extras are never normalized.

## Versioning and compatibility

The only supported version is `1`. A message with a present `version` other than the number `1` is rejected as `UNSUPPORTED_VERSION`. `hello_ack.supportedVersions` lists the versions the backend supports so a later version can be negotiated. No negotiation is implemented yet.

## Message types

14 message types exist. No others are valid (there is no `ping`, `pong`, `ready`, `execute`, `run_command`, `log` or `debug`).

| Type | Direction |
|---|---|
| `hello` | extension to backend |
| `agent_request` | extension to backend |
| `action_result` | extension to backend |
| `record_start` | extension to backend |
| `record_stop` | extension to backend |
| `audio_clip` | extension to backend |
| `speech_request` | extension to backend |
| `cancel` | extension to backend |
| `hello_ack` | backend to extension |
| `agent_response` | backend to extension |
| `action_request` | backend to extension |
| `transcription_result` | backend to extension |
| `speech_audio` | backend to extension |
| `error_message` | backend to extension |

Correlation: requests carry an `id`; replies carry `replyTo` naming that `id`. A late reply can therefore be discarded when its request is no longer in flight.

### hello

Extension to backend. Opens the handshake.

| Field | Type | Required |
|---|---|---|
| `client` | `"kirosight-extension"` | yes |
| `token` | string | no (optional shared token) |

### hello_ack

Backend to extension. Answers `hello`.

| Field | Type | Required |
|---|---|---|
| `supportedVersions` | integer array | yes |
| `capabilities` | [capabilities](#capabilities) | yes |

### agent_request

Extension to backend. Asks the reasoning agent for help.

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |
| `kind` | `"utterance"` or `"summarize_test_run"` | yes |
| `utterance` | `{ text: string (max 4000 characters), source?: "typed" or "voice" }` | no (present when `kind` is `utterance`) |
| `context` | [WireIDEContext](#wireidecontext) | yes |
| `testRun` | [TestRunSummary](#testrunsummary) | no (present when `kind` is `summarize_test_run`) |

### agent_response

Backend to extension. The agent's answer.

| Field | Type | Required |
|---|---|---|
| `replyTo` | string (the `agent_request.id`) | yes |
| `speech` | string, at most 600 characters | yes |
| `action` | [action envelope](#action-envelope-and-the-allow-list-boundary) | yes (`{"type":"NO_ACTION"}` when nothing is proposed) |
| `confirmationRequired` | boolean | yes (advisory only) |

`confirmationRequired` can add a confirmation to a safe action. It can never remove the confirmation of an action the allow-list marks as needing one.

### action_request

Backend to extension. A backend-initiated action proposal. In the MVP the agent proposes actions inside `agent_response`; this message is reserved. Both go through the same extension-side checks.

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |
| `action` | action envelope | yes |
| `reason` | string | yes |

### action_result

Extension to backend. Reports what happened to an agent-originated action, including declined, not permitted and not configured outcomes.

| Field | Type | Required |
|---|---|---|
| `replyTo` | string (the `agent_response.replyTo` or `action_request.id` that carried the action) | yes |
| `result` | [ActionResult](#actionresult) | yes |

### record_start and record_stop

Extension to backend. Used only by the backend-local voice input.

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |

### audio_clip

Extension to backend. A recorded clip.

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |
| `mimeType` | string | yes |
| `base64` | string | yes |

### transcription_result

Backend to extension. Speech-to-text output for an `audio_clip`.

| Field | Type | Required |
|---|---|---|
| `replyTo` | string | yes |
| `text` | string | yes |

### speech_request

Extension to backend. Asks for synthesized speech for text already shown in the transcript.

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |
| `replyTo` | string | no |
| `text` | string | yes |

### speech_audio

Backend to extension. The synthesized audio.

| Field | Type | Required |
|---|---|---|
| `replyTo` | string | yes |
| `mimeType` | string | yes |
| `base64` | string | yes |

### cancel

Extension to backend. Stops an in-flight request.

| Field | Type | Required |
|---|---|---|
| `targetId` | string (the `id` of the request to cancel) | yes |

### error_message

Backend to extension. Reports a failure. It never echoes the offending payload.

| Field | Type | Required |
|---|---|---|
| `replyTo` | string | no |
| `code` | [ErrorCode](#errorcode) | yes |
| `message` | string | yes |
| `recoverable` | boolean | yes |

## Shared payloads

### Capabilities

| Field | Type |
|---|---|
| `bedrock` | boolean |
| `stt` | boolean |
| `tts` | boolean |
| `mic` | `"available"`, `"unavailable"`, `"denied"` or `"not_applicable"` |

The shape is defined here. Real values arrive when the backend handshake is implemented.

### WireIDEContext

The safe wire form of the editor context. It deliberately has no `activeFile`, so the backend never learns the user's directory layout. The schema is strict, so an `activeFile` (or `fsPath`, `absolutePath`, `workspaceRootPath`) is rejected.

| Field | Type |
|---|---|
| `workspace` | `{ name: string or null, rootCount: integer >= 0 }` |
| `relativePath` | workspace-relative path string or `null` |
| `languageId` | string or `null` |
| `cursor` | `{ line: integer >= 1, column: integer >= 1 }` or `null` (1-indexed) |
| `selection` | `{ isEmpty: true }`, `{ isEmpty: false, start: Pos, end: Pos }` or `null` (`null` means no editor) |
| `nearbyCode` | `{ source: "selection"/"symbol"/"cursor_window", startLine, endLine, text (max 6000 characters), truncated: boolean }` or `null` |
| `currentSymbol` | `{ name, kind, startLine, endLine }` or `null` |
| `symbolStatus` | `"found"`, `"none_enclosing"`, `"provider_unavailable"` or `"no_editor"` |
| `diagnostics` | up to 25 diagnostics |
| `diagnosticCounts` | `{ error, warning, information, hint }`, each an integer >= 0 (full workspace counts) |

A diagnostic is `{ severity: "error"/"warning"/"information"/"hint", relativePath, line >= 1, column >= 1, message (max 500 characters), source?, code?, symbolName?: string or null }`.

Every `relativePath` rejects absolute paths: Unix (`/...`), Windows drive (`C:\...` or `C:/...`) and UNC (`\\server\...`).

Integers must be integral numbers within the JavaScript safe-integer range. `true`, `5.5` and `"5"` are not accepted.

### TestRunSummary

Wire data only; no test runner is involved.

| Field | Type |
|---|---|
| `outcome` | `"passed"`, `"failed"`, `"completed_unparsed"`, `"did_not_execute"`, `"timed_out"`, `"cancelled"` or `"not_configured"` |
| `command` | string (the configured command, echoed back) |
| `exitCode` | integer or `null` |
| `passed`, `failed` | integer >= 0 or `null` |
| `totalFailedNames` | integer >= 0 |
| `failingTests` | up to 20 of `{ name: string, messageExcerpt?: string }` |
| `outputTruncated` | boolean |
| `durationMs` | number >= 0 |

### ActionResult

| Field | Type |
|---|---|
| `actionType` | string (not restricted to the eight action names, so an unknown proposed action can still receive `not_permitted`) |
| `status` | `"ok"`, `"failed"`, `"declined"`, `"not_permitted"`, `"needs_clarification"` or `"not_configured"` |
| `message` | string: the concrete outcome or reason |
| `details` | optional, one of the variants below |

`details` variants (selected by `kind`):

| `kind` | Fields |
|---|---|
| `file_opened` | `relativePath` |
| `diagnostic_reached` | `relativePath`, `line >= 1`, `severity`, `message`, `symbol?`, `wrapped?: boolean` |
| `location_reached` | `relativePath`, `line >= 1` |
| `ambiguous_files` | `matches` (up to 10 relative paths), `totalMatches` |
| `test_run` | `summary` ([TestRunSummary](#testrunsummary)) |

## Action envelope and the allow-list boundary

`agent_response.action` and `action_request.action` are validated at the protocol layer only as **an object with a string `type`**. Every other property is kept exactly as sent.

**The protocol validator is not the action authorization boundary.** It does not check that `type` is an approved action and does not check parameters. For example `{"type":"RUN_COMMAND","command":"..."}` and `{"type":"RUN_TESTS","command":"..."}` both pass the protocol layer. They are not executable because of that: every proposed action is then passed to the strict allow-list and `ActionValidator` on the extension side, which accepts only the eight approved actions with exact parameters, rejects anything else (the agent receives an `action_result` with `not_permitted`), and applies the confirmation gate. The test command that `RUN_TESTS` runs always comes from trusted extension configuration, never from a message.

An action that is not an object, or whose `type` is missing or not a string, fails protocol validation.

## ErrorCode

| Code | Meaning |
|---|---|
| `VALIDATION_FAILED` | A message was malformed: unparseable, missing field, wrong field type, unexpected property or other schema violation |
| `UNSUPPORTED_VERSION` | `version` was present but not `1` |
| `UNKNOWN_TYPE` | `type` was a string but not one of the 14 message types |
| `UNAUTHORIZED` | The optional shared token was missing or wrong |
| `BEDROCK_UNAVAILABLE` | The reasoning call to Amazon Bedrock failed or was unavailable |
| `BEDROCK_INVALID_RESPONSE` | The model output could not be turned into a valid response |
| `STT_UNAVAILABLE` | Speech-to-text could not be reached or failed |
| `STT_NO_SPEECH` | A clip contained no recognizable speech |
| `TTS_UNAVAILABLE` | Text-to-speech could not be reached or failed |
| `MIC_UNAVAILABLE` | No microphone is available for recording |
| `MIC_DENIED` | Microphone permission was denied |
| `CREDENTIAL_MISSING` | A credential needed for the requested capability is not configured (reported by name only) |
| `TIMEOUT` | A request took too long |
| `CANCELLED` | The request was cancelled with `cancel` |
| `INTERNAL` | An unexpected backend error |

The meaning of provider-specific codes describes intended use; those providers are not implemented yet.

## Validation behavior

Both validators take an already-decoded JSON value and never throw for malformed input.

| Situation | Result |
|---|---|
| Not an object, or version missing, or `type` missing / not a string | `VALIDATION_FAILED` |
| `version` present but not the number `1` | `UNSUPPORTED_VERSION` |
| `type` is a string but unknown | `UNKNOWN_TYPE` |
| Any other schema violation | `VALIDATION_FAILED` |

Version is checked before type. A failure carries a stable code, a short message and up to 5 schema paths of at most 100 characters each. It never contains payload values, audio, code, utterance text, credentials or unknown property names. The parser's internal failure object is separate from the `error_message` wire message; the receiving side decides whether to reply with one.

A message that fails validation is discarded without reaching any action handler, is answered with an `error_message` that does not echo the payload, and the connection stays open (Requirement 11.3).

## Shared fixtures

`extension/src/protocol/fixtures/messages/` holds one valid sample per message type:

`hello.json`, `hello_ack.json`, `agent_request.json`, `agent_response.json`, `action_request.json`, `action_result.json`, `record_start.json`, `record_stop.json`, `audio_clip.json`, `transcription_result.json`, `speech_request.json`, `speech_audio.json`, `cancel.json`, `error_message.json`.

The same physical files are validated by `extension/test/protocol/protocolFixtures.test.ts` (Vitest) and `backend/tests/test_protocol_fixtures.py` (pytest), and both fail if a fixture is missing or an unexpected one is added. The files are synthetic and committed by hand; they are never generated from either implementation. The allow-list parity fixture is separate: `extension/src/protocol/fixtures/allowlist.json`.

## Security notes

- The backend accepts connections on a loopback address only.
- No message carries an executable command. There is no generic command, shell or executable field.
- Absolute filesystem paths never appear on the wire.
- Credentials are never part of a normal payload; the optional `hello.token` is the only secret-like field and must not be logged.
- Validation failures never echo untrusted content.
- Changes to the message set, field shapes or `ErrorCode` must be made on both sides, and in this document, in the same change.
