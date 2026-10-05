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
| `BEDROCK_MODEL_ID` | Identifier of the Amazon Bedrock model used for semantic reasoning through the Converse API. |

## Ownership and failure behavior

- AWS and Deepgram variables are consumed only by the future local backend, never by the webview.
- `KIROSIGHT_AUTH_TOKEN` is optional. If used, the backend reads it from the environment and the extension stores its copy in `SecretStorage`.
- Missing provider credentials will disable only that provider-backed capability. Typed commands and deterministic local extension features must remain available.
- `.env.example`, this document, and environment-variable references in source must stay synchronized as configuration is implemented.
