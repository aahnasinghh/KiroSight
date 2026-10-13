"""Task 7.9 tests: agent orchestration with a fake ``LLMClient``.

Feature: kirosight-mvp, Task 7.9. Requirements 7.5, 12.3, 13.2, 13.3, 13.4.

The five behaviours the task names, each checked for BOTH request kinds where it applies:

* a Bedrock failure yields ``BEDROCK_UNAVAILABLE`` and no second provider is attempted;
* a valid output passes through;
* an invalid output yields a safe error with no action;
* a ``summarize_test_run`` request is grounded in the bounded summary;
* the result respects the 5-sentence limit.

Everything is offline. A scripted fake replaces Bedrock; ``boto3`` and ``socket.create_connection``
are patched to fail the test, and ``StubLLMClient.respond`` is patched to fail the test so that any
fallback to the stub is caught. No credential is read. This file adds no new correctness property
(Properties 22 and 23 belong to Tasks 7.4 and 7.5); the sentence-limit check at the service level
uses Hypothesis only to vary the input, with an independent construction as the oracle.
"""

from __future__ import annotations

import asyncio
import json
import socket
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Final

import pytest
from fastapi.testclient import TestClient
from hypothesis import HealthCheck, given, settings, strategies as st

from app import main
from app.agent.agent_service import REASONING_FAILED_PREFIX, AgentService
from app.agent.llm_client import LLMClientError, LLMRequest, StubLLMClient
from app.agent.prompt import MAX_TEST_FAILURE_LINES
from app.agent.response_parser import AGENT_FAILURE_MESSAGE
from app.allowlist import ALLOWED_ACTIONS
from app.protocol.messages import MAX_SPEECH_CHARS, AgentRequest, AgentResponse, ErrorMessage
from app.protocol.validators import parse_message
from app.session import Turn

FIXTURES = Path(__file__).resolve().parents[2] / "extension" / "src" / "protocol" / "fixtures" / "messages"
KINDS: Final = ("utterance", "summarize_test_run")
SECRET = "SENTINEL_SECRET_VALUE_97531"
PRIVATE = "PRIVATE_SOURCE_CODE_SENTINEL_97531"
GOOD: Final[dict[str, Any]] = {
    "speech": "There is one error on line 3.",
    "action": {"type": "NO_ACTION"},
    "confirmationRequired": False,
}
EXAMPLES = 100


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def make_run(**changes: Any) -> dict[str, Any]:
    run: dict[str, Any] = {
        "outcome": "failed", "command": "SECRET_COMMAND", "exitCode": 1, "passed": 4, "failed": 2,
        "totalFailedNames": 2, "failingTests": [{"name": "a > b"}, {"name": "c > d"}],
        "outputTruncated": False, "durationMs": 10.0,
    }
    run.update(changes)
    return run


def request_of(kind: str, request_id: str = "req-1", run: dict[str, Any] | None = None) -> AgentRequest:
    raw = fixture("agent_request")
    raw["id"] = request_id
    if kind == "summarize_test_run":
        raw.pop("utterance", None)
        raw["kind"] = kind
        raw["testRun"] = run if run is not None else make_run()
    parsed = parse_message(raw)
    assert isinstance(parsed, AgentRequest), parsed
    return parsed


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
def no_real_aws_network_or_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*_a: object, **_k: object) -> None:
        raise AssertionError("a test reached the real AWS SDK, the network, or the stub fallback")

    import boto3

    monkeypatch.setattr(boto3, "client", forbidden)
    monkeypatch.setattr(boto3, "Session", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(StubLLMClient, "respond", forbidden)


def assert_error(result: object, code: str, request_id: str = "req-1") -> ErrorMessage:
    assert isinstance(result, ErrorMessage), result
    assert (result.code, result.replyTo, result.type) == (code, request_id, "error_message")
    assert not hasattr(result, "action")
    dumped = json.dumps(result.model_dump(mode="json", exclude_unset=True))
    assert "action" not in json.loads(dumped)
    assert parse_message(json.loads(dumped)) == result  # a valid protocol message
    assert SECRET not in dumped and PRIVATE not in dumped
    return result


# --- a Bedrock failure yields BEDROCK_UNAVAILABLE and no second provider is attempted -----------


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("code", ["BEDROCK_UNAVAILABLE", "TIMEOUT", "INTERNAL"])
async def test_a_bedrock_failure_is_bedrock_unavailable_with_no_action_and_one_attempt(kind: str, code: str) -> None:
    failing = FakeClient(LLMClientError(code, "Amazon Bedrock is down.", category="service_error", recoverable=True))  # type: ignore[arg-type]
    result = await AgentService(failing).respond(request_of(kind))

    error = assert_error(result, "BEDROCK_UNAVAILABLE")
    assert error.message.startswith(REASONING_FAILED_PREFIX)  # Requirement 12.3
    assert error.recoverable is True
    assert len(failing.requests) == 1  # one attempt: the service never retries


@pytest.mark.parametrize("kind", KINDS)
async def test_the_stub_is_never_consulted_after_a_bedrock_failure(kind: str) -> None:
    # The autouse fixture makes StubLLMClient.respond fail the test if anything calls it.
    failing = FakeClient(LLMClientError("BEDROCK_UNAVAILABLE", "Down.", category="service_error"), GOOD)
    service = AgentService(failing)

    assert_error(await service.respond(request_of(kind)), "BEDROCK_UNAVAILABLE")
    assert len(failing.requests) == 1  # the scripted good answer queued behind the failure is never fetched


@pytest.mark.parametrize("kind", KINDS)
async def test_a_failure_does_not_poison_the_next_request(kind: str) -> None:
    client = FakeClient(LLMClientError("TIMEOUT", "Slow.", category="timeout", recoverable=True), GOOD)
    service = AgentService(client)

    assert_error(await service.respond(request_of(kind, "r1")), "BEDROCK_UNAVAILABLE", "r1")
    second = await service.respond(request_of(kind, "r2"))

    assert isinstance(second, AgentResponse) and second.replyTo == "r2"
    assert len(client.requests) == 2  # exactly one call per request


@pytest.mark.parametrize("kind", KINDS)
async def test_missing_credentials_name_the_variable_and_make_no_stub_call(kind: str) -> None:
    missing = LLMClientError(
        "CREDENTIAL_MISSING", "Amazon Bedrock credentials are incomplete: AWS_SECRET_ACCESS_KEY is not set.",
        category="credentials_missing", missing=("AWS_SECRET_ACCESS_KEY",),
    )
    error = assert_error(await AgentService(FakeClient(missing)).respond(request_of(kind)), "CREDENTIAL_MISSING")
    assert "AWS_SECRET_ACCESS_KEY" in error.message


# --- a valid output passes through --------------------------------------------------------------

EIGHT_ACTIONS: Final[list[dict[str, Any]]] = [
    {"type": "NO_ACTION"},
    {"type": "GO_TO_DIAGNOSTIC", "index": 0, "severity": "error"},
    {"type": "NEXT_DIAGNOSTIC"},
    {"type": "PREVIOUS_DIAGNOSTIC", "severity": "warning"},
    {"type": "OPEN_FILE", "path": "src/auth.ts"},
    {"type": "GO_TO_LINE", "line": 42},
    {"type": "FOCUS_EDITOR"},
    {"type": "RUN_TESTS"},
]


def test_the_fixture_covers_exactly_the_eight_allow_listed_actions() -> None:
    assert {action["type"] for action in EIGHT_ACTIONS} == set(ALLOWED_ACTIONS) and len(ALLOWED_ACTIONS) == 8


@pytest.mark.parametrize("action", EIGHT_ACTIONS, ids=lambda action: action["type"])
async def test_every_allow_listed_utterance_action_passes_through_unchanged_and_unexecuted(action: dict[str, Any]) -> None:
    client = FakeClient({**GOOD, "action": action, "confirmationRequired": action["type"] == "RUN_TESTS"})
    response = await AgentService(client).respond(request_of("utterance", "req-7"))

    assert isinstance(response, AgentResponse)
    assert response.replyTo == "req-7" and response.speech == GOOD["speech"]
    assert {"type": response.action.type, **(response.action.model_extra or {})} == action
    assert response.confirmationRequired is (action["type"] == "RUN_TESTS")
    assert len(client.requests) == 1


async def test_a_valid_summary_passes_through_with_its_speech_and_request_id() -> None:
    speech = "Two tests failed, both in the auth suite. Want the names?"
    response = await AgentService(FakeClient({**GOOD, "speech": speech})).respond(request_of("summarize_test_run", "sum-4"))

    assert isinstance(response, AgentResponse)
    assert (response.replyTo, response.speech, response.action.type) == ("sum-4", speech, "NO_ACTION")


# --- an invalid output yields a safe error with no action ---------------------------------------

HOSTILE_OUTPUTS: Final[list[Any]] = [
    "",
    "not json at all",
    "[1, 2, 3]",
    "null",
    {},
    {"speech": "Hi."},
    {**GOOD, "speech": "   "},
    {**GOOD, "speech": 5},
    {**GOOD, "action": {"type": "RUN_COMMAND", "command": "rm -rf /"}},
    {**GOOD, "action": {"type": "GO_TO_SYMBOL", "name": "foo"}},
    {**GOOD, "action": {"type": "run_tests"}},
    {**GOOD, "action": {"type": "RUN_TESTS", "command": "rm -rf /"}},
    {**GOOD, "action": {"type": "OPEN_FILE", "path": "a.ts", "shell": "x"}},
    {**GOOD, "action": {"type": "GO_TO_LINE", "line": 0}},
    {**GOOD, "action": {"type": "GO_TO_LINE", "line": "7"}},
    {**GOOD, "action": "RUN_TESTS"},
    {**GOOD, "replyTo": "some-other-request"},
    {**GOOD, "confirmationRequired": "no"},
]


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("raw", HOSTILE_OUTPUTS, ids=lambda raw: repr(raw)[:40])
async def test_invalid_output_is_a_safe_invalid_response_error_with_no_action(kind: str, raw: Any) -> None:
    client = FakeClient(raw)
    error = assert_error(await AgentService(client).respond(request_of(kind)), "BEDROCK_INVALID_RESPONSE")

    assert error.message == AGENT_FAILURE_MESSAGE  # fixed text: no model output is repeated
    assert "rm -rf" not in error.message and "RUN_COMMAND" not in error.message
    assert len(client.requests) == 1  # no retry to get a better answer


async def test_a_model_that_echoes_a_secret_cannot_leak_it_through_the_error() -> None:
    hostile = {**GOOD, "speech": " ", "note": f"{SECRET} {PRIVATE}", "action": {"type": "RUN_COMMAND", "command": SECRET}}
    assert_error(await AgentService(FakeClient(hostile)).respond(request_of("utterance")), "BEDROCK_INVALID_RESPONSE")


# --- a summarize_test_run request is grounded in the bounded summary ----------------------------


async def test_the_summary_prompt_carries_the_counts_and_failing_names_and_never_the_command() -> None:
    client = FakeClient()
    await AgentService(client).respond(request_of("summarize_test_run"))

    sent = client.requests[0]
    assert "summarize the most recent test run" in sent.user_prompt
    for expected in ("a > b", "c > d"):
        assert expected in sent.user_prompt
    assert "SECRET_COMMAND" not in sent.user_prompt and "SECRET_COMMAND" not in sent.system_prompt
    assert sent.test_run is not None and sent.test_run.failed == 2 and sent.reply_to == "req-1"
    assert "Use NO_ACTION" in sent.user_prompt  # the task tells the model a summary carries no action


async def test_a_large_summary_is_bounded_in_the_prompt() -> None:
    def names(count: int) -> list[dict[str, str]]:
        return [{"name": f"suite > case_{number} " + "x" * 2000, "messageExcerpt": "y" * 2000} for number in range(count)]

    # The wire form already refuses more than MAX_FAILING_TESTS (20) failing tests ...
    too_many = fixture("agent_request")
    too_many.pop("utterance", None)
    too_many.update(kind="summarize_test_run", testRun=make_run(failed=21, totalFailedNames=500, failingTests=names(21)))
    assert not isinstance(parse_message(too_many), AgentRequest)

    # ... and the prompt clips every name and excerpt of the 20 it accepts.
    run = make_run(failed=20, totalFailedNames=500, failingTests=names(MAX_TEST_FAILURE_LINES), outputTruncated=True)
    client = FakeClient()

    await AgentService(client).respond(request_of("summarize_test_run", run=run))

    prompt = client.requests[0].user_prompt
    assert "case_0 " in prompt and f"case_{MAX_TEST_FAILURE_LINES - 1} " in prompt
    assert "x" * 600 not in prompt and "y" * 600 not in prompt  # fields are clipped
    assert len(prompt) < 30_000  # 20 names and excerpts of 2000+ characters each (over 80 000) are bounded


async def test_a_summary_with_no_failures_still_asks_for_a_grounded_summary() -> None:
    run = make_run(outcome="passed", exitCode=0, passed=9, failed=0, totalFailedNames=0, failingTests=[])
    client = FakeClient({**GOOD, "speech": "All nine tests passed."})

    response = await AgentService(client).respond(request_of("summarize_test_run", run=run))

    assert isinstance(response, AgentResponse) and response.speech == "All nine tests passed."
    assert "summarize the most recent test run" in client.requests[0].user_prompt


@pytest.mark.parametrize("action", EIGHT_ACTIONS, ids=lambda action: action["type"])
async def test_a_summary_never_returns_an_executable_action(action: dict[str, Any]) -> None:
    client = FakeClient({**GOOD, "action": action, "confirmationRequired": True})
    response = await AgentService(client).respond(request_of("summarize_test_run"))

    assert isinstance(response, AgentResponse)
    assert response.action.type == "NO_ACTION" and not response.action.model_extra
    assert response.confirmationRequired is False and response.speech == GOOD["speech"]


async def test_history_is_context_for_a_summary_but_never_an_instruction() -> None:
    client = FakeClient()
    history = [Turn(request="run my tests", response="Running the tests.")]

    await AgentService(client).respond_with_history(request_of("summarize_test_run"), history)

    assert client.requests[0].history == (("run my tests", "Running the tests."),)


# --- the result respects the 5-sentence limit ---------------------------------------------------


def _sentences(count: int) -> list[str]:
    return [f"Sentence number {number} is here." for number in range(1, count + 1)]


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("count", [1, 4, 5, 6, 7, 20])
async def test_the_spoken_result_has_at_most_five_sentences_in_order(kind: str, count: int) -> None:
    sentences = _sentences(count)
    response = await AgentService(FakeClient({**GOOD, "speech": " ".join(sentences)})).respond(request_of(kind))

    assert isinstance(response, AgentResponse)
    assert response.speech == " ".join(sentences[:5])  # a prefix, original order, nothing added


@pytest.mark.parametrize("kind", KINDS)
async def test_an_overlong_speech_is_cut_to_the_protocol_limit(kind: str) -> None:
    response = await AgentService(FakeClient({**GOOD, "speech": "word " * 400})).respond(request_of(kind))

    assert isinstance(response, AgentResponse)
    assert 0 < len(response.speech) <= MAX_SPEECH_CHARS


_WORDS = st.text(alphabet="abcdefghijklmnopqrstuvwxyz", min_size=1, max_size=8)
_SENTENCE = st.builds(
    lambda words, end: " ".join(words).capitalize() + end,
    st.lists(_WORDS, min_size=1, max_size=5),
    st.sampled_from([".", "!", "?"]),
)


@settings(max_examples=EXAMPLES, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(sentences=st.lists(_SENTENCE, min_size=1, max_size=14), kind=st.sampled_from(KINDS))
def test_service_speech_is_the_first_five_known_sentences_for_any_input(sentences: list[str], kind: str) -> None:
    # Oracle: the text is BUILT from known sentences, so the expected result is the construction itself.
    async def run() -> object:
        return await AgentService(FakeClient({**GOOD, "speech": " ".join(sentences)})).respond(request_of(kind))

    response = asyncio.run(run())

    assert isinstance(response, AgentResponse)
    assert response.speech == " ".join(sentences[:5])
    assert response.action.type == "NO_ACTION"


# --- over the WebSocket: exactly one protocol message per request, for both kinds ----------------


def _handshake(ws: Any) -> None:
    ws.send_text(json.dumps(fixture("hello")))
    ws.receive_text()


def _ask(app_agent: AgentService, kind: str) -> object:
    with TestClient(main.create_app(agent=app_agent)).websocket_connect("/ws") as ws:
        _handshake(ws)
        raw = fixture("agent_request")
        raw["id"] = "ws-1"
        if kind == "summarize_test_run":
            raw.pop("utterance", None)
            raw.update(kind=kind, testRun=make_run())
        ws.send_text(json.dumps(raw))
        return parse_message(json.loads(ws.receive_text()))


@pytest.mark.parametrize("kind", KINDS)
def test_over_the_websocket_a_valid_answer_is_an_agent_response(kind: str) -> None:
    reply = _ask(AgentService(FakeClient()), kind)
    assert isinstance(reply, AgentResponse) and reply.replyTo == "ws-1"


@pytest.mark.parametrize("kind", KINDS)
def test_over_the_websocket_a_failure_is_an_error_message_with_no_action(kind: str) -> None:
    down = FakeClient(LLMClientError("BEDROCK_UNAVAILABLE", "Down.", category="service_error", recoverable=True))
    reply = _ask(AgentService(down), kind)
    assert_error(reply, "BEDROCK_UNAVAILABLE", "ws-1")


@pytest.mark.parametrize("kind", KINDS)
def test_over_the_websocket_an_unsafe_answer_is_an_invalid_response_error(kind: str) -> None:
    unsafe = FakeClient({**GOOD, "action": {"type": "RUN_COMMAND", "command": "rm -rf /"}})
    reply = _ask(AgentService(unsafe), kind)
    assert_error(reply, "BEDROCK_INVALID_RESPONSE", "ws-1")
