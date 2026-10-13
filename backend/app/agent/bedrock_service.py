"""Amazon Bedrock implementation of the ``LLMClient`` seam (Task 7.7).

``BedrockLLMClient`` makes one Converse call with a single forced ``respond`` tool and returns that
tool's input, untouched, as the raw model output. Amazon Bedrock is the only provider this module (or
this project) talks to: a failure is reported, never retried elsewhere and never replaced by a made-up
answer.

What it does and does not do
* It builds the request from the provider-neutral :class:`~app.agent.llm_client.LLMRequest`. Prompt
  construction (Task 7.6) already embeds the bounded context and recent turns in ``user_prompt``, so
  they are not sent twice.
* It returns the ``respond`` tool input as-is. Validating the shape, the action allow-list and the
  sentence limit is the response parser's job (Tasks 7.3 to 7.5); callers use
  ``parse_agent_output(raw, reply_to=request.reply_to)``. The client never executes, validates or
  rewrites an action, and the tool schema only offers the registry's eight actions.
* The synchronous boto3 call runs in a worker thread (``asyncio.to_thread``) so it cannot block the
  event loop. botocore's own retries are turned off; the only retry is one extra attempt after a
  throttling error. The read timeout is 20 s and the connect timeout 5 s, so a request cannot hang.
* Credentials come from the environment and are never read into memory beyond a presence check,
  stored, logged or put in an error. With no usable credential no call is made, and the error names
  the missing variable (not its value). Authentication itself is left to the AWS SDK, including the
  ``AWS_BEARER_TOKEN_BEDROCK`` Bedrock API key; no authorization header is built here.
* Every failure is an :class:`~app.agent.llm_client.LLMClientError` with a fixed safe message. Raw
  SDK messages, request content and model output are never copied into errors or logs.

Nothing here is verified against live Bedrock: the project's AWS account currently has no inference
quota. All tests use injected fake clients.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import os
import threading
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Final, Protocol

from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    ConnectTimeoutError,
    NoCredentialsError,
    PartialCredentialsError,
    ReadTimeoutError,
    TokenRetrievalError,
)

from app.agent.llm_client import LLMClientError, LLMRequest, RawModelOutput
from app.allowlist import ALLOWED_ACTIONS, ActionSpec
from app.logging_utils import format_metadata, redact
from app.protocol.messages import MAX_SPEECH_CHARS

__all__ = [
    "BEARER_TOKEN_VARIABLE",
    "CONNECT_TIMEOUT_SECONDS",
    "DEFAULT_MODEL_ID",
    "DEFAULT_REGION",
    "MAX_THROTTLE_RETRIES",
    "READ_TIMEOUT_SECONDS",
    "RESPOND_TOOL_NAME",
    "BedrockLLMClient",
    "BedrockRuntimeClient",
    "build_converse_request",
    "build_respond_input_schema",
    "classify_error",
    "extract_respond_input",
    "missing_credentials",
]

logger = logging.getLogger("kirosight.backend.bedrock")

DEFAULT_REGION: Final = "us-east-1"
DEFAULT_MODEL_ID: Final = "amazon.nova-lite-v1:0"
RESPOND_TOOL_NAME: Final = "respond"

REGION_VARIABLE: Final = "AWS_REGION"
FALLBACK_REGION_VARIABLE: Final = "AWS_DEFAULT_REGION"
MODEL_VARIABLE: Final = "BEDROCK_MODEL_ID"
BEARER_TOKEN_VARIABLE: Final = "AWS_BEARER_TOKEN_BEDROCK"
ACCESS_KEY_VARIABLE: Final = "AWS_ACCESS_KEY_ID"
SECRET_KEY_VARIABLE: Final = "AWS_SECRET_ACCESS_KEY"

#: Design: read timeout 20 s. The connect timeout is short so an unreachable endpoint fails fast.
READ_TIMEOUT_SECONDS: Final = 20
CONNECT_TIMEOUT_SECONDS: Final = 5
#: Design: at most one retry, and only for throttling.
MAX_THROTTLE_RETRIES: Final = 1
THROTTLE_RETRY_DELAY_SECONDS: Final = 1.0
MAX_OUTPUT_TOKENS: Final = 512

_THROTTLING_CODES: Final = frozenset({"ThrottlingException", "TooManyRequestsException", "ThrottledException"})
_ACCESS_CODES: Final = frozenset(
    {
        "AccessDeniedException", "AccessDenied", "UnrecognizedClientException", "ExpiredTokenException",
        "InvalidSignatureException", "InvalidClientTokenId", "UnauthorizedException", "SignatureDoesNotMatch",
    }
)
_MODEL_CODES: Final = frozenset({"ResourceNotFoundException", "ModelNotReadyException", "ValidationException"})
_TIMEOUT_CODES: Final = frozenset({"ModelTimeoutException", "RequestTimeout", "RequestTimeoutException"})
_ACCEPTED_STOP_REASONS: Final = frozenset({"tool_use", "end_turn"})

_ENVIRONMENT = os.environ  # looked up at call time; never copied


class BedrockRuntimeClient(Protocol):
    """The one boto3 ``bedrock-runtime`` method used here. Tests inject a fake."""

    def converse(self, **kwargs: Any) -> Mapping[str, Any]: ...


ClientFactory = Callable[[str], BedrockRuntimeClient]
Sleeper = Callable[[float], Awaitable[None]]


# --- configuration ------------------------------------------------------------------------------


def _present(environ: Mapping[str, str], name: str) -> bool:
    return (environ.get(name) or "").strip() != ""


def missing_credentials(environ: Mapping[str, str]) -> tuple[str, ...]:
    """Names (never values) still needed for a usable credential, or ``()`` when one is configured.

    A Bedrock API key (``AWS_BEARER_TOKEN_BEDROCK``) is enough, as is a complete access-key pair.
    Only presence is checked; values are not read into anything.
    """
    if _present(environ, BEARER_TOKEN_VARIABLE):
        return ()
    has_key = _present(environ, ACCESS_KEY_VARIABLE)
    has_secret = _present(environ, SECRET_KEY_VARIABLE)
    if has_key and has_secret:
        return ()
    if has_key:
        return (SECRET_KEY_VARIABLE,)
    if has_secret:
        return (ACCESS_KEY_VARIABLE,)
    return (BEARER_TOKEN_VARIABLE, ACCESS_KEY_VARIABLE, SECRET_KEY_VARIABLE)


def _credential_message(missing: tuple[str, ...]) -> str:
    if len(missing) == 1:
        return f"Amazon Bedrock credentials are incomplete: {missing[0]} is not set."
    return (
        "No Amazon Bedrock credentials are configured. Set "
        f"{BEARER_TOKEN_VARIABLE}, or both {ACCESS_KEY_VARIABLE} and {SECRET_KEY_VARIABLE}."
    )


def _setting(environ: Mapping[str, str], names: tuple[str, ...], default: str) -> str:
    for name in names:
        value = (environ.get(name) or "").strip()
        if value:
            return value
    return default


# --- request construction -----------------------------------------------------------------------


def _property_schema(schema: Mapping[str, Any]) -> dict[str, Any]:
    """A registry parameter's JSON schema, simplified for a tool input schema."""
    options = schema.get("anyOf")
    if isinstance(options, list):
        non_null = [item for item in options if isinstance(item, dict) and item.get("type") != "null"]
        if len(non_null) == 1:
            return _property_schema(non_null[0])
    simple: dict[str, Any] = {}
    for key in ("type", "enum", "minimum", "minLength", "maxLength"):
        if key in schema:
            simple[key] = schema[key]
    maximum = schema.get("maximum")
    if isinstance(maximum, int) and maximum < 10**9:
        simple["maximum"] = maximum
    return simple


def build_respond_input_schema(actions: Mapping[str, ActionSpec] = ALLOWED_ACTIONS) -> dict[str, Any]:
    """JSON Schema for the ``respond`` tool: the fields the model writes for an ``AgentResponse``.

    ``version``, ``type`` and ``replyTo`` are transport fields the backend supplies, so the model does
    not write them. The action ``type`` enum and every parameter come from the registry; nothing is
    hand-listed, and no parameter can carry a command.
    """
    parameters: dict[str, Any] = {}
    for spec in actions.values():
        properties = spec.params_model.model_json_schema().get("properties", {})
        for name, schema in properties.items():
            parameters.setdefault(name, _property_schema(schema))
    return {
        "type": "object",
        "properties": {
            "speech": {"type": "string", "minLength": 1, "maxLength": MAX_SPEECH_CHARS},
            "action": {
                "type": "object",
                "properties": {"type": {"type": "string", "enum": list(actions)}, **parameters},
                "required": ["type"],
                "additionalProperties": False,
            },
            "confirmationRequired": {"type": "boolean"},
        },
        "required": ["speech", "action", "confirmationRequired"],
        "additionalProperties": False,
    }


def build_converse_request(
    request: LLMRequest, model_id: str, actions: Mapping[str, ActionSpec] = ALLOWED_ACTIONS
) -> dict[str, Any]:
    """The Converse arguments: system prompt, one user message, one forced ``respond`` tool."""
    return {
        "modelId": model_id,
        "system": [{"text": request.system_prompt}],
        "messages": [{"role": "user", "content": [{"text": request.user_prompt}]}],
        "inferenceConfig": {"maxTokens": MAX_OUTPUT_TOKENS, "temperature": 0},
        "toolConfig": {
            "tools": [
                {
                    "toolSpec": {
                        "name": RESPOND_TOOL_NAME,
                        "description": "Return the spoken answer and the single action to take.",
                        "inputSchema": {"json": build_respond_input_schema(actions)},
                    }
                }
            ],
            "toolChoice": {"tool": {"name": RESPOND_TOOL_NAME}},
        },
    }


# --- response extraction ------------------------------------------------------------------------


def _invalid(category: str) -> LLMClientError:
    return LLMClientError(
        "BEDROCK_INVALID_RESPONSE",
        "Amazon Bedrock returned an answer in an unexpected format.",
        category=category,
    )


def extract_respond_input(response: Any) -> dict[str, Any]:
    """The input of the single ``toolUse`` block named ``respond``; anything else is invalid.

    Free-form text is never accepted as a structured answer, the first block is not assumed to be the
    tool, and a missing, wrongly named, repeated or non-object tool input is rejected. A response cut
    short (``max_tokens``) or stopped by a guardrail is rejected even if it contains a tool block.
    """
    if not isinstance(response, Mapping):
        raise _invalid("malformed_response")
    stop_reason = response.get("stopReason")
    if stop_reason is not None and stop_reason not in _ACCEPTED_STOP_REASONS:
        raise _invalid("stopped_early")
    try:
        content = response["output"]["message"]["content"]
    except (KeyError, TypeError):
        raise _invalid("malformed_response") from None
    if not isinstance(content, list):
        raise _invalid("malformed_response")

    tool_uses = [
        block["toolUse"] for block in content if isinstance(block, Mapping) and isinstance(block.get("toolUse"), Mapping)
    ]
    if not tool_uses:
        raise _invalid("no_tool_use")
    respond_uses = [use for use in tool_uses if use.get("name") == RESPOND_TOOL_NAME]
    if not respond_uses:
        raise _invalid("wrong_tool")
    if len(respond_uses) > 1 or len(tool_uses) > 1:
        raise _invalid("multiple_tool_use")
    tool_input = respond_uses[0].get("input")
    if not isinstance(tool_input, Mapping):
        raise _invalid("bad_tool_input")
    return copy.deepcopy(dict(tool_input))


# --- error classification -----------------------------------------------------------------------


def _unavailable(category: str, message: str, *, recoverable: bool = False) -> LLMClientError:
    return LLMClientError("BEDROCK_UNAVAILABLE", message, category=category, recoverable=recoverable)


def classify_error(error: BaseException) -> LLMClientError:
    """Map an SDK failure to a fixed, safe :class:`LLMClientError`. Nothing from ``error`` is copied."""
    if isinstance(error, LLMClientError):
        return error
    if isinstance(error, (NoCredentialsError, PartialCredentialsError, TokenRetrievalError)):
        missing = (BEARER_TOKEN_VARIABLE, ACCESS_KEY_VARIABLE, SECRET_KEY_VARIABLE)
        return LLMClientError(
            "CREDENTIAL_MISSING", _credential_message(missing), category="credentials_missing", missing=missing
        )
    if isinstance(error, (ReadTimeoutError, ConnectTimeoutError)):
        return LLMClientError(
            "TIMEOUT", "Amazon Bedrock did not answer in time.", category="timeout", recoverable=True
        )
    if isinstance(error, ClientError):
        code = str(error.response.get("Error", {}).get("Code", ""))
        if code in _THROTTLING_CODES:
            return _unavailable(
                "throttled", "Amazon Bedrock is limiting requests right now. Please try again shortly.",
                recoverable=True,
            )
        if code in _ACCESS_CODES:
            return _unavailable(
                "access_denied",
                "Amazon Bedrock refused the request. Check the AWS credentials and that the model is enabled.",
            )
        if code in _MODEL_CODES:
            return _unavailable(
                "model_unavailable",
                "Amazon Bedrock rejected the model request. Check the model ID and region, "
                "and that the model supports tool use.",
            )
        if code in _TIMEOUT_CODES:
            return LLMClientError(
                "TIMEOUT", "Amazon Bedrock did not answer in time.", category="timeout", recoverable=True
            )
        return _unavailable("service_error", "Amazon Bedrock could not complete the request.", recoverable=True)
    if isinstance(error, BotoCoreError):
        # Connection failures, TLS errors, bad region names and other SDK-side problems.
        return _unavailable("network", "Amazon Bedrock could not be reached.", recoverable=True)
    return LLMClientError(
        "INTERNAL", "The reasoning service failed unexpectedly.", category="unexpected"
    )


# --- the client ---------------------------------------------------------------------------------


def _default_client_factory(region: str) -> BedrockRuntimeClient:
    """A real boto3 ``bedrock-runtime`` client. No credential is passed: the SDK reads its own."""
    import boto3
    from botocore.config import Config

    return boto3.client(  # type: ignore[no-any-return]
        "bedrock-runtime",
        region_name=region,
        config=Config(
            connect_timeout=CONNECT_TIMEOUT_SECONDS,
            read_timeout=READ_TIMEOUT_SECONDS,
            # One attempt per call: the only retry is the single throttling retry made below.
            retries={"total_max_attempts": 1},
        ),
    )


class BedrockLLMClient:
    """``LLMClient`` backed by the Amazon Bedrock Converse API.

    Construction does no I/O and touches no credential. Settings are read from the environment on each
    call: ``AWS_REGION`` (default ``us-east-1``), ``BEDROCK_MODEL_ID`` (default
    ``amazon.nova-lite-v1:0``) and the credential variables.
    """

    def __init__(
        self,
        *,
        environ: Mapping[str, str] | None = None,
        client_factory: ClientFactory = _default_client_factory,
        sleep: Sleeper = asyncio.sleep,
    ) -> None:
        self._environ = environ
        self._client_factory = client_factory
        self._sleep = sleep
        self._client: BedrockRuntimeClient | None = None
        self._client_region: str | None = None
        self._lock = threading.Lock()

    def _env(self) -> Mapping[str, str]:
        return self._environ if self._environ is not None else _ENVIRONMENT

    def _client_for(self, region: str) -> BedrockRuntimeClient:
        """Create the boto3 client on first use (in the worker thread, never on the event loop)."""
        with self._lock:
            if self._client is None or self._client_region != region:
                self._client = self._client_factory(region)
                self._client_region = region
            return self._client

    def _converse(self, region: str, arguments: dict[str, Any]) -> Mapping[str, Any]:
        return self._client_for(region).converse(**arguments)

    async def respond(self, request: LLMRequest) -> RawModelOutput:
        """One forced-tool Converse call. Raises :class:`LLMClientError`; never returns a guess."""
        environ = self._env()
        missing = missing_credentials(environ)
        if missing:
            raise LLMClientError(
                "CREDENTIAL_MISSING", _credential_message(missing), category="credentials_missing", missing=missing
            )

        region = _setting(environ, (REGION_VARIABLE, FALLBACK_REGION_VARIABLE), DEFAULT_REGION)
        model_id = _setting(environ, (MODEL_VARIABLE,), DEFAULT_MODEL_ID)
        arguments = build_converse_request(request, model_id)

        response = await self._converse_with_one_throttle_retry(region, arguments)
        return extract_respond_input(response)

    async def _converse_with_one_throttle_retry(
        self, region: str, arguments: dict[str, Any]
    ) -> Mapping[str, Any]:
        for attempt in range(MAX_THROTTLE_RETRIES + 1):
            try:
                return await asyncio.to_thread(self._converse, region, arguments)
            except Exception as error:  # noqa: BLE001 - classified below; cancellation is not caught
                failure = classify_error(error)
                self._log(failure, attempt)
                if failure.category == "throttled" and attempt < MAX_THROTTLE_RETRIES:
                    await self._sleep(THROTTLE_RETRY_DELAY_SECONDS)
                    continue
                raise failure from None
        raise AssertionError("unreachable: the loop always returns or raises")  # pragma: no cover

    def _log(self, failure: LLMClientError, attempt: int) -> None:
        """Metadata only: a fixed category and the attempt number, never SDK text or request content."""
        logger.warning(
            "bedrock call failed %s",
            redact(format_metadata(category=failure.category, code=failure.code, attempt=attempt + 1)),
        )
