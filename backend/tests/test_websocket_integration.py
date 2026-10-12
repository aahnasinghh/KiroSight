"""Task 6.13: FastAPI TestClient WebSocket integration tests for the Task 6.12 backend.

No real TCP server and no sleeps. Each test builds a fresh app (fresh Session, agent and token) via
``create_app(agent=..., auth_token=...)``; the only environment touch is an autouse fixture that
removes any ambient ``KIROSIGHT_AUTH_TOKEN`` (restored by monkeypatch).

The TestClient runs the ASGI app directly, so it exercises the APPLICATION-level 2 MiB limit; the
server-level ``ws_max_size`` is checked separately by capturing the arguments given to uvicorn.
"""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession
from starlette.websockets import WebSocketDisconnect

from app import main
from app.agent.stub_agent import STUB_SPEECH, StubAgent
from app.main import WS_MAX_SIZE_BYTES, create_app
from app.protocol.messages import AgentRequest, AgentResponse, ErrorMessage, HelloAck
from app.protocol.validators import ProtocolValidationError, parse_message

FIXTURES = (
    Path(__file__).resolve().parents[2] / "extension" / "src" / "protocol" / "fixtures" / "messages"
)
SENTINEL = "SUPER_SECRET_BAD_PAYLOAD_123"
TOKEN = "integration-secret"
WRONG_TOKEN = "wrong-integration-token"
CLOSE_POLICY_VIOLATION = 1008
CLOSE_MESSAGE_TOO_BIG = 1009


@pytest.fixture(autouse=True)
def no_ambient_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(main.AUTH_TOKEN_VARIABLE, raising=False)


# --- helpers ---


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def request_with_id(request_id: str) -> dict[str, Any]:
    return {**fixture("agent_request"), "id": request_id}


def send(ws: WebSocketTestSession, message: dict[str, Any]) -> None:
    ws.send_text(json.dumps(message))


def receive(ws: WebSocketTestSession) -> tuple[Any, str]:
    """Next frame as (parsed protocol model, raw text). Parsing proves it is a valid message."""
    raw = ws.receive_text()
    parsed = parse_message(json.loads(raw))
    assert not isinstance(parsed, ProtocolValidationError), raw
    return parsed, raw


def handshake(ws: WebSocketTestSession, **hello_changes: Any) -> HelloAck:
    send(ws, {**fixture("hello"), **hello_changes})
    ack, _ = receive(ws)
    assert isinstance(ack, HelloAck)
    return ack


def assert_works(ws: WebSocketTestSession, request_id: str) -> None:
    """The socket still serves a normal request after an earlier (invalid) message."""
    send(ws, request_with_id(request_id))
    response, _ = receive(ws)
    assert isinstance(response, AgentResponse)
    assert response.replyTo == request_id


def assert_error(frame: tuple[Any, str], code: str, *forbidden: str) -> None:
    message, raw = frame
    assert isinstance(message, ErrorMessage)
    assert message.code == code
    for text in forbidden:
        assert text not in raw


class RecordingAgent:
    """Wraps the real stub and records which requests it served."""

    def __init__(self) -> None:
        self.served: list[str] = []

    async def respond(self, request: AgentRequest) -> AgentResponse:
        self.served.append(request.id)
        return await StubAgent().respond(request)


class BlockingAgent:
    """Blocks the request id ``cancel-me`` until cancelled; answers every other id immediately.

    threading.Event lets the test thread observe the ASGI loop thread without sleeping.
    """

    BLOCKED_ID = "cancel-me"

    def __init__(self) -> None:
        self.started = threading.Event()
        self.cancelled = threading.Event()
        self.finished: list[str] = []

    async def respond(self, request: AgentRequest) -> AgentResponse:
        if request.id == self.BLOCKED_ID:
            self.started.set()
            try:
                await asyncio.Event().wait()  # never set: only cancellation can end this
            except asyncio.CancelledError:
                self.cancelled.set()
                raise
        response = await StubAgent().respond(request)
        self.finished.append(request.id)
        return response


# --- health ---


def test_health_endpoint() -> None:
    response = TestClient(create_app()).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# --- handshake ---


def test_hello_receives_a_valid_hello_ack_with_stub_capabilities() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        send(ws, fixture("hello"))
        ack, raw = receive(ws)

    assert isinstance(ack, HelloAck)
    assert ack.version == 1
    assert ack.type == "hello_ack"
    assert ack.supportedVersions == [1]
    assert ack.capabilities.bedrock is False
    assert ack.capabilities.stt is False
    assert ack.capabilities.tts is False
    assert ack.capabilities.mic == "not_applicable"
    assert json.loads(raw)["capabilities"] == {
        "bedrock": False,
        "stt": False,
        "tts": False,
        "mic": "not_applicable",
    }


def test_a_non_hello_message_before_the_handshake_is_refused_but_the_socket_stays_open() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        send(ws, request_with_id("too-early"))
        assert_error(receive(ws), "VALIDATION_FAILED")
        handshake(ws)  # the connection was not poisoned or closed
        assert_works(ws, "after-hello")


# --- Origin ---


@pytest.mark.parametrize("origin", ["https://example.invalid", "http://localhost", "null"])
def test_any_origin_header_is_rejected_before_the_handshake(origin: str) -> None:
    client = TestClient(create_app())
    with pytest.raises(WebSocketDisconnect) as rejected:
        with client.websocket_connect("/ws", headers={"origin": origin}):
            pytest.fail("a connection carrying an Origin header was accepted")
    assert rejected.value.code == CLOSE_POLICY_VIOLATION


# --- shared token ---


def test_token_is_optional_when_none_is_configured() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        handshake(ws)  # no token supplied
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        handshake(ws, token="an-unneeded-token")  # a supplied token is ignored when none is set


@pytest.mark.parametrize(
    "hello_changes, label",
    [({}, "missing token"), ({"token": WRONG_TOKEN}, "wrong token"), ({"token": ""}, "empty token")],
)
def test_configured_token_rejects_missing_or_wrong_tokens_and_closes(
    hello_changes: dict[str, Any], label: str
) -> None:
    with TestClient(create_app(auth_token=TOKEN)).websocket_connect("/ws") as ws:
        send(ws, {**fixture("hello"), **hello_changes})
        assert_error(receive(ws), "UNAUTHORIZED", TOKEN, WRONG_TOKEN)
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
        assert closed.value.code == CLOSE_POLICY_VIOLATION, label


def test_configured_token_accepts_the_correct_token() -> None:
    with TestClient(create_app(auth_token=TOKEN)).websocket_connect("/ws") as ws:
        send(ws, {**fixture("hello"), "token": TOKEN})
        ack, raw = receive(ws)
        assert isinstance(ack, HelloAck)
        assert TOKEN not in raw
        assert_works(ws, "authorized-request")


def test_token_is_never_echoed_on_the_authenticated_connection() -> None:
    with TestClient(create_app(auth_token=TOKEN)).websocket_connect("/ws") as ws:
        send(ws, {**fixture("hello"), "token": TOKEN})
        receive(ws)
        send(ws, {**fixture("hello"), "token": TOKEN})  # a second hello is refused
        assert_error(receive(ws), "VALIDATION_FAILED", TOKEN)


# --- validation failures keep the connection open ---


def test_malformed_json_gets_a_safe_error_and_the_connection_stays_open() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        handshake(ws)
        ws.send_text('{"' + SENTINEL)  # truncated JSON containing a recognizable payload
        assert_error(receive(ws), "VALIDATION_FAILED", SENTINEL)
        ws.send_text("{")
        assert_error(receive(ws), "VALIDATION_FAILED")
        assert_works(ws, "after-malformed-json")


def test_invalid_protocol_message_gets_a_safe_error_and_the_connection_stays_open() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        handshake(ws)
        bad = {**fixture("hello"), "unexpected": SENTINEL, SENTINEL: 1}
        send(ws, bad)
        assert_error(receive(ws), "VALIDATION_FAILED", SENTINEL)
        send(ws, {**request_with_id("r1"), "utterance": {"text": SENTINEL, "source": "telepathy"}})
        assert_error(receive(ws), "VALIDATION_FAILED", SENTINEL)
        assert_works(ws, "after-invalid-message")


def test_invalid_hello_before_the_handshake_keeps_waiting_for_a_valid_hello() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        send(ws, {**fixture("hello"), "unexpected": SENTINEL})
        assert_error(receive(ws), "VALIDATION_FAILED", SENTINEL)
        handshake(ws)
        assert_works(ws, "after-bad-first-hello")


def test_unsupported_version_is_classified_and_the_socket_stays_usable() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        handshake(ws)
        for version in (2, 0, "1", True):
            send(ws, {**request_with_id("v"), "version": version})
            assert_error(receive(ws), "UNSUPPORTED_VERSION")
        assert_works(ws, "after-bad-version")


def test_unknown_type_is_classified_without_echoing_it() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        handshake(ws)
        for unknown in ("does_not_exist", SENTINEL, "RUN_COMMAND"):
            send(ws, {**request_with_id("t"), "type": unknown})
            assert_error(receive(ws), "UNKNOWN_TYPE", SENTINEL, "RUN_COMMAND")
        assert_works(ws, "after-unknown-type")


def test_binary_frames_are_refused_without_closing() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        handshake(ws)
        ws.send_bytes(b"\x00\x01binary")
        assert_error(receive(ws), "VALIDATION_FAILED")
        assert_works(ws, "after-binary")


# --- stub agent ---


def test_stub_agent_round_trip() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, request_with_id("round-trip-1"))
        response, raw = receive(ws)

    assert isinstance(response, AgentResponse)
    assert response.version == 1
    assert response.replyTo == "round-trip-1"
    assert response.speech == STUB_SPEECH == "KiroSight backend is connected."
    assert response.action.type == "NO_ACTION"
    assert response.action.model_extra == {}
    assert response.confirmationRequired is False
    assert json.loads(raw)["action"] == {"type": "NO_ACTION"}


def test_each_request_is_answered_once_in_order_with_its_own_id() -> None:
    agent = RecordingAgent()
    with TestClient(create_app(agent=agent)).websocket_connect("/ws") as ws:
        handshake(ws)
        for request_id in ("a", "b", "c"):
            assert_works(ws, request_id)
    assert agent.served == ["a", "b", "c"]


# --- cancel ---


def test_cancel_stops_the_running_task_and_no_response_is_ever_sent_for_it() -> None:
    agent = BlockingAgent()
    with TestClient(create_app(agent=agent)).websocket_connect("/ws") as ws:
        handshake(ws)

        send(ws, request_with_id("cancel-me"))
        assert agent.started.wait(timeout=5), "the agent task never became in-flight"
        assert not agent.cancelled.is_set()

        send(ws, {**fixture("cancel"), "targetId": "cancel-me"})
        assert agent.cancelled.wait(timeout=5), "the agent did not observe cancellation"

        # The connection is still alive. Frames arrive in order, so the first frame after the
        # cancel must be the next request's response, never a late one for the cancelled id.
        for request_id in ("after-cancel-1", "after-cancel-2"):
            send(ws, request_with_id(request_id))
            response, _ = receive(ws)
            assert isinstance(response, AgentResponse)
            assert response.replyTo == request_id

    assert "cancel-me" not in agent.finished
    assert agent.finished == ["after-cancel-1", "after-cancel-2"]


def test_cancel_of_an_unknown_target_is_harmless() -> None:
    agent = RecordingAgent()
    with TestClient(create_app(agent=agent)).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, {**fixture("cancel"), "targetId": "nobody-has-this-id"})
        assert_works(ws, "after-unknown-cancel")
    assert agent.served == ["after-unknown-cancel"]  # the stray cancel affected nothing


def test_cancel_before_the_handshake_is_not_acted_on() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        send(ws, fixture("cancel"))
        assert_error(receive(ws), "VALIDATION_FAILED")
        handshake(ws)


def test_disconnect_cancels_work_that_is_still_running() -> None:
    agent = BlockingAgent()
    with TestClient(create_app(agent=agent)).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, request_with_id("cancel-me"))
        assert agent.started.wait(timeout=5)
    # Leaving the context closes the socket; the connection cleanup must cancel the live task.
    assert agent.cancelled.wait(timeout=5)
    assert "cancel-me" not in agent.finished


# --- size limit ---


def test_oversized_message_closes_the_connection_with_1009() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        handshake(ws)
        ws.send_text("x" * (WS_MAX_SIZE_BYTES + 1))
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
        assert closed.value.code == CLOSE_MESSAGE_TOO_BIG


def test_a_message_exactly_at_the_limit_is_still_processed() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        handshake(ws)
        ws.send_text(" " * WS_MAX_SIZE_BYTES)  # at the limit: not too big, just invalid JSON
        assert_error(receive(ws), "VALIDATION_FAILED")
        assert_works(ws, "after-max-size")


def test_the_server_is_started_with_the_ws_max_size_and_a_loopback_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """TestClient bypasses uvicorn, so the server-level limit is checked via the launch arguments."""
    import uvicorn

    captured: dict[str, Any] = {}
    monkeypatch.setattr(uvicorn, "run", lambda application, **kwargs: captured.update(kwargs))
    monkeypatch.setenv("KIROSIGHT_HOST", "127.0.0.1")
    monkeypatch.setenv("KIROSIGHT_PORT", "8765")

    main.run()

    assert captured["ws_max_size"] == WS_MAX_SIZE_BYTES == 2 * 1024 * 1024
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 8765


def test_the_server_refuses_to_start_on_a_non_loopback_host(monkeypatch: pytest.MonkeyPatch) -> None:
    import uvicorn

    from app.config import ConfigError

    started: list[bool] = []
    monkeypatch.setattr(uvicorn, "run", lambda application, **kwargs: started.append(True))
    monkeypatch.setenv("KIROSIGHT_HOST", "0.0.0.0")

    with pytest.raises(ConfigError):
        main.run()
    assert started == []
