"""Task 8.7 - Property 26: missing credentials block provider calls (Requirement 17.5).

    For any environment in which a required Deepgram or Bedrock credential is absent, empty or
    whitespace-only, the corresponding client makes no outbound call and reports an error naming the
    missing variable, while clients whose credentials are present stay usable.

What "makes no outbound call" means here, and how it is proven: the clients are given a counting
provider transport (``httpx.MockTransport`` for Deepgram) or a counting boto3 client factory and fake
runtime (Bedrock). The tests assert that the factory was never called, no request was recorded and
no ``converse`` call was made. Looking at the error text alone would not prove that.

Everything is synthetic and offline. Credentials are generated marker strings (``SYNTHETIC...``); the
real process environment, ``.env`` files, the network and the AWS SDK are never touched: each client
receives an explicit ``environ`` mapping and an injected transport or factory.
"""

from __future__ import annotations

import asyncio
import logging
import re
import string
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import httpx
from hypothesis import given, settings, strategies as st

from app.agent.bedrock_service import (
    BEARER_TOKEN_VARIABLE,
    BedrockLLMClient,
    missing_credentials as bedrock_missing_credentials,
)
from app.agent.llm_client import LLMClientError, LLMRequest
from app.config import load_config
from app.speech.deepgram_service import API_KEY_VARIABLE, STT_MODEL_VARIABLE, DeepgramSTTClient, STTError

ACCESS_KEY = "AWS_ACCESS_KEY_ID"
SECRET_KEY = "AWS_SECRET_ACCESS_KEY"
MISSING_DOTENV = Path("does-not-exist-for-missing-credentials-property.env")
EXAMPLES = settings(max_examples=100, deadline=None)

# Characters that ``str.strip()`` removes, so a value made only of them is "whitespace-only".
BLANK_CHARS = (
    " \t\r\n\x0b\x0c\x1c\x1d\x1e\x1f\x85\xa0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)
assert all(character.isspace() for character in BLANK_CHARS)

REQUEST = LLMRequest(system_prompt="SYSTEM", user_prompt="USER", reply_to="req-1")
VALID_INPUT: dict[str, Any] = {"speech": "One error on line 3.", "action": {"type": "NO_ACTION"}, "confirmationRequired": False}
AUDIO = b"SYNTHETIC-AUDIO-BYTES"
TRANSCRIPT = "what errors are there"
VALID_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}")

# --- strategies ----------------------------------------------------------------------------------

blank_values = st.text(alphabet=BLANK_CHARS, max_size=20)  # includes the empty string
absent_or_blank = st.one_of(st.none(), blank_values)  # None means the variable is not set at all
secret_core = st.text(alphabet=string.ascii_letters + string.digits + "-_", min_size=8, max_size=40).map(
    lambda text: f"SYNTHETIC{text}"
)
usable_secret = st.builds(lambda before, core, after: f"{before}{core}{after}", blank_values, secret_core, blank_values)
any_value = st.one_of(st.none(), blank_values, usable_secret)

# Settings unrelated to credentials; they must not change anything.
noise = st.fixed_dictionaries(
    {},
    optional={
        "AWS_REGION": st.sampled_from(["us-east-1", "us-west-2", "eu-west-1"]),
        "BEDROCK_MODEL_ID": st.sampled_from(["amazon.nova-lite-v1:0", "amazon.nova-pro-v1:0"]),
        "KIROSIGHT_HOST": st.just("127.0.0.1"),
        "UNRELATED_SETTING": st.text(max_size=10),
        STT_MODEL_VARIABLE: st.sampled_from(["nova-2", "nova-2-general"]),
    },
)

# (bearer token, access key id, secret access key). Blocked: no complete credential is configured.
bedrock_blocked = st.one_of(
    st.tuples(absent_or_blank, absent_or_blank, absent_or_blank),
    st.tuples(absent_or_blank, usable_secret, absent_or_blank),  # half a pair: only the key id
    st.tuples(absent_or_blank, absent_or_blank, usable_secret),  # half a pair: only the secret
)
# Usable: a bearer token alone, or a complete access-key pair.
bedrock_usable = st.one_of(
    st.tuples(usable_secret, any_value, any_value),
    st.tuples(absent_or_blank, usable_secret, usable_secret),
)


def is_set(value: str | None) -> bool:
    """The rule from Requirement 17.5, written independently of the production helpers."""
    return value is not None and value.strip() != ""


def expected_bedrock_missing(bearer: str | None, key: str | None, secret: str | None) -> tuple[str, ...]:
    if is_set(bearer) or (is_set(key) and is_set(secret)):
        return ()
    if is_set(key):
        return (SECRET_KEY,)
    if is_set(secret):
        return (ACCESS_KEY,)
    return (BEARER_TOKEN_VARIABLE, ACCESS_KEY, SECRET_KEY)


def make_environment(base: Mapping[str, str], entries: Mapping[str, str | None]) -> dict[str, str]:
    return {**base, **{name: value for name, value in entries.items() if value is not None}}


def bedrock_environment(base: Mapping[str, str], triple: tuple[str | None, str | None, str | None]) -> dict[str, str]:
    bearer, key, secret = triple
    return make_environment(base, {BEARER_TOKEN_VARIABLE: bearer, ACCESS_KEY: key, SECRET_KEY: secret})


def secrets_in(*values: str | None) -> list[str]:
    """The stripped synthetic secrets that must never appear in any error or log line."""
    return [value.strip() for value in values if value is not None and value.strip() != ""]


# --- instrumented providers ----------------------------------------------------------------------


class RecordingRuntime:
    """Stands in for boto3's bedrock-runtime client and counts every ``converse`` call."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def converse(self, **kwargs: Any) -> Mapping[str, Any]:
        self.calls.append(kwargs)
        block = {"toolUse": {"toolUseId": "tool-1", "name": "respond", "input": dict(VALID_INPUT)}}
        return {"stopReason": "tool_use", "output": {"message": {"role": "assistant", "content": [block]}}}


class CountingFactory:
    """The injected boto3 client factory. A call here is the first step of any outbound Bedrock call."""

    def __init__(self, runtime: RecordingRuntime) -> None:
        self.runtime = runtime
        self.calls = 0

    def __call__(self, region: str) -> RecordingRuntime:
        self.calls += 1
        return self.runtime


class BedrockAttempt:
    def __init__(self, environ: Mapping[str, str]) -> None:
        self.runtime = RecordingRuntime()
        self.factory = CountingFactory(self.runtime)
        client = BedrockLLMClient(environ=environ, client_factory=self.factory)
        self.output: Mapping[str, Any] | None = None
        self.error: LLMClientError | None = None
        try:
            self.output = asyncio.run(client.respond(REQUEST))
        except LLMClientError as error:
            self.error = error

    @property
    def outbound_calls(self) -> int:
        return self.factory.calls + len(self.runtime.calls)


class DeepgramAttempt:
    def __init__(self, environ: Mapping[str, str], audio: bytes = AUDIO, mime_type: str = "audio/webm") -> None:
        self.requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            body = {"results": {"channels": [{"alternatives": [{"transcript": TRANSCRIPT}]}]}}
            return httpx.Response(200, json=body)

        self.client = DeepgramSTTClient(environ=environ, transport=httpx.MockTransport(handler))
        self.text: str | None = None
        self.error: STTError | None = None
        try:
            self.text = asyncio.run(self.client.transcribe(audio, mime_type))
        except STTError as error:
            self.error = error


class _LineCollector(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


@contextmanager
def captured_logs() -> Iterator[list[str]]:
    """Everything the two provider modules log while the block runs."""
    collector = _LineCollector()
    loggers = [logging.getLogger("kirosight.backend.bedrock"), logging.getLogger("kirosight.backend.speech")]
    previous = [logger.level for logger in loggers]
    for logger in loggers:
        logger.addHandler(collector)
        logger.setLevel(logging.DEBUG)
    try:
        yield collector.lines
    finally:
        for logger, level in zip(loggers, previous, strict=True):
            logger.removeHandler(collector)
            logger.setLevel(level)


def assert_no_secret(secrets: list[str], *texts: str) -> None:
    for secret in secrets:
        for text in texts:
            assert secret not in text


# --- Bedrock ---------------------------------------------------------------------------------------


@given(base=noise, triple=bedrock_blocked)
@EXAMPLES
def test_bedrock_without_a_complete_credential_makes_no_call_and_names_the_missing_variables(
    base: dict[str, str], triple: tuple[str | None, str | None, str | None]
) -> None:
    environ = bedrock_environment(base, triple)
    expected = expected_bedrock_missing(*triple)
    assert expected != ()

    with captured_logs() as lines:
        attempt = BedrockAttempt(environ)

    # No outbound call: the SDK client was never even created, and nothing was sent through it.
    assert attempt.factory.calls == 0
    assert attempt.runtime.calls == []
    assert attempt.outbound_calls == 0
    assert attempt.output is None

    error = attempt.error
    assert error is not None
    assert error.code == "CREDENTIAL_MISSING"
    assert error.missing == expected
    for name in expected:
        assert name in error.message
    # Names, never values: a half-configured pair must not leak the half that is set.
    assert_no_secret(secrets_in(*triple), error.message, str(error), repr(error), repr(error.__dict__), *lines)


@given(base=noise, triple=bedrock_usable)
@EXAMPLES
def test_bedrock_with_a_usable_credential_stays_usable(
    base: dict[str, str], triple: tuple[str | None, str | None, str | None]
) -> None:
    environ = bedrock_environment(base, triple)
    assert expected_bedrock_missing(*triple) == ()

    attempt = BedrockAttempt(environ)

    assert attempt.error is None
    assert attempt.output == VALID_INPUT
    assert attempt.factory.calls == 1
    assert len(attempt.runtime.calls) == 1


# --- Deepgram --------------------------------------------------------------------------------------


@given(
    base=noise,
    key=absent_or_blank,
    audio=st.binary(max_size=64),
    mime_type=st.sampled_from(["audio/webm", "audio/wav", "not-a-mime-type", ""]),
)
@EXAMPLES
def test_deepgram_without_a_key_makes_no_call_and_names_the_variable(
    base: dict[str, str], key: str | None, audio: bytes, mime_type: str
) -> None:
    environ = make_environment(base, {API_KEY_VARIABLE: key})

    with captured_logs() as lines:
        attempt = DeepgramAttempt(environ, audio, mime_type)

    # The credential check comes before audio validation and before any request: even unusable
    # audio never changes which error is reported, and the transport sees nothing at all.
    assert attempt.requests == []
    assert attempt.text is None
    error = attempt.error
    assert error is not None
    assert error.code == "CREDENTIAL_MISSING"
    assert API_KEY_VARIABLE in error.message
    assert error.recoverable is False
    assert attempt.client.configured is False

    try:
        attempt.client.check_ready()
    except STTError as readiness:
        assert readiness.code == "CREDENTIAL_MISSING"
        assert API_KEY_VARIABLE in readiness.message
    else:  # pragma: no cover - the property would be violated
        raise AssertionError("check_ready() must refuse a missing key")
    assert attempt.requests == []
    assert all("Token" not in line for line in lines)  # no credential header text was ever formed


@given(base=noise, key=usable_secret)
@EXAMPLES
def test_deepgram_with_a_usable_key_stays_usable_and_sends_the_key_only_to_the_provider(
    base: dict[str, str], key: str
) -> None:
    environ = make_environment(base, {API_KEY_VARIABLE: key})

    with captured_logs() as lines:
        attempt = DeepgramAttempt(environ)

    assert attempt.error is None
    assert attempt.text == TRANSCRIPT
    assert attempt.client.configured is True
    assert len(attempt.requests) == 1
    assert attempt.requests[0].headers["authorization"] == f"Token {key.strip()}"
    assert_no_secret(secrets_in(key), *lines)


# --- both clients in one environment ---------------------------------------------------------------


@given(
    base=noise,
    triple=st.one_of(bedrock_blocked, bedrock_usable),
    deepgram_key=st.one_of(absent_or_blank, usable_secret),
)
@EXAMPLES
def test_each_client_depends_only_on_its_own_credentials(
    base: dict[str, str],
    triple: tuple[str | None, str | None, str | None],
    deepgram_key: str | None,
) -> None:
    environ = make_environment(bedrock_environment(base, triple), {API_KEY_VARIABLE: deepgram_key})
    bedrock_usable_now = expected_bedrock_missing(*triple) == ()
    deepgram_usable_now = is_set(deepgram_key)

    with captured_logs() as lines:
        bedrock = BedrockAttempt(environ)
        deepgram = DeepgramAttempt(environ)

    # A client with its credentials makes exactly one call; a client without them makes none, and
    # neither outcome changes because of the other provider's configuration.
    assert bedrock.outbound_calls == (2 if bedrock_usable_now else 0)
    assert (bedrock.error is None) is bedrock_usable_now
    assert len(deepgram.requests) == (1 if deepgram_usable_now else 0)
    assert (deepgram.error is None) is deepgram_usable_now
    assert_no_secret(secrets_in(*triple, deepgram_key), *lines)
    for error in (bedrock.error, deepgram.error):
        if error is not None:
            assert_no_secret(secrets_in(*triple, deepgram_key), error.message, repr(error))


# --- configuration reporting agrees with the clients -----------------------------------------------


@given(
    base=noise,
    triple=st.one_of(bedrock_blocked, bedrock_usable),
    deepgram_key=st.one_of(absent_or_blank, usable_secret),
)
@EXAMPLES
def test_the_reported_missing_credentials_match_what_the_clients_enforce(
    base: dict[str, str],
    triple: tuple[str | None, str | None, str | None],
    deepgram_key: str | None,
) -> None:
    environ = make_environment(bedrock_environment(base, triple), {API_KEY_VARIABLE: deepgram_key})
    config = load_config(environ, MISSING_DOTENV)

    expected_bedrock = expected_bedrock_missing(*triple)
    assert config.missing_credentials("bedrock") == expected_bedrock
    assert bedrock_missing_credentials(environ) == expected_bedrock
    assert config.missing_credentials("deepgram") == (() if is_set(deepgram_key) else (API_KEY_VARIABLE,))

    # The report is names only: no credential value is stored on the config object.
    for secret in secrets_in(*triple, deepgram_key):
        assert secret not in repr(config)
        assert secret not in str(config.present_names)


# --- adjacent: an unusable configuration also blocks the call ---------------------------------------


@given(base=noise, key=usable_secret, bad_model=st.text(max_size=30).map(lambda text: f"BAD MODEL {text}"))
@EXAMPLES
def test_deepgram_with_a_present_key_but_an_invalid_model_name_also_makes_no_call(
    base: dict[str, str], key: str, bad_model: str
) -> None:
    # Not part of Property 26 itself (the key is present), but the same "no call without a usable
    # configuration" rule, and it must not leak the key or echo the bad value.
    assert VALID_MODEL.fullmatch(bad_model.strip()) is None
    environ = make_environment(base, {API_KEY_VARIABLE: key, STT_MODEL_VARIABLE: bad_model})

    attempt = DeepgramAttempt(environ)

    assert attempt.requests == []
    error = attempt.error
    assert error is not None
    assert error.code == "STT_UNAVAILABLE"
    assert STT_MODEL_VARIABLE in error.message
    assert "BAD MODEL" not in error.message
    assert_no_secret(secrets_in(key), error.message, repr(error))
