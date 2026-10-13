"""Provider-neutral LLM seam and deterministic offline client.

Task 7.2 deliberately contains no Bedrock SDK usage and no provider-specific implementation. The
future Bedrock client will implement the same :class:`LLMClient` protocol and return the same
``RawModelOutput`` shape for the response parser.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol, TypeAlias

from app.agent.stub_agent import STUB_SPEECH
from app.protocol.messages import AgentResponse, ErrorCode, TestRunSummary, WireContext

__all__ = [
    "LLMClient",
    "LLMClientError",
    "LLMRequest",
    "RawModelOutput",
    "StubLLMClient",
]


class LLMClientError(Exception):
    """A provider failure, reported with a wire error code and a fixed, safe message.

    This is the seam's failure contract (added in Task 7.7): a client that cannot produce a model
    output raises this instead of inventing one, and the orchestrator (Task 7.8) turns it into an
    ``error_message``. ``code`` is a protocol ``ErrorCode``; ``message`` is safe to show to the user
    and never contains provider text, credentials or request content; ``category`` is a short fixed
    label for metadata-only logging; ``missing`` names (never values) any missing credentials.
    """

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        category: str,
        recoverable: bool = False,
        missing: tuple[str, ...] = (),
    ) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.message = message
        self.category = category
        self.recoverable = recoverable
        self.missing = missing

    def __str__(self) -> str:
        return self.message


@dataclass(frozen=True)
class LLMRequest:
    """Provider-neutral material an agent service may send to an LLM.

    Prompt construction remains outside this seam (Task 7.6). Context and test-run data are
    optional because different request kinds do not require both. History is bounded by the caller;
    this interface does not retain or log any request data.
    """

    system_prompt: str
    user_prompt: str
    context: WireContext | None = None
    test_run: TestRunSummary | None = None
    history: tuple[tuple[str, str], ...] = field(default_factory=tuple)
    reply_to: str = "stub-reply"


# A raw provider result is intentionally not an AgentResponse yet. Task 7.3 owns parsing and safe
# failure handling; both the future Bedrock client and this stub return this provider-neutral shape.
RawModelOutput: TypeAlias = Mapping[str, Any]


class LLMClient(Protocol):
    """Replaceable async seam for the sole planned LLM provider."""

    async def respond(self, request: LLMRequest) -> RawModelOutput:
        """Return one raw model output without executing actions or performing retries."""
        ...


class StubLLMClient:
    """Offline deterministic client used when live Bedrock access is unavailable.

    It reads no request fields, performs no I/O and proposes ``NO_ACTION``. A fresh mapping is
    returned on every call so callers cannot mutate a later result through shared state. The
    construction assertion keeps this development fallback aligned with the real wire envelope;
    Task 7.3 remains responsible for parsing untrusted model output in production orchestration.
    """

    async def respond(self, request: LLMRequest) -> RawModelOutput:
        response = AgentResponse(
            version=1,
            type="agent_response",
            replyTo=request.reply_to,
            speech=STUB_SPEECH,
            action={"type": "NO_ACTION"},
            confirmationRequired=False,
        )
        return response.model_dump(mode="json")
