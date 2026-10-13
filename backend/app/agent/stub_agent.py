"""Canned stub agent for Milestone 6 (no Bedrock, no reasoning, no action proposals)."""

from __future__ import annotations

from typing import Protocol

from app.protocol.messages import (
    PROTOCOL_VERSION,
    ActionEnvelope,
    AgentRequest,
    AgentResponse,
    ErrorMessage,
)

__all__ = ["STUB_SPEECH", "AgentResponder", "StubAgent"]

STUB_SPEECH = "KiroSight backend is connected."


class AgentResponder(Protocol):
    """The seam the WebSocket layer calls. Tests may inject a slow or failing implementation."""

    async def respond(self, request: AgentRequest) -> AgentResponse | ErrorMessage: ...


class StubAgent:
    """Always answers with the same short text and ``NO_ACTION``. It reads nothing from the request
    except its id, so it never inspects code, diagnostics or utterances."""

    async def respond(self, request: AgentRequest) -> AgentResponse:
        return AgentResponse(
            version=PROTOCOL_VERSION,
            type="agent_response",
            replyTo=request.id,
            speech=STUB_SPEECH,
            action=ActionEnvelope(type="NO_ACTION"),
            confirmationRequired=False,
        )
