"""Task 7.7 tests for ``BedrockLLMClient``. Everything is mocked: no AWS request is ever made.

Fake boto3 clients are injected through ``client_factory``; ``boto3.client`` itself is replaced by a
function that fails the test if anything reaches the real SDK, and ``socket.create_connection`` is
blocked. Credentials in these tests are obvious sentinels.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import socket
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import (
    ClientError,
    ConnectTimeoutError,
    EndpointConnectionError,
    NoCredentialsError,
    ReadTimeoutError,
)

import app.agent.bedrock_service as service
from app.agent.bedrock_service import (
    BEARER_TOKEN_VARIABLE,
    CONNECT_TIMEOUT_SECONDS,
    DEFAULT_MODEL_ID,
    DEFAULT_REGION,
    MAX_THROTTLE_RETRIES,
    READ_TIMEOUT_SECONDS,
    RESPOND_TOOL_NAME,
    BedrockLLMClient,
    build_converse_request,
    build_respond_input_schema,
    classify_error,
    extract_respond_input,
    missing_credentials,
)
from app.agent.llm_client import LLMClient, LLMClientError, LLMRequest
from app.agent.prompt import build_llm_request
from app.agent.response_parser import AgentFailure, parse_agent_output
from app.allowlist import ALLOWED_ACTIONS
from app.protocol.messages import AgentRequest, AgentResponse
from app.protocol.validators import parse_message

SECRET = "SENTINEL_SECRET_BEARER_VALUE_98765"
SDK_TEXT = "SDK-PRIVATE-DETAIL arn:aws:bedrock:us-east-1:123456789012:model/secret"
FIXTURES = (
    Path(__file__).resolve().parents[2] / "extension" / "src" / "protocol" / "fixtures" / "messages"
)
GOOD_ENV: dict[str, str] = {BEARER_TOKEN_VARIABLE: SECRET}

VALID_INPUT: dict[str, Any] = {
    "speech": "There is one error on line 3 of example.ts.",
    "action": {"type": "NO_ACTION"},
    "confirmationRequired": False,
}
REQUEST = LLMRequest(system_prompt="SYSTEM PROMPT", user_prompt="USER PROMPT", reply_to="req-1")


def tool_response(*blocks: dict[str, Any], stop: str | None = "tool_use") -> dict[str, Any]:
    response: dict[str, Any] = {"output": {"message": {"role": "assistant", "content": list(blocks)}}}
    if stop is not None:
        response["stopReason"] = stop
    return response


def tool_use(tool_input: Any = None, name: str = RESPOND_TOOL_NAME) -> dict[str, Any]:
    return {"toolUse": {"toolUseId": "tooluse_1", "name": name, "input": VALID_INPUT if tool_input is None else tool_input}}


def client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": SDK_TEXT}}, "Converse")


class FakeRuntime:
    """Stands in for boto3's bedrock-runtime client: records calls, replays scripted outcomes."""

    def __init__(self, *outcomes: Any) -> None:
        self.outcomes = list(outcomes) or [tool_response(tool_use())]
        self.calls: list[dict[str, Any]] = []
        self.threads: list[int] = []

    def converse(self, **kwargs: Any) -> Mapping[str, Any]:
        self.calls.append(kwargs)
        self.threads.append(threading.get_ident())
        outcome = self.outcomes.pop(0) if len(self.outcomes) > 1 else self.outcomes[0]
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome  # type: ignore[no-any-return]


class Harness:
    def __init__(self, *outcomes: Any, environ: Mapping[str, str] | None = None) -> None:
        self.runtime = FakeRuntime(*outcomes)
        self.regions: list[str] = []
        self.factory_threads: list[int] = []
        self.sleeps: list[float] = []

        def factory(region: str) -> FakeRuntime:
            self.regions.append(region)
            self.factory_threads.append(threading.get_ident())
            return self.runtime

        async def sleep(seconds: float) -> None:
            self.sleeps.append(seconds)

        self.client = BedrockLLMClient(
            environ=GOOD_ENV if environ is None else environ, client_factory=factory, sleep=sleep
        )


@pytest.fixture(autouse=True)
def no_real_aws_or_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("a test reached the real AWS SDK or the network")

    import boto3

    monkeypatch.setattr(boto3, "client", forbidden)
    monkeypatch.setattr(boto3, "Session", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)


# --- configuration: model, region, credentials --------------------------------------------------


async def test_default_model_and_region_are_nova_lite_in_us_east_1() -> None:
    harness = Harness()
    await harness.client.respond(REQUEST)

    assert (DEFAULT_MODEL_ID, DEFAULT_REGION) == ("amazon.nova-lite-v1:0", "us-east-1")
    assert harness.runtime.calls[0]["modelId"] == "amazon.nova-lite-v1:0"
    assert harness.regions == ["us-east-1"]


async def test_model_and_region_come_from_the_environment() -> None:
    harness = Harness(environ={**GOOD_ENV, "AWS_REGION": "eu-west-1", "BEDROCK_MODEL_ID": "amazon.nova-micro-v1:0"})
    await harness.client.respond(REQUEST)

    assert harness.runtime.calls[0]["modelId"] == "amazon.nova-micro-v1:0"
    assert harness.regions == ["eu-west-1"]


async def test_aws_default_region_is_a_fallback_and_blank_values_use_the_defaults() -> None:
    fallback = Harness(environ={**GOOD_ENV, "AWS_DEFAULT_REGION": "us-west-2"})
    await fallback.client.respond(REQUEST)
    assert fallback.regions == ["us-west-2"]

    blank = Harness(environ={**GOOD_ENV, "AWS_REGION": "  ", "BEDROCK_MODEL_ID": ""})
    await blank.client.respond(REQUEST)
    assert blank.regions == ["us-east-1"] and blank.runtime.calls[0]["modelId"] == DEFAULT_MODEL_ID


async def test_the_process_environment_is_read_at_call_time(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(BEARER_TOKEN_VARIABLE, SECRET)
    monkeypatch.setenv("AWS_REGION", "ap-southeast-2")
    runtime = FakeRuntime()
    regions: list[str] = []
    client = BedrockLLMClient(client_factory=lambda region: (regions.append(region), runtime)[1])

    await client.respond(REQUEST)

    assert regions == ["ap-southeast-2"]


@pytest.mark.parametrize(
    ("environ", "expected"),
    [
        ({}, (BEARER_TOKEN_VARIABLE, "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")),
        ({"AWS_ACCESS_KEY_ID": "id"}, ("AWS_SECRET_ACCESS_KEY",)),
        ({"AWS_SECRET_ACCESS_KEY": "s"}, ("AWS_ACCESS_KEY_ID",)),
        ({"AWS_ACCESS_KEY_ID": "id", "AWS_SECRET_ACCESS_KEY": "  "}, ("AWS_SECRET_ACCESS_KEY",)),
        ({BEARER_TOKEN_VARIABLE: ""}, (BEARER_TOKEN_VARIABLE, "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")),
        ({BEARER_TOKEN_VARIABLE: SECRET}, ()),
        ({"AWS_ACCESS_KEY_ID": "id", "AWS_SECRET_ACCESS_KEY": "s"}, ()),
        ({"AWS_ACCESS_KEY_ID": "id", "AWS_SECRET_ACCESS_KEY": "s", "AWS_SESSION_TOKEN": "t"}, ()),
    ],
)
def test_missing_credentials_names_only_what_is_still_needed(environ: dict[str, str], expected: tuple[str, ...]) -> None:
    assert missing_credentials(environ) == expected


@pytest.mark.parametrize("environ", [{}, {"AWS_ACCESS_KEY_ID": "id"}, {"AWS_SECRET_ACCESS_KEY": "s"}, {BEARER_TOKEN_VARIABLE: " "}])
async def test_no_call_is_made_and_the_missing_variable_is_named(environ: dict[str, str]) -> None:
    harness = Harness(environ=environ)

    with pytest.raises(LLMClientError) as caught:
        await harness.client.respond(REQUEST)

    error = caught.value
    assert error.code == "CREDENTIAL_MISSING" and error.category == "credentials_missing"
    assert harness.regions == [] and harness.runtime.calls == []  # not even a client was created
    assert error.missing and all(name in str(error) for name in error.missing)
    assert set(error.missing) <= {BEARER_TOKEN_VARIABLE, "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"}


async def test_a_credential_error_from_the_sdk_is_credential_missing() -> None:
    harness = Harness(NoCredentialsError())

    with pytest.raises(LLMClientError) as caught:
        await harness.client.respond(REQUEST)

    assert caught.value.code == "CREDENTIAL_MISSING"
    assert len(harness.runtime.calls) == 1  # not retried


# --- Converse request: model, tool, messages ----------------------------------------------------


async def test_the_converse_call_has_one_forced_respond_tool() -> None:
    harness = Harness()
    await harness.client.respond(REQUEST)

    (call,) = harness.runtime.calls
    tools = call["toolConfig"]["tools"]
    assert len(tools) == 1 and tools[0]["toolSpec"]["name"] == "respond" == RESPOND_TOOL_NAME
    assert call["toolConfig"]["toolChoice"] == {"tool": {"name": "respond"}}
    assert set(call) == {"modelId", "system", "messages", "inferenceConfig", "toolConfig"}


async def test_system_and_user_prompts_are_sent_as_the_prompt_builder_made_them() -> None:
    harness = Harness()
    await harness.client.respond(REQUEST)

    call = harness.runtime.calls[0]
    assert call["system"] == [{"text": "SYSTEM PROMPT"}]
    assert call["messages"] == [{"role": "user", "content": [{"text": "USER PROMPT"}]}]
    assert call["inferenceConfig"] == {"maxTokens": 512, "temperature": 0}


async def test_context_and_history_are_not_sent_twice() -> None:
    raw = json.loads((FIXTURES / "agent_request.json").read_text(encoding="utf-8"))
    request = parse_message(raw)
    assert isinstance(request, AgentRequest)
    built = build_llm_request(request)
    harness = Harness()

    await harness.client.respond(built)

    sent = json.dumps(harness.runtime.calls[0], default=str)
    assert sent.count("Sample diagnostic message.") == 1  # only inside the prompt's untrusted block
    assert harness.runtime.calls[0]["messages"][0]["content"][0]["text"] == built.user_prompt
    assert harness.runtime.calls[0]["system"][0]["text"] == built.system_prompt


def test_tool_schema_offers_exactly_the_registry_actions_and_no_command_field() -> None:
    schema = build_respond_input_schema()
    action = schema["properties"]["action"]

    assert schema["additionalProperties"] is False and action["additionalProperties"] is False
    assert schema["required"] == ["speech", "action", "confirmationRequired"]
    assert action["required"] == ["type"]
    assert action["properties"]["type"]["enum"] == list(ALLOWED_ACTIONS)
    assert len(action["properties"]["type"]["enum"]) == 8
    assert set(action["properties"]) == {"type", "index", "severity", "path", "line"}
    assert schema["properties"]["speech"] == {"type": "string", "minLength": 1, "maxLength": 600}
    assert schema["properties"]["confirmationRequired"] == {"type": "boolean"}
    flat = json.dumps(schema)
    for forbidden in ("RUN_COMMAND", "GO_TO_SYMBOL", "command", "shell", "args", "script"):
        assert forbidden not in flat
    assert "$ref" not in flat and "anyOf" not in flat  # flat, provider-friendly


def test_tool_schema_parameters_follow_the_registry() -> None:
    properties = build_respond_input_schema()["properties"]["action"]["properties"]

    assert properties["line"] == {"type": "integer", "minimum": 1}
    assert properties["index"] == {"type": "integer", "minimum": 0}
    assert properties["severity"] == {"type": "string", "enum": ["error", "warning", "any"]}
    assert properties["path"] == {"type": "string", "minLength": 1, "maxLength": 256}
    reduced = {name: ALLOWED_ACTIONS[name] for name in ("NO_ACTION", "GO_TO_LINE")}
    assert set(build_respond_input_schema(reduced)["properties"]["action"]["properties"]) == {"type", "line"}


def test_build_converse_request_is_a_pure_function_of_its_inputs() -> None:
    first = build_converse_request(REQUEST, "model-x")
    assert first == build_converse_request(REQUEST, "model-x")
    assert first["modelId"] == "model-x"
    assert first["toolConfig"]["tools"][0]["toolSpec"]["inputSchema"] == {"json": build_respond_input_schema()}


# --- extraction and the LLMClient contract ------------------------------------------------------


async def test_the_respond_tool_input_is_returned_as_the_raw_model_output() -> None:
    harness = Harness(tool_response({"text": "Calling the tool."}, tool_use()))

    raw = await harness.client.respond(REQUEST)

    assert raw == VALID_INPUT and isinstance(raw, Mapping)
    assert raw is not VALID_INPUT and raw["action"] is not VALID_INPUT["action"]  # independent copy


async def test_bedrock_client_satisfies_the_llm_client_interface() -> None:
    client: LLMClient = Harness().client
    assert asyncio.iscoroutinefunction(client.respond)
    raw = await client.respond(REQUEST)
    assert set(raw) == {"speech", "action", "confirmationRequired"}


async def test_output_is_compatible_with_the_response_parser() -> None:
    harness = Harness()
    raw = await harness.client.respond(REQUEST)

    parsed = parse_agent_output(raw, reply_to=REQUEST.reply_to)

    assert isinstance(parsed, AgentResponse)
    assert parsed.replyTo == "req-1" and parsed.action.type == "NO_ACTION"
    assert parsed.speech == VALID_INPUT["speech"]


@pytest.mark.parametrize(
    ("label", "response", "category"),
    [
        ("text only", tool_response({"text": "Plain answer, no tool."}), "no_tool_use"),
        ("no content", tool_response(), "no_tool_use"),
        ("wrong tool name", tool_response(tool_use(name="other")), "wrong_tool"),
        ("lookalike name", tool_response(tool_use(name="Respond")), "wrong_tool"),
        ("two respond blocks", tool_response(tool_use(), tool_use()), "multiple_tool_use"),
        ("respond plus another tool", tool_response(tool_use(), tool_use(name="other")), "multiple_tool_use"),
        ("input is a string", tool_response(tool_use("not an object")), "bad_tool_input"),
        ("input is a list", tool_response(tool_use(["a"])), "bad_tool_input"),
        ("input is null", tool_response({"toolUse": {"name": "respond", "input": None}}), "bad_tool_input"),
        ("input missing", tool_response({"toolUse": {"name": "respond"}}), "bad_tool_input"),
        ("cut short", tool_response(tool_use(), stop="max_tokens"), "stopped_early"),
        ("guardrail", tool_response(tool_use(), stop="guardrail_intervened"), "stopped_early"),
        ("content filtered", tool_response(tool_use(), stop="content_filtered"), "stopped_early"),
        ("no output", {}, "malformed_response"),
        ("output is a string", {"output": "x"}, "malformed_response"),
        ("message is a list", {"output": {"message": []}}, "malformed_response"),
        ("content is a dict", {"output": {"message": {"content": {}}}}, "malformed_response"),
        ("not a mapping", ["x"], "malformed_response"),
        ("none", None, "malformed_response"),
    ],
)
async def test_anything_but_one_clean_respond_block_is_an_invalid_response(
    label: str, response: Any, category: str
) -> None:
    harness = Harness(response)

    with pytest.raises(LLMClientError) as caught:
        await harness.client.respond(REQUEST)

    assert caught.value.code == "BEDROCK_INVALID_RESPONSE", label
    assert caught.value.category == category, label
    assert len(harness.runtime.calls) == 1  # an invalid answer is not retried


def test_extract_accepts_end_turn_or_no_stop_reason_and_ignores_text_blocks() -> None:
    assert extract_respond_input(tool_response(tool_use(), stop="end_turn")) == VALID_INPUT
    assert extract_respond_input(tool_response({"text": "a"}, tool_use(), {"text": "b"}, stop=None)) == VALID_INPUT


async def test_unsafe_model_output_is_passed_on_untouched_and_never_executed(monkeypatch: pytest.MonkeyPatch) -> None:
    """The client only transports: acting on (or refusing) an action is not its job."""
    import os
    import subprocess

    def boom(*_a: object, **_k: object) -> None:
        raise AssertionError("an action must never be executed by the LLM client")

    monkeypatch.setattr(subprocess, "run", boom)
    monkeypatch.setattr(subprocess, "Popen", boom)
    monkeypatch.setattr(os, "system", boom)
    hostile = {
        "speech": "Running it now.",
        "action": {"type": "RUN_COMMAND", "command": "rm -rf /"},
        "confirmationRequired": False,
    }
    harness = Harness(tool_response(tool_use(hostile)))

    raw = await harness.client.respond(REQUEST)

    assert raw == hostile  # not validated, not rewritten, not run
    parsed = parse_agent_output(raw, reply_to="req-1")
    assert isinstance(parsed, AgentFailure) and parsed.reason == "action_not_allowed"  # the parser refuses it


async def test_invalid_structured_output_is_left_for_the_parser_to_reject_safely() -> None:
    sloppy = {"speech": "Hello.", "action": {"type": "NO_ACTION"}, "confirmationRequired": "yes", "extra": 1}
    raw = await Harness(tool_response(tool_use(sloppy))).client.respond(REQUEST)

    failure = parse_agent_output(raw, reply_to="req-1")
    assert isinstance(failure, AgentFailure) and failure.reason == "invalid_shape"


# --- failures: access, models, throttling, timeouts, network ------------------------------------


@pytest.mark.parametrize(
    "code",
    ["AccessDeniedException", "UnrecognizedClientException", "ExpiredTokenException", "InvalidSignatureException"],
)
async def test_access_denied_is_unavailable_and_never_retried(code: str) -> None:
    harness = Harness(client_error(code))

    with pytest.raises(LLMClientError) as caught:
        await harness.client.respond(REQUEST)

    assert (caught.value.code, caught.value.category) == ("BEDROCK_UNAVAILABLE", "access_denied")
    assert len(harness.runtime.calls) == 1 and harness.sleeps == []


@pytest.mark.parametrize("code", ["ResourceNotFoundException", "ModelNotReadyException", "ValidationException"])
async def test_an_unavailable_model_is_reported_and_never_retried(code: str) -> None:
    harness = Harness(client_error(code))

    with pytest.raises(LLMClientError) as caught:
        await harness.client.respond(REQUEST)

    assert (caught.value.code, caught.value.category) == ("BEDROCK_UNAVAILABLE", "model_unavailable")
    assert len(harness.runtime.calls) == 1


async def test_throttling_is_retried_once_then_succeeds() -> None:
    harness = Harness(client_error("ThrottlingException"), tool_response(tool_use()))

    raw = await harness.client.respond(REQUEST)

    assert raw == VALID_INPUT
    assert len(harness.runtime.calls) == 2 and MAX_THROTTLE_RETRIES == 1
    assert harness.sleeps == [service.THROTTLE_RETRY_DELAY_SECONDS]
    assert harness.regions == ["us-east-1"]  # one client reused for the retry


@pytest.mark.parametrize("code", ["ThrottlingException", "TooManyRequestsException"])
async def test_persistent_throttling_stops_after_exactly_one_retry(code: str) -> None:
    harness = Harness(client_error(code))

    with pytest.raises(LLMClientError) as caught:
        await harness.client.respond(REQUEST)

    assert (caught.value.code, caught.value.category) == ("BEDROCK_UNAVAILABLE", "throttled")
    assert caught.value.recoverable is True
    assert len(harness.runtime.calls) == 2  # never unbounded
    assert harness.sleeps == [service.THROTTLE_RETRY_DELAY_SECONDS]


@pytest.mark.parametrize(
    "error",
    [client_error("InternalServerException"), client_error("ServiceUnavailableException"),
     client_error("SomethingNew"), EndpointConnectionError(endpoint_url="https://bedrock-runtime.invalid")],
)
async def test_other_provider_failures_are_unavailable_and_not_retried(error: Exception) -> None:
    harness = Harness(error)

    with pytest.raises(LLMClientError) as caught:
        await harness.client.respond(REQUEST)

    assert caught.value.code == "BEDROCK_UNAVAILABLE"
    assert len(harness.runtime.calls) == 1 and harness.sleeps == []


@pytest.mark.parametrize(
    "error",
    [
        ReadTimeoutError(endpoint_url="https://bedrock-runtime.invalid"),
        ConnectTimeoutError(endpoint_url="https://bedrock-runtime.invalid"),
        client_error("ModelTimeoutException"),
    ],
)
async def test_timeouts_are_reported_as_timeout_and_not_retried(error: Exception) -> None:
    harness = Harness(error)

    with pytest.raises(LLMClientError) as caught:
        await harness.client.respond(REQUEST)

    assert (caught.value.code, caught.value.category) == ("TIMEOUT", "timeout")
    assert caught.value.recoverable is True
    assert len(harness.runtime.calls) == 1 and harness.sleeps == []


async def test_an_unexpected_exception_is_a_safe_internal_error() -> None:
    harness = Harness(RuntimeError(SDK_TEXT))

    with pytest.raises(LLMClientError) as caught:
        await harness.client.respond(REQUEST)

    assert (caught.value.code, caught.value.category) == ("INTERNAL", "unexpected")
    assert SDK_TEXT not in str(caught.value) and caught.value.__cause__ is None


def test_classify_error_passes_an_existing_client_error_through() -> None:
    original = LLMClientError("TIMEOUT", "x", category="timeout")
    assert classify_error(original) is original


async def test_cancellation_propagates_and_is_not_turned_into_an_error() -> None:
    release = threading.Event()
    started = threading.Event()

    class Blocking:
        def converse(self, **_kwargs: Any) -> Mapping[str, Any]:
            started.set()
            release.wait(5)
            return tool_response(tool_use())

    client = BedrockLLMClient(environ=GOOD_ENV, client_factory=lambda _region: Blocking())
    task = asyncio.create_task(client.respond(REQUEST))
    while not started.is_set():
        await asyncio.sleep(0.005)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    release.set()


# --- timeouts, retries, threads (the SDK configuration) -----------------------------------------


def test_the_default_factory_configures_timeouts_and_a_single_attempt_with_no_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import boto3

    captured: dict[str, Any] = {}

    def fake_client(*args: Any, **kwargs: Any) -> object:
        captured["args"], captured["kwargs"] = args, kwargs
        return object()

    monkeypatch.setattr(boto3, "client", fake_client)

    service._default_client_factory("us-east-1")

    assert captured["args"] == ("bedrock-runtime",)
    kwargs = captured["kwargs"]
    assert set(kwargs) == {"region_name", "config"}  # no key, secret, token or endpoint is passed in
    assert kwargs["region_name"] == "us-east-1"
    config = kwargs["config"]
    assert (READ_TIMEOUT_SECONDS, CONNECT_TIMEOUT_SECONDS) == (20, 5)
    assert config.read_timeout == 20 and config.connect_timeout == 5
    assert config.retries["total_max_attempts"] == 1  # botocore never retries on its own


async def test_the_blocking_call_runs_in_a_worker_thread_and_the_event_loop_stays_free() -> None:
    loop_thread = threading.get_ident()
    release = threading.Event()

    class Slow:
        def converse(self, **_kwargs: Any) -> Mapping[str, Any]:
            assert threading.get_ident() != loop_thread
            release.wait(5)
            return tool_response(tool_use())

    harness_regions: list[int] = []

    def factory(_region: str) -> Slow:
        harness_regions.append(threading.get_ident())
        return Slow()

    client = BedrockLLMClient(environ=GOOD_ENV, client_factory=factory)
    task = asyncio.create_task(client.respond(REQUEST))
    ticks = 0
    started = time.monotonic()
    while ticks < 20 and time.monotonic() - started < 3:
        await asyncio.sleep(0.005)  # the loop keeps running while the SDK call is blocked
        ticks += 1
    assert not task.done() and ticks == 20
    release.set()

    assert await task == VALID_INPUT
    assert harness_regions and harness_regions[0] != loop_thread  # the SDK client is built off the loop too


async def test_the_sdk_client_is_created_once_and_reused() -> None:
    harness = Harness()
    await harness.client.respond(REQUEST)
    await harness.client.respond(REQUEST)

    assert harness.regions == ["us-east-1"] and len(harness.runtime.calls) == 2


# --- no credential leakage ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "outcome",
    [
        client_error("AccessDeniedException"),
        client_error("ThrottlingException"),
        client_error("InternalServerException"),
        ReadTimeoutError(endpoint_url=f"https://x/{SECRET}"),
        RuntimeError(f"{SDK_TEXT} {SECRET}"),
        tool_response({"text": SECRET}),
    ],
)
async def test_errors_and_logs_never_contain_credentials_or_sdk_text(
    outcome: Any, caplog: pytest.LogCaptureFixture
) -> None:
    harness = Harness(outcome)
    caplog.set_level(logging.DEBUG)

    with pytest.raises(LLMClientError) as caught:
        await harness.client.respond(REQUEST)

    shown = " ".join(
        [str(caught.value), repr(caught.value), caught.value.message, caught.value.category, *caplog.messages]
    )
    assert SECRET not in shown and SDK_TEXT not in shown and "SDK-PRIVATE" not in shown
    assert "arn:aws" not in shown and "123456789012" not in shown
    # The SDK exception (which may hold request text) is neither chained nor shown with the error.
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None or caught.value.__suppress_context__


async def test_the_request_content_is_never_logged(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    request = LLMRequest(system_prompt="sys", user_prompt="PRIVATE_SOURCE_CODE_SENTINEL", reply_to="r")

    with pytest.raises(LLMClientError):
        await Harness(client_error("ThrottlingException")).client.respond(request)

    assert "PRIVATE_SOURCE_CODE_SENTINEL" not in " ".join(caplog.messages)
    assert all(SECRET not in message for message in caplog.messages)


async def test_credential_values_are_never_passed_to_the_sdk_factory_or_the_request() -> None:
    harness = Harness()
    await harness.client.respond(REQUEST)

    assert SECRET not in json.dumps(harness.runtime.calls, default=str)
    assert harness.regions == ["us-east-1"]  # the factory receives only the region


async def test_the_credential_error_names_variables_not_values() -> None:
    with pytest.raises(LLMClientError) as caught:
        await Harness(environ={"AWS_ACCESS_KEY_ID": SECRET}).client.respond(REQUEST)

    assert "AWS_SECRET_ACCESS_KEY" in str(caught.value)
    assert SECRET not in str(caught.value) and SECRET not in repr(caught.value)


# --- isolation ---------------------------------------------------------------------------------


def test_the_module_references_only_amazon_bedrock() -> None:
    text = Path(service.__file__).read_text(encoding="utf-8")

    for other in ("openai", "anthropic", "gemini", "google", "cohere", "mistral", "langchain", "ollama"):
        assert re.search(rf"\b{other}\b", text, flags=re.IGNORECASE) is None, other
    assert "subprocess" not in text and "os.system" not in text and "eval(" not in text
    assert "headers" not in text and "Bearer " not in text  # no authorization header is built by hand
    assert "StubLLMClient" not in text  # no hidden fallback to another client


def test_importing_the_module_makes_no_boto3_call() -> None:
    # The autouse fixture makes boto3.client fail; constructing the client must still work.
    client = BedrockLLMClient(environ={})
    assert isinstance(client, BedrockLLMClient)
