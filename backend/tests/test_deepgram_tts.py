"""Task 9.1: the Deepgram Aura text-to-speech client, over ``httpx.MockTransport``.

No network is ever used: every test supplies a mock transport and a fake environment mapping. The
"key" is a made-up marker string so a leak into an error message or a log line is detectable.
(These tests overlap the optional Task 9.2; that task stays unchecked.)
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
    DEFAULT_TTS_MODEL,
    MAX_AUDIO_BYTES,
    MAX_TTS_CHARS,
    TTS_MODEL_VARIABLE,
    TTS_TIMEOUT_SECONDS,
    DeepgramTTSClient,
    SynthesizedSpeech,
    TTSError,
)

KEY = "fake-key-FAKEKEYMARKER-0123456789"
SPOKEN = "Opened the file. There are two errors."
AUDIO = b"ID3FAKEMP3BYTES-" + bytes(range(40))
ENVIRON = {API_KEY_VARIABLE: KEY}


def audio_response(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, content=AUDIO, headers={"content-type": "audio/mpeg"})


class Recorder:
    """A mock transport that records every request and answers with ``responder``."""

    def __init__(self, responder: Any = audio_response) -> None:
        self.requests: list[httpx.Request] = []
        self._responder = responder
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> Any:
        self.requests.append(request)
        return self._responder(request)


def client_for(recorder: Recorder, environ: dict[str, str] | None = None, **kwargs: Any) -> DeepgramTTSClient:
    return DeepgramTTSClient(environ=ENVIRON if environ is None else environ, transport=recorder.transport, **kwargs)


async def failure(client: DeepgramTTSClient, text: str = SPOKEN) -> TTSError:
    with pytest.raises(TTSError) as caught:
        await client.synthesize(text)
    return caught.value


# --- success and request shape -------------------------------------------------------------------


async def test_success_returns_the_audio_bytes_and_mime_type() -> None:
    result = await client_for(Recorder()).synthesize(SPOKEN)

    assert result == SynthesizedSpeech(audio=AUDIO, mime_type="audio/mpeg")


async def test_the_request_is_one_authenticated_json_post_with_the_default_aura_model_and_mp3() -> None:
    recorder = Recorder()

    await client_for(recorder).synthesize(SPOKEN)

    assert len(recorder.requests) == 1
    request = recorder.requests[0]
    assert request.method == "POST"
    assert request.url.host == "api.deepgram.com" and request.url.path == "/v1/speak"
    assert request.url.params["model"] == DEFAULT_TTS_MODEL == "aura-asteria-en"
    assert request.url.params["encoding"] == "mp3"
    assert request.headers["authorization"] == f"Token {KEY}"
    assert request.headers["content-type"] == "application/json"
    assert json.loads(request.content) == {"text": SPOKEN}
    assert KEY not in str(request.url)  # the key travels only in the header


async def test_the_model_comes_from_deepgram_tts_model() -> None:
    recorder = Recorder()

    await client_for(recorder, {**ENVIRON, TTS_MODEL_VARIABLE: "aura-2-thalia-en"}).synthesize(SPOKEN)

    assert recorder.requests[0].url.params["model"] == "aura-2-thalia-en"


async def test_the_response_content_type_parameters_are_dropped() -> None:
    recorder = Recorder(lambda r: httpx.Response(200, content=AUDIO, headers={"content-type": "Audio/MPEG; charset=x"}))

    assert (await client_for(recorder).synthesize(SPOKEN)).mime_type == "audio/mpeg"


async def test_the_text_is_sent_unchanged_as_data_not_interpreted() -> None:
    recorder = Recorder()
    tricky = 'Say "hi" \\ {"text": "x"} \n tab\t \u00e9\u4e2d'

    await client_for(recorder).synthesize(tricky)

    assert json.loads(recorder.requests[0].content) == {"text": tricky}


# --- configuration: no call without it -----------------------------------------------------------


@pytest.mark.parametrize("environ", [{}, {API_KEY_VARIABLE: ""}, {API_KEY_VARIABLE: "   "}])
async def test_a_missing_or_blank_key_makes_no_call_and_names_the_variable(environ: dict[str, str]) -> None:
    recorder = Recorder()
    client = client_for(recorder, environ)

    error = await failure(client)

    assert (error.code, error.recoverable) == ("CREDENTIAL_MISSING", False)
    assert API_KEY_VARIABLE in error.message
    assert recorder.requests == []
    assert client.configured is False
    with pytest.raises(TTSError) as caught:
        client.check_ready()
    assert caught.value.code == "CREDENTIAL_MISSING"


@pytest.mark.parametrize("model", ["bad model", "-x", "a/b", "x" * 65, "m\u00e9"])
async def test_an_invalid_model_name_is_a_configuration_error_and_is_never_repeated(model: str) -> None:
    recorder = Recorder()
    client = client_for(recorder, {**ENVIRON, TTS_MODEL_VARIABLE: model})

    error = await failure(client)

    assert (error.code, error.recoverable) == ("TTS_UNAVAILABLE", False)
    assert TTS_MODEL_VARIABLE in error.message and model not in error.message
    assert recorder.requests == [] and client.configured is False


def test_a_key_alone_is_a_configured_client_and_it_copies_no_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(API_KEY_VARIABLE, KEY)
    client = DeepgramTTSClient()

    assert client.configured is True
    assert KEY not in repr(vars(client))  # read from the environment per call, never stored


def test_the_key_is_read_from_the_process_environment_when_no_mapping_is_given(monkeypatch: pytest.MonkeyPatch) -> None:
    assert DeepgramTTSClient().configured is False
    monkeypatch.setenv(API_KEY_VARIABLE, KEY)
    assert DeepgramTTSClient().configured is True


# --- text validation -------------------------------------------------------------------------------


@pytest.mark.parametrize("text", ["", "   ", "\n\t "])
async def test_empty_text_makes_no_call(text: str) -> None:
    recorder = Recorder()

    error = await failure(client_for(recorder), text)

    assert error.code == "TTS_UNAVAILABLE"
    assert recorder.requests == []


async def test_over_long_text_is_rejected_not_truncated_and_makes_no_call() -> None:
    recorder = Recorder()

    error = await failure(client_for(recorder), "a" * (MAX_TTS_CHARS + 1))

    assert error.code == "TTS_UNAVAILABLE" and recorder.requests == []
    assert (await client_for(recorder).synthesize("a" * MAX_TTS_CHARS)).audio == AUDIO


async def test_non_string_text_is_rejected() -> None:
    recorder = Recorder()

    with pytest.raises(TTSError):
        await client_for(recorder).synthesize(None)  # type: ignore[arg-type]

    assert recorder.requests == []


# --- HTTP errors -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "code", "recoverable"),
    [
        (401, "TTS_UNAVAILABLE", False),
        (403, "TTS_UNAVAILABLE", False),
        (400, "TTS_UNAVAILABLE", True),
        (413, "TTS_UNAVAILABLE", True),
        (429, "TTS_UNAVAILABLE", True),
        (408, "TIMEOUT", True),
        (504, "TIMEOUT", True),
        (500, "TTS_UNAVAILABLE", True),
        (503, "TTS_UNAVAILABLE", True),
        (302, "TTS_UNAVAILABLE", True),  # redirects are not followed
    ],
)
async def test_http_errors_map_to_fixed_outcomes_and_are_never_retried(status: int, code: str, recoverable: bool) -> None:
    recorder = Recorder(
        lambda r: httpx.Response(
            status, json={"err_msg": "PROVIDER-DETAIL"}, headers={"location": "https://elsewhere.invalid/"}
        )
    )

    error = await failure(client_for(recorder))

    assert (error.code, error.recoverable) == (code, recoverable)
    assert "PROVIDER-DETAIL" not in error.message and KEY not in error.message
    assert len(recorder.requests) == 1


# --- timeouts and transport failures -------------------------------------------------------------------


def test_the_timeout_is_ten_seconds_by_default() -> None:
    assert TTS_TIMEOUT_SECONDS == 10.0
    assert DeepgramTTSClient()._timeout == 10.0  # noqa: SLF001 - the documented default


async def test_a_transport_level_timeout_is_a_timeout() -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timed out", request=request)

    error = await failure(client_for(Recorder(slow)))

    assert (error.code, error.recoverable) == ("TIMEOUT", True)


async def test_no_answer_within_the_budget_is_a_timeout_even_if_the_transport_never_returns() -> None:
    async def never(request: httpx.Request) -> httpx.Response:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    error = await failure(client_for(Recorder(never), timeout_seconds=0.05))

    assert error.code == "TIMEOUT" and error.recoverable is True


async def test_a_network_failure_is_tts_unavailable() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    error = await failure(client_for(Recorder(refuse)))

    assert (error.code, error.recoverable) == ("TTS_UNAVAILABLE", True)


async def test_an_unexpected_exception_is_tts_unavailable_without_its_text() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise RuntimeError(f"internal {KEY}")

    error = await failure(client_for(Recorder(boom)))

    assert error.code == "TTS_UNAVAILABLE" and KEY not in error.message


# --- cancellation ------------------------------------------------------------------------------------


async def test_cancelling_an_in_flight_synthesis_stops_it() -> None:
    started = asyncio.Event()
    stopped = asyncio.Event()

    async def hang(request: httpx.Request) -> httpx.Response:
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            stopped.set()
            raise
        raise AssertionError("unreachable")

    task = asyncio.create_task(client_for(Recorder(hang)).synthesize(SPOKEN))
    await asyncio.wait_for(started.wait(), 2)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert stopped.is_set()


# --- malformed responses -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, content=b"", headers={"content-type": "audio/mpeg"}),
        httpx.Response(200, content=AUDIO),  # no content type
        httpx.Response(200, content=AUDIO, headers={"content-type": "application/json"}),
        httpx.Response(200, content=b"<html>", headers={"content-type": "text/html"}),
        httpx.Response(200, content=AUDIO, headers={"content-type": "audio/"}),
    ],
)
async def test_an_unusable_success_response_is_tts_unavailable(response: httpx.Response) -> None:
    error = await failure(client_for(Recorder(lambda r: response)))

    assert error.code == "TTS_UNAVAILABLE"


async def test_a_response_over_the_size_cap_is_rejected() -> None:
    big = b"\x00" * (MAX_AUDIO_BYTES + 1)
    recorder = Recorder(lambda r: httpx.Response(200, content=big, headers={"content-type": "audio/mpeg"}))

    error = await failure(client_for(recorder))

    assert error.code == "TTS_UNAVAILABLE"


# --- no leakage ---------------------------------------------------------------------------------------------


async def test_neither_the_key_nor_the_text_nor_the_audio_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    secret_text = "SECRETSPOKENTEXT private words"

    await client_for(Recorder()).synthesize(secret_text)
    for status in (401, 500):
        await failure(client_for(Recorder(lambda r, s=status: httpx.Response(s, text="PROVIDER-DETAIL"))), secret_text)
    await failure(client_for(Recorder(), {}), secret_text)

    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert logged != ""
    for forbidden in (KEY, "SECRETSPOKENTEXT", "PROVIDER-DETAIL", "FAKEMP3BYTES"):
        assert forbidden not in logged


# --- Task 9.2 additions: gaps found by the coverage audit ------------------------------------------------
# (422, timeout cancels the underlying work, a stalled body counts against the budget, the size cap
# stops reading early, redirects are never followed, and nothing sensitive reaches an error.)


async def test_a_422_is_a_could_not_process_error_with_no_provider_detail() -> None:
    recorder = Recorder(lambda r: httpx.Response(422, json={"err_msg": "PROVIDER-DETAIL"}))

    error = await failure(client_for(recorder))

    assert (error.code, error.recoverable) == ("TTS_UNAVAILABLE", True)
    assert error.message == "Spoken playback could not process that text."
    assert len(recorder.requests) == 1


async def test_every_error_message_is_a_fixed_sentence_that_repeats_no_input() -> None:
    secret_text = "SECRETSPOKENTEXT private words"
    seen: set[str] = set()
    for status in (400, 401, 403, 408, 413, 422, 429, 500, 504):
        recorder = Recorder(lambda r, s=status: httpx.Response(s, text=f"PROVIDER-DETAIL {KEY} {secret_text}"))
        error = await failure(client_for(recorder), secret_text)
        seen.add(error.message)
        for forbidden in ("PROVIDER-DETAIL", KEY, "SECRETSPOKENTEXT"):
            assert forbidden not in error.message
    assert len(seen) == 5  # credential, timeout, busy, could-not-process, unavailable


async def test_a_timeout_cancels_the_underlying_work_and_no_late_audio_is_returned() -> None:
    started = asyncio.Event()
    cancelled = asyncio.Event()
    finished_normally = False

    async def stall(request: httpx.Request) -> httpx.Response:
        nonlocal finished_normally
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        finished_normally = True
        return audio_response(request)

    error = await failure(client_for(Recorder(stall), timeout_seconds=0.05))

    assert started.is_set() and error.code == "TIMEOUT"
    assert cancelled.is_set() and finished_normally is False


async def test_a_body_that_stalls_after_the_headers_still_times_out() -> None:
    class Stalling(httpx.AsyncByteStream):
        async def __aiter__(self) -> Any:
            yield b"ID3"
            await asyncio.Event().wait()

    recorder = Recorder(lambda r: httpx.Response(200, stream=Stalling(), headers={"content-type": "audio/mpeg"}))

    error = await failure(client_for(recorder, timeout_seconds=0.05))

    assert (error.code, error.recoverable) == ("TIMEOUT", True)


@pytest.mark.parametrize("exc", [httpx.ConnectTimeout, httpx.WriteTimeout, httpx.PoolTimeout])
async def test_every_httpx_timeout_kind_is_a_timeout(exc: type[httpx.TimeoutException]) -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise exc("timed out", request=request)

    assert (await failure(client_for(Recorder(slow)))).code == "TIMEOUT"


async def test_reading_stops_soon_after_the_size_cap_instead_of_accumulating_the_whole_body() -> None:
    chunk = b"\x00" * (1024 * 1024)
    served = 0

    class Endless(httpx.AsyncByteStream):
        async def __aiter__(self) -> Any:
            nonlocal served
            for _ in range(1000):  # a 1000 MiB body, if anyone read it all
                served += 1
                yield chunk

    recorder = Recorder(lambda r: httpx.Response(200, stream=Endless(), headers={"content-type": "audio/mpeg"}))

    error = await failure(client_for(recorder))

    assert error.code == "TTS_UNAVAILABLE"
    assert served <= MAX_AUDIO_BYTES // len(chunk) + 1


async def test_a_clip_exactly_at_the_cap_is_accepted() -> None:
    exact = b"\x00" * MAX_AUDIO_BYTES
    recorder = Recorder(lambda r: httpx.Response(200, content=exact, headers={"content-type": "audio/mpeg"}))

    assert len((await client_for(recorder).synthesize(SPOKEN)).audio) == MAX_AUDIO_BYTES


async def test_a_redirect_is_not_followed_so_the_key_is_not_sent_elsewhere() -> None:
    recorder = Recorder(
        lambda r: httpx.Response(307, headers={"location": "https://elsewhere.invalid/v1/speak"}, content=b"x")
    )

    error = await failure(client_for(recorder))

    assert error.code == "TTS_UNAVAILABLE"
    assert [request.url.host for request in recorder.requests] == ["api.deepgram.com"]


async def test_a_blank_key_never_reaches_the_transport_even_when_the_text_is_valid_and_after_a_good_call() -> None:
    recorder = Recorder()

    assert (await client_for(recorder).synthesize(SPOKEN)).audio == AUDIO
    error = await failure(client_for(recorder, {API_KEY_VARIABLE: "\t \n"}))

    assert error.code == "CREDENTIAL_MISSING"
    assert len(recorder.requests) == 1  # only the first, configured client called out


async def test_concurrent_syntheses_do_not_interfere_and_one_can_be_cancelled() -> None:
    started = asyncio.Event()
    release = asyncio.Event()

    async def respond(request: httpx.Request) -> httpx.Response:
        text = json.loads(request.content)["text"]
        if text == "hang":
            started.set()
            await asyncio.Event().wait()
        await release.wait()
        return httpx.Response(200, content=text.encode(), headers={"content-type": "audio/mpeg"})

    recorder = Recorder(respond)
    hung = asyncio.create_task(client_for(recorder).synthesize("hang"))
    other = asyncio.create_task(client_for(recorder).synthesize("other"))
    await asyncio.wait_for(started.wait(), 2)

    hung.cancel()
    release.set()

    with pytest.raises(asyncio.CancelledError):
        await hung
    assert (await asyncio.wait_for(other, 2)).audio == b"other"


async def test_cancelling_after_completion_is_harmless() -> None:
    task = asyncio.create_task(client_for(Recorder()).synthesize(SPOKEN))
    result = await asyncio.wait_for(task, 2)

    task.cancel()  # too late: nothing to stop, and no error

    assert result.audio == AUDIO and task.cancelled() is False
