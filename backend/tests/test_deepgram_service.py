"""Task 8.4: the Deepgram Nova-2 speech-to-text client, over ``httpx.MockTransport``.

No network is ever used: every test supplies a mock transport and a fake environment mapping. The
"key" below is a made-up marker string so a leak into an error message or a log line is detectable.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx
import pytest

from app.speech.deepgram_service import (
    API_KEY_VARIABLE,
    DEFAULT_STT_MODEL,
    MAX_RESPONSE_BYTES,
    MAX_TRANSCRIPT_CHARS,
    STT_MODEL_VARIABLE,
    STT_TIMEOUT_SECONDS,
    DeepgramSTTClient,
    STTError,
)

KEY = "fake-key-FAKEKEYMARKER-0123456789"
AUDIO = b"FAKEAUDIOBYTES-" + bytes(range(40))
ENVIRON = {API_KEY_VARIABLE: KEY}


def deepgram_body(transcript: Any) -> dict[str, Any]:
    return {"results": {"channels": [{"alternatives": [{"transcript": transcript, "confidence": 0.99}]}]}}


class Recorder:
    """A mock transport that records every request and answers with ``responder``."""

    def __init__(self, responder: Any = None) -> None:
        self.requests: list[httpx.Request] = []
        self._responder = responder or (lambda request: httpx.Response(200, json=deepgram_body("hello world")))
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> Any:
        self.requests.append(request)
        return self._responder(request)


def client_for(recorder: Recorder, environ: dict[str, str] | None = None, **kwargs: Any) -> DeepgramSTTClient:
    return DeepgramSTTClient(environ=ENVIRON if environ is None else environ, transport=recorder.transport, **kwargs)


async def failure(client: DeepgramSTTClient, audio: bytes = AUDIO, mime: str = "audio/webm") -> STTError:
    with pytest.raises(STTError) as caught:
        await client.transcribe(audio, mime)
    return caught.value


# --- success and request shape -------------------------------------------------------------------


async def test_a_valid_transcript_is_returned_trimmed() -> None:
    recorder = Recorder(lambda request: httpx.Response(200, json=deepgram_body("  what errors are there  ")))

    assert await client_for(recorder).transcribe(AUDIO, "audio/webm") == "what errors are there"


async def test_the_request_is_one_authenticated_post_of_the_raw_audio_to_the_nova_2_model() -> None:
    recorder = Recorder()

    await client_for(recorder).transcribe(AUDIO, "audio/webm;codecs=opus")

    assert len(recorder.requests) == 1
    request = recorder.requests[0]
    assert request.method == "POST"
    assert request.url.host == "api.deepgram.com" and request.url.path == "/v1/listen"
    assert request.url.params["model"] == "nova-2" == DEFAULT_STT_MODEL
    assert request.headers["authorization"] == f"Token {KEY}"
    assert request.headers["content-type"] == "audio/webm"  # the base type: parameters are dropped
    assert request.content == AUDIO


async def test_the_model_comes_from_the_environment() -> None:
    recorder = Recorder()

    await client_for(recorder, {**ENVIRON, STT_MODEL_VARIABLE: "nova-2-general"}).transcribe(AUDIO, "audio/webm")

    assert recorder.requests[0].url.params["model"] == "nova-2-general"


async def test_the_key_is_read_when_needed_not_when_the_client_is_built() -> None:
    environ: dict[str, str] = {}
    recorder = Recorder()
    client = client_for(recorder, environ)
    assert client.configured is False

    environ[API_KEY_VARIABLE] = KEY  # e.g. a .env loaded after construction

    assert client.configured is True
    assert await client.transcribe(AUDIO, "audio/webm") == "hello world"


# --- missing configuration: no call at all -----------------------------------------------------------


@pytest.mark.parametrize("environ", [{}, {API_KEY_VARIABLE: ""}, {API_KEY_VARIABLE: "   \t"}])
async def test_a_missing_or_blank_key_makes_no_call_and_names_the_variable(environ: dict[str, str]) -> None:
    recorder = Recorder()
    client = client_for(recorder, environ)

    error = await failure(client)

    assert recorder.requests == []
    assert (error.code, error.recoverable) == ("CREDENTIAL_MISSING", False)
    assert API_KEY_VARIABLE in error.message
    assert client.configured is False
    with pytest.raises(STTError) as ready:
        client.check_ready()
    assert ready.value.code == "CREDENTIAL_MISSING"


@pytest.mark.parametrize("model", ["nova 2", "../admin", "nova-2&x=1", "n" * 65, "a\nb", "-nova"])
async def test_a_malformed_model_name_makes_no_call_and_is_not_repeated(model: str) -> None:
    recorder = Recorder()
    client = client_for(recorder, {**ENVIRON, STT_MODEL_VARIABLE: model})

    error = await failure(client)

    assert recorder.requests == []
    assert error.code == "STT_UNAVAILABLE" and STT_MODEL_VARIABLE in error.message
    assert model not in error.message
    assert client.configured is False


async def test_only_the_key_is_needed_for_a_blank_model_variable() -> None:
    assert client_for(Recorder(), {**ENVIRON, STT_MODEL_VARIABLE: "  "}).configured is True


# --- failures ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "code", "recoverable"),
    [
        (400, "STT_UNAVAILABLE", True),
        (401, "STT_UNAVAILABLE", False),
        (403, "STT_UNAVAILABLE", False),
        (413, "STT_UNAVAILABLE", True),
        (415, "STT_UNAVAILABLE", True),
        (429, "STT_UNAVAILABLE", True),
        (408, "TIMEOUT", True),
        (504, "TIMEOUT", True),
        (500, "STT_UNAVAILABLE", True),
        (502, "STT_UNAVAILABLE", True),
        (503, "STT_UNAVAILABLE", True),
    ],
)
async def test_an_error_status_maps_to_a_stated_error_after_exactly_one_attempt(
    status: int, code: str, recoverable: bool
) -> None:
    recorder = Recorder(lambda request: httpx.Response(status, text=f"provider says {KEY} and {AUDIO!r}"))

    error = await failure(client_for(recorder))

    assert (error.code, error.recoverable) == (code, recoverable)
    assert len(recorder.requests) == 1  # no retry
    assert KEY not in error.message and "FAKEAUDIOBYTES" not in error.message
    assert "provider says" not in error.message


async def test_a_redirect_is_not_followed_so_the_key_is_never_sent_elsewhere() -> None:
    recorder = Recorder(lambda request: httpx.Response(302, headers={"location": "https://elsewhere.invalid/x"}))

    error = await failure(client_for(recorder))

    assert error.code == "STT_UNAVAILABLE"
    assert [str(request.url.host) for request in recorder.requests] == ["api.deepgram.com"]


async def test_a_network_failure_is_unavailable_and_does_not_leak_the_cause() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused by secret-host.invalid", request=request)

    recorder = Recorder(refuse)

    error = await failure(client_for(recorder))

    assert (error.code, error.recoverable) == ("STT_UNAVAILABLE", True)
    assert "secret-host" not in error.message
    assert len(recorder.requests) == 1


async def test_a_transport_level_timeout_is_a_timeout() -> None:
    def too_slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timed out", request=request)

    error = await failure(client_for(Recorder(too_slow)))

    assert error.code == "TIMEOUT"


async def test_no_answer_within_the_budget_is_a_timeout_even_if_the_transport_never_returns() -> None:
    async def hang(request: httpx.Request) -> httpx.Response:
        await asyncio.Event().wait()  # never set
        raise AssertionError("unreachable")

    recorder = Recorder(hang)
    started = asyncio.get_running_loop().time()

    error = await failure(client_for(recorder, timeout_seconds=0.05))

    assert error.code == "TIMEOUT" and error.recoverable is True
    assert asyncio.get_running_loop().time() - started < 2
    assert len(recorder.requests) == 1


def test_the_default_budget_is_ten_seconds() -> None:
    assert STT_TIMEOUT_SECONDS == 10.0
    assert DeepgramSTTClient()._timeout == 10.0  # noqa: SLF001 - the documented default


async def test_an_unexpected_exception_is_unavailable_and_does_not_leak() -> None:
    def explode(request: httpx.Request) -> httpx.Response:
        raise RuntimeError(f"boom {KEY} {AUDIO!r}")

    error = await failure(client_for(Recorder(explode)))

    assert error.code == "STT_UNAVAILABLE"
    assert KEY not in error.message and "FAKEAUDIOBYTES" not in error.message


# --- empty and malformed answers ---------------------------------------------------------------------


@pytest.mark.parametrize("transcript", ["", "   ", "\n\t "])
async def test_an_empty_transcript_is_no_speech_not_a_made_up_one(transcript: str) -> None:
    recorder = Recorder(lambda request: httpx.Response(200, json=deepgram_body(transcript)))

    error = await failure(client_for(recorder))

    assert (error.code, error.recoverable) == ("STT_NO_SPEECH", True)


@pytest.mark.parametrize(
    "body",
    [
        b"not json at all",
        b"",
        b"[]",
        b"null",
        b"{}",
        b'{"results": {}}',
        b'{"results": {"channels": []}}',
        b'{"results": {"channels": [{}]}}',
        b'{"results": {"channels": [{"alternatives": []}]}}',
        b'{"results": {"channels": [{"alternatives": [{}]}]}}',
        b'{"results": {"channels": [{"alternatives": [{"transcript": 5}]}]}}',
        b'{"results": {"channels": [{"alternatives": [{"transcript": null}]}]}}',
        b'{"results": {"channels": [{"alternatives": [{"transcript": ["a"]}]}]}}',
        b'{"results": {"channels": "x"}}',
        b"[" * 5000,
    ],
)
async def test_a_malformed_answer_is_unavailable_never_a_transcript(body: bytes) -> None:
    recorder = Recorder(lambda request: httpx.Response(200, content=body))

    error = await failure(client_for(recorder))

    assert error.code == "STT_UNAVAILABLE"


async def test_an_oversized_answer_is_refused() -> None:
    recorder = Recorder(lambda request: httpx.Response(200, content=b"x" * (MAX_RESPONSE_BYTES + 1)))

    error = await failure(client_for(recorder))

    assert error.code == "STT_UNAVAILABLE"


async def test_a_transcript_longer_than_an_utterance_is_refused_not_truncated() -> None:
    at_limit = "a" * MAX_TRANSCRIPT_CHARS
    ok = Recorder(lambda request: httpx.Response(200, json=deepgram_body(at_limit)))
    assert await client_for(ok).transcribe(AUDIO, "audio/webm") == at_limit

    too_long = Recorder(lambda request: httpx.Response(200, json=deepgram_body(at_limit + "a")))
    error = await failure(client_for(too_long))
    assert error.code == "STT_UNAVAILABLE"


# --- invalid audio, locally detected ----------------------------------------------------------------


async def test_empty_audio_is_no_speech_and_makes_no_call() -> None:
    recorder = Recorder()

    error = await failure(client_for(recorder), audio=b"")

    assert error.code == "STT_NO_SPEECH"
    assert recorder.requests == []


@pytest.mark.parametrize("mime", ["text/plain", "audio/", "", "audio/webm\r\nX-Evil: 1", "video/webm", "audio/we bm"])
async def test_an_unusable_audio_type_makes_no_call(mime: str) -> None:
    recorder = Recorder()

    error = await failure(client_for(recorder), mime=mime)

    assert error.code == "STT_UNAVAILABLE"
    assert recorder.requests == []


# --- privacy -----------------------------------------------------------------------------------------


async def test_neither_the_key_nor_the_audio_nor_the_transcript_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    ok = Recorder(lambda request: httpx.Response(200, json=deepgram_body("transcript SECRETWORDS here")))
    await client_for(ok).transcribe(AUDIO, "audio/webm")
    for status in (401, 500):
        bad = Recorder(lambda request, status=status: httpx.Response(status, text=f"{KEY}"))
        await failure(client_for(bad))
    await failure(client_for(Recorder(), {}))
    await failure(client_for(Recorder(lambda request: httpx.Response(200, json=deepgram_body("")))))

    logged = caplog.text
    assert "FAKEKEYMARKER" not in logged and "FAKEAUDIOBYTES" not in logged
    assert "SECRETWORDS" not in logged
    assert json.dumps(deepgram_body("x")) not in logged


def test_the_repr_of_the_client_shows_no_key() -> None:
    client = DeepgramSTTClient(environ=ENVIRON)

    assert "FAKEKEYMARKER" not in repr(client)
    assert "FAKEKEYMARKER" not in str(client)
