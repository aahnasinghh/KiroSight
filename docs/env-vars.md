# KiroSight Environment Variables

KiroSight's local Python backend reads provider credentials and backend configuration from environment variables. The extension and the webview never read them.

The backend needs no configuration to start: it listens on `127.0.0.1:8765` and uses the offline stub reasoning client. To use live services, copy `backend/.env.example` to `backend/.env` and fill in only what you need (the root `.env.example` lists the same names). `.env` files are ignored by Git. Never commit credentials or place them in extension source, webview code, logs, screenshots, or test fixtures. A variable already set in the process environment takes precedence over `backend/.env`.

Live Amazon Bedrock inference has **not** been verified end to end (Task 7.14 is open because of account quota and throttling), and Deepgram has not been verified in a live end-to-end demo. Setting a variable here does not prove that the service will accept requests.

| Variable | Purpose |
|---|---|
| `KIROSIGHT_HOST` | Host address for the local backend. The default is `127.0.0.1`; the backend rejects non-loopback addresses. |
| `KIROSIGHT_PORT` | Port for the local backend. The default is `8765`. |
| `KIROSIGHT_AUTH_TOKEN` | Optional shared token for authenticating the extension-to-backend handshake. Any copy later held by the extension belongs in VS Code `SecretStorage`. |
| `DEEPGRAM_API_KEY` | Credential used only by the backend for Deepgram speech-to-text and text-to-speech requests. It is read from the environment when needed and never logged, echoed or sent to the webview. Without it no Deepgram call is made, `hello_ack` reports `capabilities.stt = false`, and a recording is answered with `CREDENTIAL_MISSING` naming this variable. |
| `DEEPGRAM_STT_MODEL` | Deepgram speech-to-text model. Defaults to `nova-2`. Letters, digits, `.`, `_`, `:` and `-` only (at most 64 characters); any other value disables speech-to-text and is never repeated in errors. |
| `DEEPGRAM_TTS_MODEL` | Deepgram Aura text-to-speech model. Defaults to `aura-asteria-en`. Letters, digits, `.`, `_`, `:` and `-` only (at most 64 characters); any other value disables text-to-speech and is never repeated in errors. Audio is requested as MP3. Without `DEEPGRAM_API_KEY` no call is made, `hello_ack` reports `capabilities.tts = false`, and a `speech_request` is answered with `CREDENTIAL_MISSING` naming that variable. |
| `AWS_REGION` | AWS region used by the backend's Amazon Bedrock client. |
| `AWS_DEFAULT_REGION` | Fallback region for the Bedrock client, used only when `AWS_REGION` is unset (the standard AWS variable name). With neither set the region is `us-east-1`. |
| `AWS_ACCESS_KEY_ID` | Access-key identifier used by the standard AWS credential chain when static or temporary credentials are selected. |
| `AWS_SECRET_ACCESS_KEY` | Secret access key paired with `AWS_ACCESS_KEY_ID`. This value must never be logged or committed. |
| `AWS_SESSION_TOKEN` | Session token used with temporary AWS credentials; omitted when the selected AWS credential source does not require one. |
| `AWS_BEARER_TOKEN_BEDROCK` | Amazon Bedrock API key, read by the AWS SDK itself as an alternative to the access-key pair. The backend only checks that it is set and never reads, logs or forwards the value. |
| `BEDROCK_MODEL_ID` | Identifier of the Amazon Bedrock model used for semantic reasoning through the Converse API. Defaults to `amazon.nova-lite-v1:0`; the region defaults to `us-east-1` when `AWS_REGION` is unset. |
| `KIROSIGHT_LLM` | Selects the reasoning client: `stub` (default, offline, `capabilities.bedrock=false`) or `bedrock`. Bedrock needs `AWS_BEARER_TOKEN_BEDROCK` or both `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; without them requests fail closed with `CREDENTIAL_MISSING`. The stub is never used as a fallback after a Bedrock failure. Any other value stops the backend at startup. |

## Ownership and failure behavior

- AWS and Deepgram variables are consumed only by the local backend, never by the extension or the webview.
- `KIROSIGHT_AUTH_TOKEN` is optional. If used, the backend reads it from the environment and the extension stores its copy in `SecretStorage` (run `KiroSight: Set Backend Token`).
- Missing provider credentials disable only that provider-backed capability. Typed commands and deterministic local extension features must remain available.
- `.env.example`, this document, and environment-variable references in source must stay synchronized as configuration is implemented.

## Choosing the reasoning client (stub or Amazon Bedrock)

The backend answers agent requests such as "explain this error" with one reasoning client, chosen by `KIROSIGHT_LLM`. The choice is explicit and never changes while the backend runs.

**Using the stub client (the default).** Leave `KIROSIGHT_LLM` unset, or set `KIROSIGHT_LLM=stub`. No AWS variable is needed and no network call is made. The stub returns a fixed answer ("KiroSight backend is connected.") with no action, so the whole pipeline can be exercised offline: the extension still builds the grounded request, relays it, and shows the answer in the transcript. The panel's status line reads "Bedrock unavailable", because `capabilities.bedrock` is `false` for the stub. That is expected and does not block anything.

**Using Amazon Bedrock.** Set `KIROSIGHT_LLM=bedrock` and provide either `AWS_BEARER_TOKEN_BEDROCK` or both `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (optionally `AWS_REGION` and `BEDROCK_MODEL_ID`). Bedrock is the only production provider; there is no other.

**What the status means.** `capabilities.bedrock` is `true` only when a credential is configured. It does not prove that Bedrock inference works: the account may have no quota, the model may be unavailable, or the key may be invalid. A request that fails is reported when it fails.

**When reasoning cannot answer.** Nothing is retried on another provider and the stub is never substituted after a Bedrock failure. The transcript says what happened, and local commands (where am I, errors, go to line, run tests) keep working:

- backend not running: "I can't reach the KiroSight backend, so I can't explain that."
- Bedrock failed or has no credentials: "The explanation couldn't be generated because the reasoning service failed." followed by the reason.
- an answer the backend could not trust: "I couldn't understand the reasoning service's answer, so I did nothing."

**Actions proposed by an answer** are checked against the eight allow-listed actions and always go through the confirmation gate. `RUN_TESTS` always asks first and only ever runs `kirosight.testCommand`. After a test run that failed, the extension asks the backend for a short summary of the failures; if that fails, only the deterministic result text is shown.

## Backend-local microphone (Task 8.5)

When webview capture is unavailable (Spike D), the backend records from the machine's default microphone with `sounddevice` (PortAudio), pinned in `backend/requirements.txt`. It needs no environment variable and no credential: only speech-to-text uses `DEEPGRAM_API_KEY`, and a recording is refused before the microphone opens if that key is missing.

- **Install.** `pip install -r backend/requirements.txt` inside the backend virtual environment. On Windows and macOS the wheel includes PortAudio. On Linux install the system package first (for example `libportaudio2`). Without the library the backend still runs, `capabilities.mic` is `unavailable`, and typing, local commands and webview voice are unaffected.
- **Privacy.** The microphone opens only after a `record_start` message, closes on stop, cancel, the 60 s cap or disconnect, and the audio stays in memory (never written to disk or logged).
- **`capabilities.mic` is a hint, not proof.** `available` means a default input device exists and supports 16 kHz mono; `denied` is only detected when the device is actually opened (Windows reports a blocked microphone as a host error whose text mentions access being denied, which is matched heuristically). The first real recording is the real test.

### Manual microphone check (not run by the automated tests)

1. In the backend virtual environment run `pip install -r backend/requirements.txt`.
2. Set `DEEPGRAM_API_KEY` in `backend/.env` (never commit it) and start the backend: `uvicorn app.main:app --host 127.0.0.1 --port 8765` from `backend/`.
3. Connect with any WebSocket client, send `hello`, and check `hello_ack.capabilities.mic` is `available`.
4. Send `record_start` with an `id`, speak for a few seconds, then send `record_stop` with the same `id`. Expect one `transcription_result` with that `replyTo`.
5. Repeat with Windows Settings, Privacy and security, Microphone switched off for desktop apps. Expect `MIC_DENIED` (or `MIC_UNAVAILABLE` if Windows reports it differently), and note which, because the denial detection is a heuristic.
6. Start a recording and close the client without sending `record_stop`; confirm the Windows microphone-in-use indicator goes away.

## Voice in the extension (Task 8.13)

Voice is wired into the extension and is an additive layer: typed text, keyboard control and every local command work whatever happens to it.

- **`kirosight.voice.enabled`** (VS Code setting, default `true`). When `false`, no voice code is constructed, the panel's push-to-talk note says voice is turned off, and `kirosight.activate` only opens or focuses the panel. It is read when the extension starts, so reload the window after changing it. It is a setting, not an environment variable, and holds no secret.
- **Deepgram variables are read by the backend only.** `DEEPGRAM_API_KEY` (required for speech recognition) and `DEEPGRAM_STT_MODEL` (optional, default `nova-2`) go in `backend/.env` or the backend's environment. The extension and the webview never see them. Without `DEEPGRAM_API_KEY` the backend reports `capabilities.stt = false`, the panel says "speech recognition is not set up", and nothing is recorded.
- **Which microphone.** The backend records (`sounddevice`, see "Backend-local microphone" above), because the webview refused the microphone in Kiro (Spike D). The webview is only a fallback: it is asked once, on an explicit push-to-talk press, and if it fails it is not tried again that session.
- **`kirosight.activate`** (Command Palette, or `Ctrl+Alt+K` on Windows and Linux, or any key you assign) always opens or focuses the panel first. It begins listening only when voice is already known to be ready (the backend is connected and reports speech recognition and a microphone). If the panel was closed, the first invocation opens it and starts the connection; once the panel shows "Voice is ready", invoke it again or press push-to-talk. Nothing ever records at startup, when the panel opens, or when the backend connects.
- **Stopping.** Press push-to-talk again, press `Escape` in the panel, close the panel, or lose the backend connection: the recording stops and the microphone is released. A recording also ends by itself at 60 seconds.
- **Where spoken text goes.** Recognized text is added to the Transcript as your query (marked as spoken) and handled by the same pipeline as typed text, including confirmation for anything that changes state.
