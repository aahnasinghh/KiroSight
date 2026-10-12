"""Task 6.12 unit tests for the stub agent and small pure helpers in ``app.main``.

WebSocket round trips (handshake, Origin, token, cancel) are Task 6.13's TestClient tests.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import main
from app.agent.stub_agent import STUB_SPEECH, StubAgent
from app.protocol.messages import AgentRequest, AgentResponse, ErrorMessage, dump_message
from app.protocol.validators import ProtocolValidationError, parse_message

FIXTURES = (
    Path(__file__).resolve().parents[2] / "extension" / "src" / "protocol" / "fixtures" / "messages"
)


def agent_request(drop: tuple[str, ...] = (), **changes: Any) -> AgentRequest:
    raw = json.loads((FIXTURES / "agent_request.json").read_text(encoding="utf-8"))
    raw.update(changes)
    for key in drop:
        del raw[key]
    parsed = parse_message(raw)
    assert isinstance(parsed, AgentRequest)
    return parsed


# --- stub agent ---


async def test_stub_agent_returns_the_canned_no_action_response() -> None:
    request = agent_request(id="req-42")
    response = await StubAgent().respond(request)

    assert isinstance(response, AgentResponse)
    assert response.version == 1
    assert response.type == "agent_response"
    assert response.replyTo == "req-42"
    assert response.speech == STUB_SPEECH == "KiroSight backend is connected."
    assert len(response.speech) <= 600
    assert response.action.type == "NO_ACTION"
    assert response.action.model_extra == {}
    assert response.confirmationRequired is False


async def test_stub_response_is_a_valid_protocol_message() -> None:
    response = await StubAgent().respond(agent_request(id="req-7"))
    wire = dump_message(response)
    assert wire == {
        "version": 1,
        "type": "agent_response",
        "replyTo": "req-7",
        "speech": STUB_SPEECH,
        "action": {"type": "NO_ACTION"},
        "confirmationRequired": False,
    }
    reparsed = parse_message(json.loads(json.dumps(wire)))
    assert not isinstance(reparsed, ProtocolValidationError)
    assert isinstance(reparsed, AgentResponse) and reparsed.replyTo == "req-7"


async def test_stub_ignores_the_request_content() -> None:
    plain = await StubAgent().respond(agent_request(id="a"))
    summary = await StubAgent().respond(agent_request(id="a", kind="summarize_test_run"))
    assert plain == summary  # only the id is read; no source or utterance is inspected


# --- pure helpers in app.main ---


def test_websocket_limit_is_exactly_two_mebibytes() -> None:
    assert main.WS_MAX_SIZE_BYTES == 2 * 1024 * 1024 == 2_097_152


def test_error_helper_builds_a_valid_error_message_without_reply_to() -> None:
    wire = dump_message(main._error("VALIDATION_FAILED", "The message was not valid."))
    assert wire == {
        "version": 1,
        "type": "error_message",
        "code": "VALIDATION_FAILED",
        "message": "The message was not valid.",
        "recoverable": True,
    }
    assert isinstance(parse_message(wire), ErrorMessage)
    with_reply = dump_message(main._error("INTERNAL", "x", reply_to="r1"))
    assert with_reply["replyTo"] == "r1"


def test_configured_token_prefers_the_explicit_value_then_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(main.AUTH_TOKEN_VARIABLE, raising=False)
    assert main._configured_token(None) is None
    assert main._configured_token("") is None
    assert main._configured_token("   ") is None
    assert main._configured_token("explicit") == "explicit"
    monkeypatch.setenv(main.AUTH_TOKEN_VARIABLE, "from-env")
    assert main._configured_token(None) == "from-env"
    assert main._configured_token("explicit") == "explicit"


def test_turn_text_never_uses_context_or_code() -> None:
    assert main._turn_text(agent_request()) == "explain this error"
    summary = agent_request(drop=("utterance",), kind="summarize_test_run")
    assert main._turn_text(summary) == "(test run summary)"
    assert main._turn_text(agent_request(drop=("utterance",))) == "(no utterance)"


def test_app_exposes_health_and_ws_routes() -> None:
    paths = {route.path for route in main.app.routes}
    assert {"/health", "/ws"} <= paths


def test_health_response_is_minimal() -> None:
    response = TestClient(main.app).get("/health")  # HTTP only: WebSocket tests are Task 6.13
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
