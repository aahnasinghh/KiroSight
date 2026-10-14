"""Task 8.8: Deepgram speech-to-text and the backend-local recorder, checked end to end on the wire.

Earlier tasks tested the pieces one at a time (``test_deepgram_service.py`` for the client,
``test_local_recorder.py`` for the recorder). This file checks the whole chain the extension actually
sees: a WebSocket message goes in, and the right ``transcription_result`` or ``error_message`` code
comes out, with the real ``DeepgramSTTClient`` talking to ``httpx.MockTransport`` and the real
``LocalRecorder`` reading from a fake microphone.

* Deepgram over a mock transport: success, every HTTP error status, a timeout and an empty
  transcript, on both audio paths (a whole ``audio_clip`` and ``record_start`` / ``record_stop``).
* Fake recorder: microphone unavailable and denied (nothing opens, nothing is sent to Deepgram), and
  the 60 s cap, shown with the real default limit and a controllable clock instead of a real minute.

No network, no Deepgram, no AWS and no real microphone. The "key" and audio are marker strings so a
leak into an error or a log line is detectable. Waiting uses ``threading.Event``, never sleeps.
"""

from __future__ import annotations

import asyncio
import io
import logging
import threading
import wave
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import create_app
from app.protocol.messages import ErrorMessage, TranscriptionResult
from app.speech import deepgram_service
from app.speech.deepgram_service import DeepgramSTTClient
from app.speech.local_recorder import (
    MAX_RECORDING_SECONDS,
    MIC_DENIED_MESSAGE,
    MIC_UNAVAILABLE_MESSAGE,
    LocalRecorder,
    MicrophoneError,
)

from ._fake_audio import FakeInput
from .test_local_recording_websocket import PCM, app_with, begin, start, stop, wav_pcm
from .test_stt_websocket import (
    KEY,
    RecordingAgent,
    clip,
    deepgram_over,
    handshake,
    receive,
    send,
    typed_round_trip_works,
)

WORDS = "go to line forty two"


def transcript_body(transcript: str) -> dict[str, Any]:
    return {"results": {"channels": [{"alternatives": [{"transcript": transcript}]}]}}


class Provider:
    """The mock Deepgram: records every request and answers with ``responder``."""

    def __init__(self, responder: Callable[[httpx.Request], httpx.Response] | None = None) -> None:
        self.requests: list[httpx.Request] = []
        self._responder = responder or (lambda request: httpx.Response(200, json=transcript_body(WORDS)))

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._responder(request)


def failing(status: int) -> Provider:
    return Provider(lambda request: httpx.Response(status, text=f"provider says {KEY} and FAKEPCMSECRET"))


def hanging() -> Callable[[httpx.Request], Any]:
    async def never_answers(request: httpx.Request) -> httpx.Response:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    return never_answers


# What each HTTP status must become on the wire: (status, error code, recoverable).
STATUS_TABLE = [
    (302, "STT_UNAVAILABLE", True),  # redirects are never followed, and are not an answer
    (400, "STT_UNAVAILABLE", True),
    (401, "STT_UNAVAILABLE", False),  # the configured key was refused: retrying cannot help
    (403, "STT_UNAVAILABLE", False),
    (404, "STT_UNAVAILABLE", True),
    (408, "TIMEOUT", True),
    (413, "STT_UNAVAILABLE", True),
    (415, "STT_UNAVAILABLE", True),
    (422, "STT_UNAVAILABLE", True),
    (429, "STT_UNAVAILABLE", True),
    (500, "STT_UNAVAILABLE", True),
    (502, "STT_UNAVAILABLE", True),
    (503, "STT_UNAVAILABLE", True),
    (504, "TIMEOUT", True),
]
EMPTY_TRANSCRIPTS = ["", "   ", "\n\t "]


def assert_safe(error: ErrorMessage) -> None:
    """A wire error is a fixed sentence: no key, no audio, no provider text."""
    for secret in (KEY, "FAKEKEYMARKER", "FAKEPCMSECRET", "FAKEAUDIOBYTES", "provider says"):
        assert secret not in error.message


def app_for(stt: DeepgramSTTClient) -> TestClient:
    return TestClient(create_app(agent=RecordingAgent(), stt=stt))


def record_with(device: FakeInput, stt: DeepgramSTTClient) -> TestClient:
    client, _ = app_with(device, stt)
    return client


def record_one(ws: Any, device: FakeInput, recording_id: str = "rec-1") -> Any:
    stream = begin(ws, device, recording_id)
    stream.push(PCM)
    send(ws, stop(recording_id))
    return stream


# === Deepgram over a mock transport: a whole audio_clip ==========================================================


def test_a_clip_is_transcribed_and_answered_with_the_recording_id() -> None:
    provider = Provider()

    with app_for(deepgram_over(provider)).websocket_connect("/ws") as ws:
        assert handshake(ws).capabilities.stt is True
        send(ws, clip("voice-1"))
        result, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(result, TranscriptionResult) and (result.replyTo, result.text) == ("voice-1", WORDS)
    assert len(provider.requests) == 1
    assert provider.requests[0].url.params["model"] == "nova-2"
    assert provider.requests[0].headers["authorization"] == f"Token {KEY}"


@pytest.mark.parametrize(("status", "code", "recoverable"), STATUS_TABLE)
def test_a_clip_http_error_becomes_the_right_error_message(status: int, code: str, recoverable: bool) -> None:
    provider = failing(status)

    with app_for(deepgram_over(provider)).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1"))
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage)
    assert (error.code, error.replyTo, error.recoverable) == (code, "voice-1", recoverable)
    assert len(provider.requests) == 1  # one attempt, never retried
    assert_safe(error)


@pytest.mark.parametrize("transcript", EMPTY_TRANSCRIPTS)
def test_a_clip_with_an_empty_transcript_is_no_speech(transcript: str) -> None:
    provider = Provider(lambda request: httpx.Response(200, json=transcript_body(transcript)))

    with app_for(deepgram_over(provider)).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1"))
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and (error.code, error.replyTo) == ("STT_NO_SPEECH", "voice-1")
    assert error.recoverable is True


def test_a_clip_whose_transport_times_out_is_a_timeout_error() -> None:
    def read_timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timed out", request=request)

    with app_for(deepgram_over(read_timeout)).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1"))
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and (error.code, error.replyTo) == ("TIMEOUT", "voice-1")


# === Deepgram over a mock transport: the backend-local recorder path ========================================================


def test_a_recording_reaches_deepgram_as_a_wav_after_the_microphone_closed() -> None:
    device = FakeInput()
    closed_at_request: list[bool] = []

    def respond(request: httpx.Request) -> httpx.Response:
        closed_at_request.append(device.streams[-1].closed)
        return httpx.Response(200, json=transcript_body(WORDS))

    provider = Provider(respond)

    with record_with(device, deepgram_over(provider)).websocket_connect("/ws") as ws:
        handshake(ws)
        record_one(ws, device)
        result, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(result, TranscriptionResult) and (result.replyTo, result.text) == ("rec-1", WORDS)
    assert len(provider.requests) == 1
    request = provider.requests[0]
    assert request.headers["content-type"] == "audio/wav"
    assert wav_pcm(request.content) == PCM
    assert closed_at_request == [True]  # the audio is not uploaded while the microphone is still open


@pytest.mark.parametrize(("status", "code", "recoverable"), STATUS_TABLE)
def test_a_recording_http_error_becomes_the_right_error_message_and_recording_works_again(
    status: int, code: str, recoverable: bool
) -> None:
    device = FakeInput()
    answers = iter([httpx.Response(status, text=f"provider says {KEY}"), httpx.Response(200, json=transcript_body(WORDS))])
    provider = Provider(lambda request: next(answers))

    with record_with(device, deepgram_over(provider)).websocket_connect("/ws") as ws:
        handshake(ws)
        first_stream = record_one(ws, device, "rec-1")
        error, _ = receive(ws)
        record_one(ws, device, "rec-2")
        result, _ = receive(ws)

    assert isinstance(error, ErrorMessage)
    assert (error.code, error.replyTo, error.recoverable) == (code, "rec-1", recoverable)
    assert_safe(error)
    assert first_stream.closed and device.open_streams == []  # a failed upload never leaves the microphone open
    assert isinstance(result, TranscriptionResult) and result.replyTo == "rec-2"
    assert len(provider.requests) == 2


@pytest.mark.parametrize("transcript", EMPTY_TRANSCRIPTS)
def test_a_recording_with_an_empty_transcript_is_no_speech(transcript: str) -> None:
    device = FakeInput()
    provider = Provider(lambda request: httpx.Response(200, json=transcript_body(transcript)))

    with record_with(device, deepgram_over(provider)).websocket_connect("/ws") as ws:
        handshake(ws)
        record_one(ws, device)
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and (error.code, error.replyTo) == ("STT_NO_SPEECH", "rec-1")
    assert device.open_streams == []


def test_a_recording_whose_upload_times_out_is_a_timeout_error() -> None:
    device = FakeInput()

    with record_with(device, deepgram_over(hanging(), timeout_seconds=0.05)).websocket_connect("/ws") as ws:
        handshake(ws)
        record_one(ws, device)
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and (error.code, error.replyTo) == ("TIMEOUT", "rec-1")
    assert device.open_streams == []


# === the 10 s speech-to-text budget ===================================================================================


class _Proxy:
    """A module stand-in that forwards everything except the named overrides (patched in one module only)."""

    def __init__(self, real: Any, **overrides: Any) -> None:
        object.__setattr__(self, "_real", real)
        object.__setattr__(self, "_overrides", overrides)

    def __getattr__(self, name: str) -> Any:
        overrides = object.__getattribute__(self, "_overrides")
        if name in overrides:
            return overrides[name]
        return getattr(object.__getattribute__(self, "_real"), name)


def test_the_ten_second_budget_is_what_the_client_asks_for_and_expiry_is_a_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The real limit is 10 s; the test records it and lets only the *wait* be short."""
    budgets: list[float | None] = []
    client_timeouts: list[Any] = []

    async def short_wait_for(awaitable: Any, timeout: float | None) -> Any:
        budgets.append(timeout)
        return await asyncio.wait_for(awaitable, 0.05)

    class RecordingAsyncClient(httpx.AsyncClient):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            client_timeouts.append(kwargs.get("timeout"))
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(deepgram_service, "asyncio", _Proxy(asyncio, wait_for=short_wait_for))
    monkeypatch.setattr(deepgram_service, "httpx", _Proxy(httpx, AsyncClient=RecordingAsyncClient))
    stt = DeepgramSTTClient(environ={deepgram_service.API_KEY_VARIABLE: KEY}, transport=httpx.MockTransport(hanging()))

    with app_for(stt).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1"))
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and (error.code, error.replyTo) == ("TIMEOUT", "voice-1")
    assert budgets == [10.0] and client_timeouts == [10.0]


# === the fake recorder: microphone unavailable and denied ================================================================


@pytest.mark.parametrize(
    ("status", "code", "message"),
    [("unavailable", "MIC_UNAVAILABLE", MIC_UNAVAILABLE_MESSAGE), ("denied", "MIC_DENIED", MIC_DENIED_MESSAGE)],
)
def test_an_unusable_microphone_is_refused_before_anything_opens_or_is_sent_to_deepgram(
    status: str, code: str, message: str
) -> None:
    device = FakeInput(status=status)  # type: ignore[arg-type]
    provider = Provider()

    with record_with(device, deepgram_over(provider)).websocket_connect("/ws") as ws:
        ack = handshake(ws)
        send(ws, start("rec-1"))
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert ack.capabilities.mic == status and ack.capabilities.stt is True
    assert isinstance(error, ErrorMessage)
    assert (error.code, error.replyTo, error.message, error.recoverable) == (code, "rec-1", message, True)
    assert device.open_calls == 0 and device.streams == []
    assert provider.requests == []


@pytest.mark.parametrize(("code", "message"), [("MIC_UNAVAILABLE", "The microphone failed to open."), ("MIC_DENIED", "Access was refused.")])
def test_a_microphone_that_fails_to_open_is_reported_with_its_code_and_nothing_is_uploaded(code: str, message: str) -> None:
    device = FakeInput(open_error=MicrophoneError(code, message))  # type: ignore[arg-type]
    provider = Provider()

    with record_with(device, deepgram_over(provider)).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, start("rec-1"))
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and (error.code, error.replyTo, error.message) == (code, "rec-1", message)
    assert provider.requests == [] and device.open_streams == []


@pytest.mark.parametrize("status", ["unavailable", "denied"])
def test_a_microphone_that_is_fixed_later_records_and_transcribes_on_the_same_connection(status: str) -> None:
    device = FakeInput(status=status)  # type: ignore[arg-type]
    provider = Provider()

    with record_with(device, deepgram_over(provider)).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, start("first"))
        refused, _ = receive(ws)
        device.current_status = "available"
        record_one(ws, device, "second")
        result, _ = receive(ws)

    assert isinstance(refused, ErrorMessage) and refused.replyTo == "first"
    assert isinstance(result, TranscriptionResult) and (result.replyTo, result.text) == ("second", WORDS)
    assert len(provider.requests) == 1


# === the fake recorder: the 60 s cap ========================================================================================


class CapClock:
    """Stands in for the recording-cap timer: records the delay and fires only when the test says so."""

    def __init__(self) -> None:
        self.delays: list[float] = []
        self.armed = threading.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._gate: asyncio.Event | None = None

    async def sleep(self, delay: float, result: Any = None) -> Any:
        if delay < 1:
            return await asyncio.sleep(delay, result)
        self.delays.append(delay)
        self._loop = asyncio.get_running_loop()
        self._gate = asyncio.Event()
        self.armed.set()
        await self._gate.wait()
        return result

    def expire(self) -> None:
        assert self._loop is not None and self._gate is not None
        self._loop.call_soon_threadsafe(self._gate.set)


def test_the_default_recording_cap_is_sixty_seconds_of_audio() -> None:
    recorder = LocalRecorder(FakeInput())

    assert MAX_RECORDING_SECONDS == recorder.max_seconds == 60.0
    assert recorder.max_bytes == 60 * 16_000 * 2 == 1_920_000


def test_a_recording_is_stopped_and_transcribed_when_the_sixty_second_cap_expires(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = CapClock()
    monkeypatch.setattr(main, "asyncio", _Proxy(asyncio, sleep=clock.sleep))
    device = FakeInput()
    provider = Provider()
    app = create_app(agent=RecordingAgent(), stt=deepgram_over(provider), recorder=LocalRecorder(device))

    with TestClient(app).websocket_connect("/ws") as ws:
        handshake(ws)
        stream = begin(ws, device, "long")
        assert clock.armed.wait(5)
        assert clock.delays == [60.0]  # the real default cap, not a shortened one

        stream.push(PCM)
        typed_round_trip_works(ws, "while-recording")  # still recording, nothing was sent early
        assert provider.requests == [] and stream.closed is False

        clock.expire()
        result, _ = receive(ws)  # no record_stop was sent: the cap ended the recording

        assert isinstance(result, TranscriptionResult) and (result.replyTo, result.text) == ("long", WORDS)
        assert stream.close_calls == 1
        send(ws, stop("long"))  # the extension's own stop arrives late and is ignored
        typed_round_trip_works(ws)

    assert len(provider.requests) == 1 and wav_pcm(provider.requests[0].content) == PCM


def test_audio_beyond_sixty_seconds_is_dropped_before_it_reaches_deepgram() -> None:
    device = FakeInput()
    provider = Provider()
    recorder = LocalRecorder(device)  # the real default cap
    app = create_app(agent=RecordingAgent(), stt=deepgram_over(provider), recorder=recorder)
    one_second = b"\x01\x00" * 16_000

    with TestClient(app).websocket_connect("/ws") as ws:
        handshake(ws)
        stream = begin(ws, device, "long")
        for _ in range(65):  # five seconds more than the cap is offered
            stream.push(one_second)
        send(ws, stop("long"))
        result, _ = receive(ws)

    assert isinstance(result, TranscriptionResult)
    sent = wav_pcm(provider.requests[0].content)
    assert len(sent) == recorder.max_bytes == 1_920_000
    with wave.open(io.BytesIO(provider.requests[0].content), "rb") as reader:
        assert reader.getnframes() / reader.getframerate() == 60.0


# === privacy on the combined path ==========================================================================================


def test_neither_the_key_nor_the_audio_nor_the_transcript_is_logged_on_the_recorder_path(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    device = FakeInput()
    answers = iter([httpx.Response(200, json=transcript_body("SECRETWORDS spoken")), httpx.Response(503, text=f"{KEY}")])
    provider = Provider(lambda request: next(answers))

    with record_with(device, deepgram_over(provider)).websocket_connect("/ws") as ws:
        handshake(ws)
        record_one(ws, device, "rec-1")
        receive(ws)
        record_one(ws, device, "rec-2")
        receive(ws)

    logged = caplog.text
    assert "rec-1" in logged  # ids and sizes are logged
    for secret in ("FAKEPCMSECRET", "SECRETWORDS", "FAKEKEYMARKER", KEY):
        assert secret not in logged
