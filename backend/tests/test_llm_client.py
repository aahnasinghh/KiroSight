"""Task 7.2 tests for the provider-neutral LLM seam and offline stub."""

from __future__ import annotations

import asyncio
import socket
from collections.abc import Mapping

import pytest
from pydantic import ValidationError

from app.agent.llm_client import LLMClient, LLMRequest, StubLLMClient
from app.protocol.messages import AgentResponse, PROTOCOL_VERSION
from app.protocol.validators import parse_message


REQUEST = LLMRequest(
    system_prompt="Answer through the response contract.",
    user_prompt="Explain the synthetic error.",
    reply_to="request-7",
)


@pytest.mark.asyncio
async def test_stub_implements_async_llm_client_protocol() -> None:
    client = StubLLMClient()
    # Static typing checks the Protocol implementation; runtime checks are intentionally avoided
    # because LLMClient is not marked @runtime_checkable.
    typed_client: LLMClient = client
    result = await typed_client.respond(REQUEST)
    assert isinstance(result, Mapping)
    assert asyncio.iscoroutinefunction(client.respond)


@pytest.mark.asyncio
async def test_stub_returns_a_protocol_valid_agent_response_with_no_action() -> None:
    result = await StubLLMClient().respond(REQUEST)

    parsed = AgentResponse.model_validate(result)
    assert parsed.version == PROTOCOL_VERSION
    assert parsed.type == "agent_response"
    assert parsed.replyTo == "request-7"
    assert parsed.action.type == "NO_ACTION"
    assert parsed.confirmationRequired is False
    assert parse_message(parsed.model_dump(mode="json")) == parsed


@pytest.mark.asyncio
async def test_stub_is_deterministic_and_returns_independent_mappings() -> None:
    client = StubLLMClient()
    first = await client.respond(REQUEST)
    second = await client.respond(
        LLMRequest(system_prompt="different", user_prompt="different", reply_to="request-7")
    )

    assert first == second
    assert first is not second
    assert first["action"] is not second["action"]


@pytest.mark.asyncio
async def test_stub_requires_no_credentials_and_performs_no_network_io(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
        "AWS_PROFILE",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
        "BEDROCK_MODEL_ID",
    ):
        monkeypatch.delenv(name, raising=False)

    def fail_connection(*_args: object, **_kwargs: object) -> socket.socket:
        raise AssertionError("StubLLMClient must not open a network connection")

    monkeypatch.setattr(socket, "create_connection", fail_connection)
    result = await StubLLMClient().respond(REQUEST)
    assert AgentResponse.model_validate(result).action.type == "NO_ACTION"


def test_llm_request_is_immutable_and_provider_neutral() -> None:
    request = REQUEST
    with pytest.raises((AttributeError, TypeError)):
        request.reply_to = "changed"  # type: ignore[misc]
    assert not hasattr(request, "model_id")
    assert not hasattr(request, "credentials")


def test_protocol_agent_response_remains_strict_about_message_extras() -> None:
    raw = {
        "version": 1,
        "type": "agent_response",
        "replyTo": "request-7",
        "speech": "Safe response.",
        "action": {"type": "NO_ACTION"},
        "confirmationRequired": False,
        "unexpected": True,
    }
    with pytest.raises(ValidationError):
        AgentResponse.model_validate(raw)
