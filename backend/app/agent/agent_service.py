"""Agent orchestration (Task 7.8): prompt, one ``LLMClient`` call, the response parser.

``AgentService.respond`` turns one ``agent_request`` into exactly one protocol message:

* an :class:`~app.protocol.messages.AgentResponse` whose speech was limited and whose action is one of
  the eight allow-listed actions with valid parameters, or
* an :class:`~app.protocol.messages.ErrorMessage` (``BEDROCK_UNAVAILABLE``, ``CREDENTIAL_MISSING`` or
  ``BEDROCK_INVALID_RESPONSE``) with no action.

It never raises for a provider failure, never retries (the Bedrock client owns its single throttling
retry), and never falls back to another client: the stub is used only when the configuration selects
it. It does not execute anything; actions are data for the extension to validate and confirm.

Error text is fixed and safe. Provider messages, request content and model output are never copied
into errors or logs; only a fixed category is logged.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

from app.agent.llm_client import LLMClient, LLMClientError, StubLLMClient
from app.agent.prompt import build_llm_request
from app.agent.response_parser import AGENT_FAILURE_MESSAGE, AgentFailure, parse_agent_output
from app.config import Config, LlmChoice
from app.logging_utils import format_metadata, redact
from app.protocol.messages import (
    PROTOCOL_VERSION,
    ActionEnvelope,
    AgentRequest,
    AgentResponse,
    Capabilities,
    ErrorCode,
    ErrorMessage,
)
from app.session import STUB_CAPABILITIES, Turn

__all__ = [
    "REASONING_FAILED_PREFIX",
    "AgentSelection",
    "AgentService",
    "select_agent",
]

logger = logging.getLogger("kirosight.backend.agent")

#: Requirement 12.3: say the explanation could not be generated because the reasoning service failed.
REASONING_FAILED_PREFIX: Final = "The explanation couldn't be generated because the reasoning service failed."

_NO_ACTION: Final = "NO_ACTION"


def _error(request: AgentRequest, code: ErrorCode, message: str, *, recoverable: bool) -> ErrorMessage:
    return ErrorMessage(
        version=PROTOCOL_VERSION,
        type="error_message",
        replyTo=request.id,
        code=code,
        message=message,
        recoverable=recoverable,
    )


def _from_client_error(request: AgentRequest, error: LLMClientError) -> ErrorMessage:
    """Map a provider failure to one of the three agent error codes, with a fixed safe message."""
    if error.code == "CREDENTIAL_MISSING":
        code: ErrorCode = "CREDENTIAL_MISSING"
    elif error.code == "BEDROCK_INVALID_RESPONSE":
        return _error(request, "BEDROCK_INVALID_RESPONSE", AGENT_FAILURE_MESSAGE, recoverable=True)
    else:  # BEDROCK_UNAVAILABLE, TIMEOUT, INTERNAL and anything else a client may raise
        code = "BEDROCK_UNAVAILABLE"
    return _error(
        request, code, f"{REASONING_FAILED_PREFIX} {error.message}", recoverable=error.recoverable
    )


class AgentService:
    """Builds the prompt, calls the injected ``LLMClient`` once, parses the result."""

    def __init__(self, client: LLMClient) -> None:
        self._client = client

    async def respond(self, request: AgentRequest) -> AgentResponse | ErrorMessage:
        """The ``AgentResponder`` seam: a request without conversation history."""
        return await self.respond_with_history(request, ())

    async def respond_with_history(
        self, request: AgentRequest, history: Sequence[Turn] = ()
    ) -> AgentResponse | ErrorMessage:
        """Answer ``request`` using the session's recent turns as context (data only).

        ``kind='utterance'`` answers the user's request; ``kind='summarize_test_run'`` summarizes the
        bounded test-run summary. A summary carries no action: anything but ``NO_ACTION`` is replaced
        by ``NO_ACTION`` so a summary can never navigate or run tests.
        """
        try:
            raw = await self._client.respond(build_llm_request(request, history))
        except LLMClientError as error:
            self._log(request, error.category, error.code)
            return _from_client_error(request, error)
        except Exception as error:  # noqa: BLE001 - a misbehaving client must not crash the connection
            self._log(request, "client_exception", type(error).__name__)
            return _error(
                request,
                "BEDROCK_UNAVAILABLE",
                f"{REASONING_FAILED_PREFIX} The reasoning service failed unexpectedly.",
                recoverable=False,
            )

        parsed = parse_agent_output(raw, reply_to=request.id)
        if isinstance(parsed, AgentFailure):
            self._log(request, parsed.reason, parsed.error_code)
            return _error(request, "BEDROCK_INVALID_RESPONSE", parsed.message, recoverable=True)

        if request.kind == "summarize_test_run" and (
            parsed.action.type != _NO_ACTION or parsed.action.model_extra or parsed.confirmationRequired
        ):
            return AgentResponse(
                version=PROTOCOL_VERSION,
                type="agent_response",
                replyTo=parsed.replyTo,
                speech=parsed.speech,
                action=ActionEnvelope(type=_NO_ACTION),
                confirmationRequired=False,
            )
        return parsed

    @staticmethod
    def _log(request: AgentRequest, category: str, code: str) -> None:
        """Metadata only: the request kind and a fixed category. Never content, speech or provider text."""
        logger.warning(
            "agent request failed %s", redact(format_metadata(kind=request.kind, category=category, code=code))
        )


# --- selecting the client by configuration ------------------------------------------------------


@dataclass(frozen=True)
class AgentSelection:
    """The chosen agent and the capabilities ``hello_ack`` should report for it."""

    agent: AgentService
    capabilities: Capabilities
    llm: LlmChoice


def select_agent(choice: LlmChoice, config: Config) -> AgentSelection:
    """Build the agent for ``choice`` (``KIROSIGHT_LLM``). The choice is explicit and never changes.

    ``stub``: the offline canned client; ``bedrock`` is reported as unavailable.
    ``bedrock``: the Amazon Bedrock client. ``capabilities.bedrock`` is true only when a credential is
    configured (a Bedrock API key or a complete access-key pair); without one every request fails with
    ``CREDENTIAL_MISSING`` rather than being answered by the stub.
    """
    if choice == "stub":
        return AgentSelection(AgentService(StubLLMClient()), STUB_CAPABILITIES, "stub")

    from app.agent.bedrock_service import BedrockLLMClient  # imported only when Bedrock is selected

    ready = not config.missing_credentials("bedrock")
    capabilities = Capabilities(bedrock=ready, stt=False, tts=False, mic="not_applicable")
    return AgentSelection(AgentService(BedrockLLMClient()), capabilities, "bedrock")
