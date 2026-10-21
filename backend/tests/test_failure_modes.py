"""Task 10.2 (backend half): the reasoning failure modes as one table, over the real WebSocket.

Feature: kirosight-mvp, Task 10.2. Design failure modes F2 (Bedrock unavailable), F6 (invalid AI
response) and the allow-list side of F7 (an action outside the allow-list). Requirements 5.5, 12.3, 13.4.

The unit tests of the service, the parser and the Bedrock client already check each piece. What this
file adds is the invariants a user depends on, asserted together for every failure on the wire:

* exactly one ``error_message`` answers the request, carrying its id, the right code and ``recoverable``;
* the text is the fixed, safe sentence: no provider text, no secret, no model content, no action;
* nothing was retried and no second provider (or the stub) was used;
* the connection survives and the very next request is answered normally (recovery).

Everything is offline: a scripted fake replaces Bedrock, and ``boto3``, the network and the stub are
patched to fail the test if reached. No credential is read.
"""

from __future__ import annotations

import json
import socket
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Final

import pytest
from fastapi.testclient import TestClient

from app import main
from app.agent.agent_service import REASONING_FAILED_PREFIX, AgentService
from app.agent.llm_client import LLMClientError, LLMRequest, StubLLMClient
from app.agent.response_parser import AGENT_FAILURE_MESSAGE
from app.protocol.messages import AgentResponse, ErrorMessage, HelloAck
from app.protocol.validators import parse_message

FIXTURES: Final = Path(__file__).resolve().parents[2] / "extension" / "src" / "protocol" / "fixtures" / "messages"
SECRET: Final = "SENTINEL_SECRET_VALUE_10201"
PROVIDER_TEXT: Final = "PROVIDER_RAW_TEXT_SENTINEL_10201"
GOOD: Final[dict[str, Any]] = {
    "speech": "There is one error on line 3.",
    "action": {"type": "NO_ACTION"},
    "confirmationRequired": False,
}


class FakeClient:
    """Scripted ``LLMClient``: records requests; returns or raises the next outcome (the last repeats)."""

    def __init__(self, *outcomes: Any) -> None:
        self.outcomes = list(outcomes) or [GOOD]
        self.requests: list[LLMRequest] = []

    async def respond(self, request: LLMRequest) -> Mapping[str, Any]:
        self.requests.append(request)
        outcome = self.outcomes.pop(0) if len(self.outcomes) > 1 else self.outcomes[0]
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome  # type: ignore[no-any-return]


@pytest.fixture(autouse=True)
def nothing_outside_the_fake(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("a test reached the real AWS SDK, the network, or the stub fallback")

    import boto3

    monkeypatch.setattr(boto3, "client", forbidden)
    monkeypatch.setattr(boto3, "Session", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(StubLLMClient, "respond", forbidden)


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def handshake(ws: Any) -> None:
    ws.send_text(json.dumps(fixture("hello")))
    assert isinstance(parse_message(json.loads(ws.receive_text())), HelloAck)


def ask(ws: Any, request_id: str) -> tuple[Any, str]:
    """Send one agent request; return the parsed reply and its raw text."""
    ws.send_text(json.dumps({**fixture("agent_request"), "id": request_id, "utterance": {"text": "explain this error"}}))
    raw = ws.receive_text()
    return parse_message(json.loads(raw)), raw


def unavailable(message: str, *, category: str, recoverable: bool, code: str = "BEDROCK_UNAVAILABLE") -> LLMClientError:
    return LLMClientError(code, message, category=category, recoverable=recoverable)  # type: ignore[arg-type]


def tainted(**changes: Any) -> dict[str, Any]:
    """A model answer that carries recognizable content, so a leak of it into the reply is detectable."""
    return {**GOOD, "speech": f"{PROVIDER_TEXT} is the cause.", **changes}


# --- F2: Bedrock unavailable --------------------------------------------------------------------

F2_ROWS: Final = [
    pytest.param(
        unavailable("Amazon Bedrock is limiting requests right now. Please try again shortly.", category="throttled", recoverable=True),
        "BEDROCK_UNAVAILABLE", True, id="throttled",
    ),
    pytest.param(
        unavailable("Amazon Bedrock refused the request. Check the AWS credentials and that the model is enabled.", category="access_denied", recoverable=False),
        "BEDROCK_UNAVAILABLE", False, id="access-denied",
    ),
    pytest.param(
        unavailable("Amazon Bedrock rejected the model request. Check the model ID and region.", category="model_unavailable", recoverable=False),
        "BEDROCK_UNAVAILABLE", False, id="model-unavailable",
    ),
    pytest.param(
        unavailable("Amazon Bedrock could not be reached.", category="network", recoverable=True),
        "BEDROCK_UNAVAILABLE", True, id="unreachable",
    ),
    pytest.param(
        unavailable("Amazon Bedrock did not answer in time.", category="timeout", recoverable=True, code="TIMEOUT"),
        "BEDROCK_UNAVAILABLE", True, id="timeout",
    ),
    pytest.param(
        LLMClientError(
            "CREDENTIAL_MISSING", "Amazon Bedrock credentials are incomplete: AWS_SECRET_ACCESS_KEY is not set.",
            category="credentials_missing", missing=("AWS_SECRET_ACCESS_KEY",),
        ),
        "CREDENTIAL_MISSING", False, id="credentials-missing",
    ),
    pytest.param(RuntimeError(f"{PROVIDER_TEXT} {SECRET}"), "BEDROCK_UNAVAILABLE", False, id="client-crash"),
]


@pytest.mark.parametrize(("failure", "code", "recoverable"), F2_ROWS)
def test_f2_a_reasoning_failure_is_one_stated_safe_error_and_the_next_request_recovers(
    failure: BaseException, code: str, recoverable: bool
) -> None:
    client = FakeClient(failure, GOOD)
    with TestClient(main.create_app(agent=AgentService(client))).websocket_connect("/ws") as ws:
        handshake(ws)
        reply, raw = ask(ws, "r1")
        recovered, _ = ask(ws, "r2")

    assert isinstance(reply, ErrorMessage)
    assert (reply.code, reply.replyTo, reply.recoverable) == (code, "r1", recoverable)
    assert reply.message.startswith(REASONING_FAILED_PREFIX)  # Req 12.3: the explanation could not be generated
    assert PROVIDER_TEXT not in raw and SECRET not in raw
    assert "action" not in json.loads(raw)  # nothing for the extension to run
    assert len(client.requests) == 2  # one call per request: no retry here, no second provider, no stub
    assert isinstance(recovered, AgentResponse) and recovered.replyTo == "r2" and recovered.speech == GOOD["speech"]


# --- F6: invalid AI response, and F7: an action outside the allow-list ---------------------------

F6_ROWS: Final = [
    pytest.param(f"{PROVIDER_TEXT} this is not json {{", id="not-json"),
    pytest.param(f'["{PROVIDER_TEXT}"]', id="json-but-not-an-object"),
    pytest.param("x" * 70_000, id="oversized-text"),
    pytest.param(tainted(speech="   "), id="empty-speech"),
    pytest.param({"speech": PROVIDER_TEXT}, id="missing-fields"),
    pytest.param(tainted(extra=SECRET), id="extra-field"),
    pytest.param(tainted(confirmationRequired="yes"), id="wrong-type"),
    pytest.param(tainted(replyTo="someone-else"), id="reply-id-mismatch"),
    pytest.param(tainted(action={"type": "RUN_COMMAND", "command": "rm -rf /"}), id="F7-unknown-action"),
    pytest.param(tainted(action={"type": "go_to_line", "line": 3}), id="F7-near-miss-action-name"),
    pytest.param(tainted(action={"type": "GO_TO_SYMBOL", "name": "x"}), id="F7-removed-action"),
    pytest.param(tainted(action={"type": "RUN_TESTS", "command": "rm -rf /"}), id="F7-command-smuggled-into-a-known-action"),
    pytest.param(tainted(action={"type": "OPEN_FILE", "path": "../../etc/passwd", "extra": 1}), id="F7-unlisted-parameter"),
]


@pytest.mark.parametrize("raw_output", F6_ROWS)
def test_f6_an_invalid_answer_is_one_safe_error_with_no_action_and_the_next_request_recovers(raw_output: Any) -> None:
    client = FakeClient(raw_output, GOOD)
    with TestClient(main.create_app(agent=AgentService(client))).websocket_connect("/ws") as ws:
        handshake(ws)
        reply, raw = ask(ws, "r1")
        recovered, _ = ask(ws, "r2")

    assert isinstance(reply, ErrorMessage)
    assert (reply.code, reply.replyTo, reply.recoverable) == ("BEDROCK_INVALID_RESPONSE", "r1", True)
    assert reply.message == AGENT_FAILURE_MESSAGE  # design F6, verbatim
    for leaked in (PROVIDER_TEXT, SECRET, "rm -rf", "RUN_COMMAND", "passwd"):
        assert leaked not in raw  # nothing partial is said as fact, and nothing hostile is echoed
    assert "action" not in json.loads(raw) and "speech" not in json.loads(raw)
    assert len(client.requests) == 2
    assert isinstance(recovered, AgentResponse) and recovered.replyTo == "r2"


def test_a_failed_request_leaves_no_trace_in_the_next_prompt_and_every_failure_kind_in_a_row_still_recovers() -> None:
    outcomes = [
        unavailable("Down.", category="service_error", recoverable=True),
        "not json",
        tainted(action={"type": "RUN_COMMAND", "command": "rm -rf /"}),
        RuntimeError(SECRET),
        GOOD,
    ]
    client = FakeClient(*outcomes)
    with TestClient(main.create_app(agent=AgentService(client))).websocket_connect("/ws") as ws:
        handshake(ws)
        replies = [ask(ws, f"r{number}")[0] for number in range(1, 6)]

    assert [type(reply).__name__ for reply in replies] == ["ErrorMessage"] * 4 + ["AgentResponse"]
    assert [reply.replyTo for reply in replies] == ["r1", "r2", "r3", "r4", "r5"]
    assert client.requests[-1].history == ()  # failed turns are never remembered as conversation
    assert PROVIDER_TEXT not in client.requests[-1].user_prompt and SECRET not in client.requests[-1].user_prompt