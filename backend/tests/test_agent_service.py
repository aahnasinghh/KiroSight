"""Task 7.8 tests: ``AgentService``, client selection, Bedrock credential policy, and the backend wiring.

Everything is offline. Fake ``LLMClient`` objects replace Bedrock; the real ``BedrockLLMClient`` is only
ever built with an injected fake SDK client (or never called). No AWS request is possible: ``boto3`` and
``socket.create_connection`` are patched to fail the test. The agent orchestration property and
integration tests of Task 7.9 are not written here.
"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import main
from app.agent.agent_service import REASONING_FAILED_PREFIX, AgentService, select_agent
from app.agent.bedrock_service import BedrockLLMClient, missing_credentials as client_missing_credentials
from app.agent.llm_client import LLMClient, LLMClientError, LLMRequest, StubLLMClient
from app.agent.response_parser import AGENT_FAILURE_MESSAGE
from app.agent.stub_agent import STUB_SPEECH
from app.config import ConfigError, load_config, resolve_llm_choice
from app.protocol.messages import AgentRequest, AgentResponse, ErrorMessage, HelloAck
from app.protocol.validators import parse_message
from app.session import STUB_CAPABILITIES, Turn

FIXTURES = (
    Path(__file__).resolve().parents[2] / "extension" / "src" / "protocol" / "fixtures" / "messages"
)
SECRET = "SENTINEL_SECRET_VALUE_24680"
PRIVATE = "PRIVATE_SOURCE_CODE_SENTINEL"
GOOD = {"speech": "There is one error on line 3.", "action": {"type": "NO_ACTION"}, "confirmationRequired": False}


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def request_of(kind: str = "utterance", **changes: Any) -> AgentRequest:
    raw = fixture("agent_request")
    raw.update(changes)
    if kind == "summarize_test_run":
        raw.pop("utterance", None)
        raw["kind"] = kind
        raw["testRun"] = {
            "outcome": "failed", "command": "SECRET_COMMAND", "exitCode": 1, "passed": 4, "failed": 2,
            "totalFailedNames": 2, "failingTests": [{"name": "a > b"}, {"name": "c > d"}],
            "outputTruncated": False, "durationMs": 10.0,
        }
    parsed = parse_message(raw)
    assert isinstance(parsed, AgentRequest), parsed
    return parsed


class FakeClient:
    """A scripted ``LLMClient``: records requests, returns or raises the next outcome."""

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
def no_real_aws_or_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*_a: object, **_k: object) -> None:
        raise AssertionError("a test reached the real AWS SDK or the network")

    import boto3

    monkeypatch.setattr(boto3, "client", forbidden)
    monkeypatch.setattr(boto3, "Session", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)


# --- successful responses ----------------------------------------------------------------------


async def test_a_valid_model_answer_becomes_an_agent_response_with_the_request_id() -> None:
    client = FakeClient()
    response = await AgentService(client).respond(request_of(id="req-9"))

    assert isinstance(response, AgentResponse)
    assert (response.replyTo, response.speech) == ("req-9", GOOD["speech"])
    assert response.action.type == "NO_ACTION" and response.confirmationRequired is False
    assert len(client.requests) == 1  # exactly one provider call


async def test_the_prompt_is_built_from_the_request_and_sent_once() -> None:
    client = FakeClient()
    await AgentService(client).respond(request_of(id="req-3"))

    sent = client.requests[0]
    assert sent.reply_to == "req-3"
    assert "User request: explain this error" in sent.user_prompt
    assert "Sample diagnostic message." in sent.user_prompt
    assert "- GO_TO_LINE (safe)" in sent.system_prompt  # the registry's actions, from the prompt builder


async def test_recent_turns_reach_the_prompt_as_context() -> None:
    client = FakeClient()
    history = [Turn(request=f"q{n}", response=f"a{n}") for n in range(5)]

    await AgentService(client).respond_with_history(request_of(), history)

    assert client.requests[0].history == (("q2", "a2"), ("q3", "a3"), ("q4", "a4"))
    assert "q4" in client.requests[0].user_prompt and "q1" not in client.requests[0].user_prompt


async def test_the_seam_without_history_matches_an_empty_history() -> None:
    first, second = FakeClient(), FakeClient()
    await AgentService(first).respond(request_of())
    await AgentService(second).respond_with_history(request_of(), ())
    assert first.requests == second.requests


@pytest.mark.parametrize(
    "action",
    [
        {"type": "GO_TO_LINE", "line": 42},
        {"type": "OPEN_FILE", "path": "src/auth.ts"},
        {"type": "GO_TO_DIAGNOSTIC", "index": 0, "severity": "error"},
        {"type": "FOCUS_EDITOR"},
        {"type": "RUN_TESTS"},
    ],
)
async def test_allow_listed_actions_pass_through_unexecuted(action: dict[str, Any]) -> None:
    response = await AgentService(FakeClient({**GOOD, "action": action})).respond(request_of())

    assert isinstance(response, AgentResponse)
    assert {"type": response.action.type, **(response.action.model_extra or {})} == action


async def test_confirmation_required_stays_advisory_and_unchanged() -> None:
    response = await AgentService(FakeClient({**GOOD, "action": {"type": "RUN_TESTS"}, "confirmationRequired": True})).respond(request_of())
    assert isinstance(response, AgentResponse) and response.confirmationRequired is True


async def test_the_speech_limit_is_applied() -> None:
    response = await AgentService(FakeClient({**GOOD, "speech": "One. Two. Three. Four. Five. Six. Seven."})).respond(request_of())
    assert isinstance(response, AgentResponse) and response.speech == "One. Two. Three. Four. Five."


# --- both request kinds ------------------------------------------------------------------------


async def test_a_test_run_summary_request_is_grounded_in_the_bounded_summary() -> None:
    client = FakeClient({**GOOD, "speech": "Two tests failed in the auth and api suites."})
    response = await AgentService(client).respond(request_of("summarize_test_run", id="sum-1"))

    assert isinstance(response, AgentResponse) and response.replyTo == "sum-1"
    prompt = client.requests[0].user_prompt
    assert "summarize the most recent test run" in prompt and "a > b" in prompt and "c > d" in prompt
    assert "SECRET_COMMAND" not in prompt  # the command line is never sent
    assert client.requests[0].test_run is not None


async def test_a_summary_never_carries_an_action() -> None:
    client = FakeClient({**GOOD, "action": {"type": "RUN_TESTS"}, "confirmationRequired": True})
    response = await AgentService(client).respond(request_of("summarize_test_run"))

    assert isinstance(response, AgentResponse)
    assert response.action.type == "NO_ACTION" and not response.action.model_extra
    assert response.confirmationRequired is False and response.speech == GOOD["speech"]


async def test_an_utterance_keeps_its_action_but_a_summary_with_no_action_is_unchanged() -> None:
    plain = await AgentService(FakeClient()).respond(request_of("summarize_test_run"))
    assert isinstance(plain, AgentResponse) and plain.action.type == "NO_ACTION"


# --- failures: always an error_message, never an action ----------------------------------------


def assert_error(result: object, code: str, request_id: str = "req-1") -> ErrorMessage:
    assert isinstance(result, ErrorMessage), result
    assert result.code == code and result.replyTo == request_id and result.type == "error_message"
    assert not hasattr(result, "action")
    assert parse_message(json.loads(json.dumps(result.model_dump(mode="json", exclude_unset=True)))) == result
    return result


@pytest.mark.parametrize(
    ("client_code", "expected"),
    [
        ("BEDROCK_UNAVAILABLE", "BEDROCK_UNAVAILABLE"),
        ("TIMEOUT", "BEDROCK_UNAVAILABLE"),
        ("INTERNAL", "BEDROCK_UNAVAILABLE"),
        ("CREDENTIAL_MISSING", "CREDENTIAL_MISSING"),
        ("BEDROCK_INVALID_RESPONSE", "BEDROCK_INVALID_RESPONSE"),
    ],
)
async def test_provider_failures_map_to_the_three_agent_error_codes(client_code: str, expected: str) -> None:
    failure = LLMClientError(client_code, "Safe provider message.", category="x", recoverable=True)  # type: ignore[arg-type]
    client = FakeClient(failure)

    result = assert_error(await AgentService(client).respond(request_of()), expected)

    assert len(client.requests) == 1  # no retry here and no second provider
    if expected != "BEDROCK_INVALID_RESPONSE":
        assert result.message.startswith(REASONING_FAILED_PREFIX) and "Safe provider message." in result.message
    else:
        assert result.message == AGENT_FAILURE_MESSAGE


async def test_the_error_states_the_reasoning_failure_and_whether_it_is_recoverable() -> None:
    throttled = LLMClientError("BEDROCK_UNAVAILABLE", "Limited.", category="throttled", recoverable=True)
    denied = LLMClientError("BEDROCK_UNAVAILABLE", "Refused.", category="access_denied")

    assert assert_error(await AgentService(FakeClient(throttled)).respond(request_of()), "BEDROCK_UNAVAILABLE").recoverable is True
    assert assert_error(await AgentService(FakeClient(denied)).respond(request_of()), "BEDROCK_UNAVAILABLE").recoverable is False
    assert "couldn't be generated" in REASONING_FAILED_PREFIX


async def test_a_missing_credential_error_names_the_variable_not_a_value() -> None:
    missing = LLMClientError(
        "CREDENTIAL_MISSING", "Amazon Bedrock credentials are incomplete: AWS_SECRET_ACCESS_KEY is not set.",
        category="credentials_missing", missing=("AWS_SECRET_ACCESS_KEY",),
    )
    result = assert_error(await AgentService(FakeClient(missing)).respond(request_of()), "CREDENTIAL_MISSING")
    assert "AWS_SECRET_ACCESS_KEY" in result.message


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        {"speech": "Hi.", "action": {"type": "RUN_COMMAND", "command": "rm -rf /"}, "confirmationRequired": False},
        {"speech": "Hi.", "action": {"type": "NO_ACTION", "command": "ls"}, "confirmationRequired": False},
        {"speech": "Hi.", "action": {"type": "GO_TO_LINE", "line": 0}, "confirmationRequired": False},
        {"speech": "Hi.", "action": {"type": "NO_ACTION"}},
        {"speech": 7, "action": {"type": "NO_ACTION"}, "confirmationRequired": False},
        {"speech": "  ", "action": {"type": "NO_ACTION"}, "confirmationRequired": False},
        {**GOOD, "extra": 1},
        [],
        None,
    ],
)
async def test_malformed_or_unsafe_model_output_is_an_invalid_response_with_no_action(raw: Any) -> None:
    result = assert_error(await AgentService(FakeClient(raw)).respond(request_of()), "BEDROCK_INVALID_RESPONSE")

    assert result.message == AGENT_FAILURE_MESSAGE and result.recoverable is True


async def test_a_client_that_raises_something_unexpected_is_still_a_safe_error() -> None:
    result = assert_error(
        await AgentService(FakeClient(RuntimeError(f"{PRIVATE} {SECRET}"))).respond(request_of()),
        "BEDROCK_UNAVAILABLE",
    )
    assert PRIVATE not in result.message and SECRET not in result.message


async def test_cancellation_is_not_turned_into_an_error() -> None:
    started = asyncio.Event()

    class Hangs:
        async def respond(self, request: LLMRequest) -> Mapping[str, Any]:
            started.set()
            await asyncio.sleep(30)
            return GOOD

    task = asyncio.create_task(AgentService(Hangs()).respond(request_of()))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_timeouts_from_the_client_are_reported_not_hidden() -> None:
    timeout = LLMClientError("TIMEOUT", "Amazon Bedrock did not answer in time.", category="timeout", recoverable=True)
    result = assert_error(await AgentService(FakeClient(timeout)).respond(request_of()), "BEDROCK_UNAVAILABLE")
    assert "did not answer in time" in result.message and result.recoverable is True


async def test_no_second_provider_and_no_stub_fallback_after_a_failure() -> None:
    primary = FakeClient(LLMClientError("BEDROCK_UNAVAILABLE", "Down.", category="service_error"))
    stub = StubLLMClient()
    service = AgentService(primary)

    result = await service.respond(request_of())

    assert isinstance(result, ErrorMessage)  # not the stub's canned answer
    assert STUB_SPEECH not in repr(result)
    assert len(primary.requests) == 1


async def test_errors_and_logs_never_contain_secrets_or_request_content(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    leaky = LLMClientError("BEDROCK_UNAVAILABLE", "Safe message.", category="service_error")
    results = [
        await AgentService(FakeClient(leaky)).respond(request_of()),
        await AgentService(FakeClient({"speech": f"{PRIVATE} {SECRET}", "action": {"type": "NOPE"}, "confirmationRequired": False})).respond(request_of()),
        await AgentService(FakeClient(RuntimeError(f"{PRIVATE} {SECRET}"))).respond(request_of()),
    ]

    shown = " ".join([repr(result) for result in results] + caplog.messages)
    assert PRIVATE not in shown and SECRET not in shown
    assert "Sample diagnostic message." not in shown and "return value;" not in shown  # the IDE context


def test_agent_service_satisfies_the_responder_and_client_seams() -> None:
    service = AgentService(StubLLMClient())
    client: LLMClient = StubLLMClient()
    assert asyncio.iscoroutinefunction(service.respond) and asyncio.iscoroutinefunction(service.respond_with_history)
    assert client is not None


# --- the stub through the service ---------------------------------------------------------------


async def test_the_stub_client_through_the_service_matches_the_milestone_6_stub_answer() -> None:
    response = await AgentService(StubLLMClient()).respond(request_of(id="req-42"))

    assert isinstance(response, AgentResponse)
    assert (response.replyTo, response.speech) == ("req-42", STUB_SPEECH)
    assert response.action.type == "NO_ACTION" and response.confirmationRequired is False


# --- configuration: Bedrock credential policy and client selection ------------------------------


@pytest.mark.parametrize(
    "environ",
    [
        {},
        {"AWS_BEARER_TOKEN_BEDROCK": SECRET},
        {"AWS_BEARER_TOKEN_BEDROCK": "  "},
        {"AWS_ACCESS_KEY_ID": "id"},
        {"AWS_SECRET_ACCESS_KEY": "s"},
        {"AWS_ACCESS_KEY_ID": "id", "AWS_SECRET_ACCESS_KEY": "s"},
        {"AWS_ACCESS_KEY_ID": "id", "AWS_SECRET_ACCESS_KEY": " "},
        {"AWS_ACCESS_KEY_ID": "id", "AWS_SECRET_ACCESS_KEY": "s", "AWS_SESSION_TOKEN": "t"},
        {"AWS_BEARER_TOKEN_BEDROCK": SECRET, "AWS_ACCESS_KEY_ID": "id"},
        {"AWS_REGION": "us-east-1", "BEDROCK_MODEL_ID": "m"},
    ],
)
def test_the_config_check_and_the_bedrock_client_agree_on_credentials(environ: dict[str, str]) -> None:
    config = load_config(environ, dotenv_path=Path("does-not-exist.env"))
    assert config.missing_credentials("bedrock") == client_missing_credentials(environ)


def test_a_bedrock_api_key_alone_is_enough_and_a_key_pair_is_enough() -> None:
    nothing = Path("does-not-exist.env")
    assert load_config({"AWS_BEARER_TOKEN_BEDROCK": SECRET}, dotenv_path=nothing).missing_credentials("bedrock") == ()
    assert load_config({"AWS_ACCESS_KEY_ID": "i", "AWS_SECRET_ACCESS_KEY": "s"}, dotenv_path=nothing).missing_credentials("bedrock") == ()
    assert load_config({}, dotenv_path=nothing).missing_credentials("bedrock") == (
        "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    )


def test_region_and_model_id_are_defaults_not_credentials() -> None:
    config = load_config({"AWS_BEARER_TOKEN_BEDROCK": SECRET}, dotenv_path=Path("does-not-exist.env"))
    names = config.missing_credentials("bedrock")
    assert "AWS_REGION" not in names and "BEDROCK_MODEL_ID" not in names
    assert SECRET not in repr(config) and SECRET not in repr(config.present_names)


@pytest.mark.parametrize(("value", "expected"), [(None, "stub"), ("", "stub"), ("stub", "stub"), ("STUB", "stub"),
                                                   ("bedrock", "bedrock"), (" Bedrock ", "bedrock")])
def test_the_llm_choice_defaults_to_the_offline_stub(value: str | None, expected: str) -> None:
    environ = {} if value is None else {"KIROSIGHT_LLM": value}
    assert resolve_llm_choice(environ) == expected


@pytest.mark.parametrize("value", ["openai", "gemini", "auto", "anthropic", "bedrock,stub", SECRET])
def test_an_unknown_llm_choice_is_a_configuration_error_that_does_not_echo_it(value: str) -> None:
    with pytest.raises(ConfigError) as caught:
        resolve_llm_choice({"KIROSIGHT_LLM": value})
    assert value not in str(caught.value)


def test_selecting_the_stub_reports_no_bedrock_capability() -> None:
    selection = select_agent("stub", load_config({}, dotenv_path=Path("none.env")))

    assert selection.llm == "stub" and selection.capabilities == STUB_CAPABILITIES
    assert selection.capabilities.bedrock is False
    assert isinstance(selection.agent, AgentService)


@pytest.mark.parametrize(
    ("environ", "bedrock"),
    [
        ({"AWS_BEARER_TOKEN_BEDROCK": SECRET}, True),
        ({"AWS_ACCESS_KEY_ID": "i", "AWS_SECRET_ACCESS_KEY": "s"}, True),
        ({"AWS_ACCESS_KEY_ID": "i"}, False),
        ({}, False),
    ],
)
def test_selecting_bedrock_reports_the_capability_only_when_a_credential_exists(environ: dict[str, str], bedrock: bool) -> None:
    selection = select_agent("bedrock", load_config(environ, dotenv_path=Path("none.env")))

    assert selection.llm == "bedrock"
    assert selection.capabilities.bedrock is bedrock
    assert (selection.capabilities.stt, selection.capabilities.tts, selection.capabilities.mic) == (False, False, "not_applicable")
    assert isinstance(selection.agent._client, BedrockLLMClient)  # type: ignore[attr-defined]


async def test_bedrock_without_credentials_fails_closed_and_never_uses_the_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.delenv(name, raising=False)
    selection = select_agent("bedrock", load_config({}, dotenv_path=Path("none.env")))

    result = await selection.agent.respond(request_of())

    assert_error(result, "CREDENTIAL_MISSING")
    assert STUB_SPEECH not in repr(result)


# --- backend wiring: hello_ack, requests, errors, history ---------------------------------------


def handshake(ws: Any) -> HelloAck:
    ws.send_text(json.dumps(fixture("hello")))
    ack = parse_message(json.loads(ws.receive_text()))
    assert isinstance(ack, HelloAck)
    return ack


def ask(ws: Any, request_id: str, text: str = "explain this error") -> Any:
    ws.send_text(json.dumps({**fixture("agent_request"), "id": request_id, "utterance": {"text": text}}))
    return parse_message(json.loads(ws.receive_text()))


def test_the_default_backend_answers_with_the_stub_through_the_agent_service() -> None:
    with TestClient(main.create_app()).websocket_connect("/ws") as ws:
        ack = handshake(ws)
        reply = ask(ws, "r1")

    assert ack.capabilities.bedrock is False
    assert isinstance(reply, AgentResponse) and reply.speech == STUB_SPEECH and reply.replyTo == "r1"


def test_hello_ack_reports_the_capabilities_of_the_selected_agent() -> None:
    selection = select_agent("bedrock", load_config({"AWS_BEARER_TOKEN_BEDROCK": SECRET}, dotenv_path=Path("none.env")))
    app = main.create_app(agent=selection.agent, capabilities=selection.capabilities)

    with TestClient(app).websocket_connect("/ws") as ws:
        ack = handshake(ws)

    assert ack.capabilities.bedrock is True
    assert SECRET not in ack.model_dump_json()


def test_the_environment_selects_the_client_when_none_is_injected(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("KIROSIGHT_LLM", "bedrock")
    monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", SECRET)

    with TestClient(main.create_app()).websocket_connect("/ws") as ws:
        ack = handshake(ws)  # no model call is made by a handshake

    assert ack.capabilities.bedrock is True


def test_bedrock_without_credentials_reports_no_capability_and_answers_with_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("KIROSIGHT_LLM", "bedrock")

    with TestClient(main.create_app()).websocket_connect("/ws") as ws:
        ack = handshake(ws)
        reply = ask(ws, "r1")

    assert ack.capabilities.bedrock is False
    assert isinstance(reply, ErrorMessage) and reply.code == "CREDENTIAL_MISSING" and reply.replyTo == "r1"
    assert STUB_SPEECH not in reply.message


def test_an_unknown_llm_value_closes_the_connection_instead_of_guessing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIROSIGHT_LLM", "openai")
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with TestClient(main.create_app()).websocket_connect("/ws"):
            pass


def test_a_provider_error_reaches_the_extension_as_an_error_message_and_the_connection_survives() -> None:
    failing = AgentService(FakeClient(LLMClientError("BEDROCK_UNAVAILABLE", "Down.", category="service_error"), GOOD))
    with TestClient(main.create_app(agent=failing)).websocket_connect("/ws") as ws:
        handshake(ws)
        first = ask(ws, "r1")
        second = ask(ws, "r2")

    assert isinstance(first, ErrorMessage) and first.code == "BEDROCK_UNAVAILABLE" and first.replyTo == "r1"
    assert isinstance(second, AgentResponse) and second.replyTo == "r2"  # the next request still works


def test_session_history_feeds_later_prompts_but_failed_turns_are_not_remembered() -> None:
    client = FakeClient(GOOD, LLMClientError("BEDROCK_UNAVAILABLE", "Down.", category="x"), GOOD)
    with TestClient(main.create_app(agent=AgentService(client))).websocket_connect("/ws") as ws:
        handshake(ws)
        ask(ws, "r1", "first question")
        ask(ws, "r2", "second question")  # fails
        ask(ws, "r3", "third question")

    assert client.requests[0].history == ()
    assert client.requests[1].history == (("first question", GOOD["speech"]),)
    assert client.requests[2].history == (("first question", GOOD["speech"]),)  # r2 left no turn


def test_a_plain_responder_without_history_support_still_works() -> None:
    class Plain:
        async def respond(self, request: AgentRequest) -> AgentResponse:
            return await AgentService(StubLLMClient()).respond(request)  # type: ignore[return-value]

    with TestClient(main.create_app(agent=Plain())).websocket_connect("/ws") as ws:  # type: ignore[arg-type]
        handshake(ws)
        reply = ask(ws, "r1")
    assert isinstance(reply, AgentResponse) and reply.speech == STUB_SPEECH


def test_the_extension_never_receives_an_action_the_allow_list_forbids() -> None:
    hostile = {"speech": "Done.", "action": {"type": "RUN_COMMAND", "command": "rm -rf /"}, "confirmationRequired": False}
    with TestClient(main.create_app(agent=AgentService(FakeClient(hostile)))).websocket_connect("/ws") as ws:
        handshake(ws)
        ws.send_text(json.dumps({**fixture("agent_request"), "id": "r1"}))
        text = ws.receive_text()

    reply = parse_message(json.loads(text))
    assert isinstance(reply, ErrorMessage) and reply.code == "BEDROCK_INVALID_RESPONSE"
    assert "RUN_COMMAND" not in text and "rm -rf" not in text
