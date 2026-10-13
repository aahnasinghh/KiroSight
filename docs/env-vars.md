# KiroSight Environment Variables

KiroSight's future local Python backend will read provider credentials and backend configuration from environment variables. The backend is not part of the current extension scaffold; these names establish the configuration contract for its later implementation.

Copy `.env.example` to a local `.env` file only when backend work begins. Local `.env` files are ignored by Git. Never commit credentials or place them in extension source, webview code, logs, screenshots, or test fixtures.

| Variable | Planned use |
|---|---|
| `KIROSIGHT_HOST` | Host address for the local backend. The planned default is `127.0.0.1`; the backend will reject non-loopback addresses. |
| `KIROSIGHT_PORT` | Port for the local backend. The planned default is `8765`. |
| `KIROSIGHT_AUTH_TOKEN` | Optional shared token for authenticating the extension-to-backend handshake. Any copy later held by the extension belongs in VS Code `SecretStorage`. |
| `DEEPGRAM_API_KEY` | Credential used only by the future backend for Deepgram speech-to-text and text-to-speech requests. |
| `DEEPGRAM_STT_MODEL` | Deepgram speech-to-text model selector. The planned default is `nova-2`. |
| `DEEPGRAM_TTS_MODEL` | Deepgram Aura text-to-speech model selector. The exact demo voice will be selected during voice implementation. |
| `AWS_REGION` | AWS region used by the future backend's Amazon Bedrock client. |
| `AWS_ACCESS_KEY_ID` | Access-key identifier used by the standard AWS credential chain when static or temporary credentials are selected. |
| `AWS_SECRET_ACCESS_KEY` | Secret access key paired with `AWS_ACCESS_KEY_ID`. This value must never be logged or committed. |
| `AWS_SESSION_TOKEN` | Session token used with temporary AWS credentials; omitted when the selected AWS credential source does not require one. |
| `AWS_BEARER_TOKEN_BEDROCK` | Amazon Bedrock API key, read by the AWS SDK itself as an alternative to the access-key pair. The backend only checks that it is set and never reads, logs or forwards the value. |
| `BEDROCK_MODEL_ID` | Identifier of the Amazon Bedrock model used for semantic reasoning through the Converse API. Defaults to `amazon.nova-lite-v1:0`; the region defaults to `us-east-1` when `AWS_REGION` is unset. |
| `KIROSIGHT_LLM` | Selects the reasoning client: `stub` (default, offline, `capabilities.bedrock=false`) or `bedrock`. Bedrock needs `AWS_BEARER_TOKEN_BEDROCK` or both `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; without them requests fail closed with `CREDENTIAL_MISSING`. The stub is never used as a fallback after a Bedrock failure. Any other value stops the backend at startup. |

## Ownership and failure behavior

- AWS and Deepgram variables are consumed only by the future local backend, never by the webview.
- `KIROSIGHT_AUTH_TOKEN` is optional. If used, the backend reads it from the environment and the extension stores its copy in `SecretStorage`.
- Missing provider credentials will disable only that provider-backed capability. Typed commands and deterministic local extension features must remain available.
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
