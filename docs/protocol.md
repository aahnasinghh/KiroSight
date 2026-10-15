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

Extension to backend. Used only by the backend-local voice input (Task 8.5), where the backend records from the machine's default microphone.

| Field | Type | Required |
|---|---|---|
| `id` | string (the recording id; it names the clip in every reply) | yes |

How the backend handles them:

- **Nothing records by itself.** The microphone opens only for a `record_start`. The handshake, `hello_ack.capabilities.mic` and typing never open it. `mic` is `available`, `unavailable` or `denied` (read without capturing), or `not_applicable` when the backend has no audio input configured.
- **`record_start` success is silent.** There is no acknowledgement message. A failure is one `error_message` with `replyTo` = the recording `id`:
  - `MIC_DENIED`: the operating system refused microphone access. `recoverable` is true.
  - `MIC_UNAVAILABLE`: no usable microphone, the device failed to open, it is in use by another KiroSight connection, or (non-recoverable) the backend has no audio input at all. The microphone is re-checked on every `record_start`, so a later fix works without a restart.
  - `CREDENTIAL_MISSING`: `DEEPGRAM_API_KEY` is not set. Nothing is recorded, because the clip could not be transcribed.
  - `VALIDATION_FAILED`: a recording is already in progress on this connection, or the id was empty, too long or already used.
- **`record_stop`** closes the microphone and sends the clip through the same speech-to-text path as an `audio_clip` (see [transcription_result](#transcription_result)): one `transcription_result` or one `error_message` (`STT_NO_SPEECH` if nothing was captured, `MIC_UNAVAILABLE` if the device stopped by itself mid-recording, or any STT error) with `replyTo` = the recording `id`. A repeated `record_stop` for a recording that already ended is ignored without a reply; one for an id that never started is `VALIDATION_FAILED`.
- **60 s cap.** The backend ends a recording 60 seconds after it started, exactly as if `record_stop` had arrived, and the later `record_stop` is ignored. Audio is held in memory only, capped at 1,920,000 bytes (60 s of 16 kHz mono 16-bit), and sent as `audio/wav`.
- **`cancel`** with `targetId` = the recording `id` closes the microphone and discards the audio, with no reply. Closing the connection does the same.
- One recording at a time across the whole backend: a second connection that tries to record while the microphone is in use gets `MIC_UNAVAILABLE`.

### audio_clip

Extension to backend. Recorded audio: either a whole clip in one frame, or a recording sent as it is captured in an ordered series of frames.

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |
| `mimeType` | string | yes |
| `base64` | string (may be empty only on a `final` frame) | yes |
| `seq` | integer, 0 or more | with `final` |
| `final` | boolean | with `seq` |

`seq` and `final` travel together: a frame carries both or neither. A frame with neither is a whole clip.

Chunked recordings (Req 19.5): the extension forwards each audio chunk to the backend as soon as it receives it, without waiting for the recording to end, so the backend sees the audio progressively.

- All frames of one recording share the same `id` (`voice-N`, assigned by the extension).
- `seq` starts at 0 and increases by exactly 1 per frame, with no gaps and no repeats. Frames arrive in order on the one WebSocket connection.
- `final: true` marks the last frame of the recording. Its `base64` may be empty when the recording ended on a bare end marker. Nothing follows a `final` frame for that `id`.
- Each frame carries at most 1,000,000 base64 characters, so it stays under the backend's 2 MiB inbound message limit. A whole recording is capped at 4 MiB of audio and 2,000 frames.
- If the extension abandons a recording after some frames were sent (a cancelled capture, a bad chunk, a lost connection, a new recording taking over), it sends a [`cancel`](#cancel) whose `targetId` is the recording `id`. The backend discards the partial recording and must not transcribe it.
- The extension measures relay latency per chunk from receipt on the extension host to the return of the send, against a 500 ms deadline.

### transcription_result

Backend to extension. Speech-to-text output for an `audio_clip`.

| Field | Type | Required |
|---|---|---|
| `replyTo` | string (the recording `id`) | yes |
| `text` | string | yes |

How the backend answers an `audio_clip` (Task 8.4, Deepgram Nova-2):

- A recording is transcribed only when it is complete: a whole clip (no `seq`/`final`), or a chunked recording once its `final` frame has arrived in strict order. An incomplete recording is never transcribed, and its buffers are released on `cancel`, on any invalid frame, after 75 s without completion, and when the connection closes.
- Success: exactly one `transcription_result` whose `replyTo` is the recording `id`. `text` is non-empty, trimmed, at most 4,000 characters, and is untrusted user text: the extension feeds it to its own input pipeline like typed text. The backend never acts on it.
- Failure: exactly one `error_message` with `replyTo` set to the recording `id` and no transcript.

| Code | Cause | `recoverable` |
|---|---|---|
| `CREDENTIAL_MISSING` | `DEEPGRAM_API_KEY` is not set. No audio is collected and no call is made; the message names the variable. | false |
| `STT_UNAVAILABLE` | Deepgram could not be reached, rejected the request or the credential, returned an unusable answer, or the service is busy (at most 2 transcriptions run at once per connection). | usually true |
| `STT_NO_SPEECH` | The recording had no audio, or Deepgram returned an empty transcript. | true |
| `TIMEOUT` | Deepgram did not answer within 10 seconds. One attempt only; nothing is retried. | true |
| `VALIDATION_FAILED` | The frame was invalid: not an `audio/*` type, bad base64, a repeated, skipped or out-of-order `seq`, a changed type, an id already in use or already received, more than 4 MiB or 2,000 frames, or more than 4 recordings in progress. The whole recording is discarded and reported once; later frames of that id are ignored without a reply. | true |
| `INTERNAL` | An unexpected backend error. | true |

A `cancel` whose `targetId` is a recording `id` discards the partial recording, or stops a transcription already in progress. Neither sends a reply.

### speech_request

Extension to backend. Asks for synthesized speech for text already shown in the transcript.

The backend answers with one `speech_audio` (`replyTo` = this request's `id`) or one `error_message` with the same `replyTo`: `TTS_UNAVAILABLE` (network or HTTP error, bad answer, empty text, text over 2,000 characters, too many syntheses at once), `TIMEOUT` (no answer within 10 seconds) or `CREDENTIAL_MISSING` (names `DEEPGRAM_API_KEY`; no call is made). One attempt, never retried. A `cancel` with this `id` stops synthesis and sends no reply.

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

Extension to backend. Stops an in-flight request, or discards a partly sent chunked recording.

| Field | Type | Required |
|---|---|---|
| `targetId` | string (the `id` of the request to cancel, or of the `audio_clip` recording to discard) | yes |

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

The backend reports `stt: true` only when `DEEPGRAM_API_KEY` is set (and `DEEPGRAM_STT_MODEL`, if set, is a valid name), checked on each connection. That means a call could be made; it does not prove Deepgram will accept it.

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
