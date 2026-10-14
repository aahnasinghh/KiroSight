"""Task 8.4: ``audio_clip`` handling over the WebSocket, with a fake speech-to-text client.

No network and no Deepgram: ``FakeSTT`` stands in for the provider, and one test group drives the
real ``DeepgramSTTClient`` over ``httpx.MockTransport``. Each test builds a fresh app and connection.
Waiting uses ``threading.Event`` (the TestClient runs the app on another thread), never sleeps.

"Nothing else was sent" is shown by an ordinary typed round trip afterwards: if an unexpected frame
had been queued, it would arrive before the agent's reply.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import threading
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession

from app import main
from app.agent.stub_agent import StubAgent
from app.main import MAX_CONCURRENT_TRANSCRIPTIONS, create_app
from app.protocol.messages import AgentRequest, AgentResponse, ErrorMessage, HelloAck, TranscriptionResult
from app.protocol.validators import ProtocolValidationError, parse_message
from app.speech.deepgram_service import API_KEY_VARIABLE, DeepgramSTTClient, STTError
from app.speech.recording import MAX_RECORDING_BYTES, RecordingAssembler

FIXTURES = (
    Path(__file__).resolve().parents[2] / "extension" / "src" / "protocol" / "fixtures" / "messages"
)
AUDIO_MARKER = b"FAKEAUDIOBYTES"
TRANSCRIPT = "open the auth file SECRETTRANSCRIPT"
KEY = "fake-key-FAKEKEYMARKER-0123456789"
MIME = "audio/webm;codecs=opus"


# --- doubles ---


class FakeSTT:
    """A speech-to-text client that records calls and answers as told."""

    def __init__(
        self,
        text: str = TRANSCRIPT,
        error: Exception | None = None,
        not_ready: STTError | None = None,
    ) -> None:
        self.text = text
        self.error = error
        self.not_ready = not_ready
        self.calls: list[tuple[bytes, str]] = []

    @property
    def configured(self) -> bool:
        return self.not_ready is None

    def check_ready(self) -> None:
        if self.not_ready is not None:
            raise self.not_ready

    async def transcribe(self, audio: bytes, mime_type: str) -> str:
        self.calls.append((audio, mime_type))
        if self.error is not None:
            raise self.error
        return self.text


class BlockingSTT(FakeSTT):
    """Never answers until cancelled, and says so."""

    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.cancelled = threading.Event()

    async def transcribe(self, audio: bytes, mime_type: str) -> str:
        self.calls.append((audio, mime_type))
        self.started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise
        return "unreachable"


class RecordingAgent:
    """The real stub, remembering which requests it served (a transcript must never reach it)."""

    def __init__(self) -> None:
        self.served: list[str] = []

    async def respond(self, request: AgentRequest) -> AgentResponse:
        self.served.append(request.id)
        return await StubAgent().respond(request)


# --- helpers ---


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def send(ws: WebSocketTestSession, message: dict[str, Any]) -> None:
    ws.send_text(json.dumps(message))


def receive(ws: WebSocketTestSession) -> tuple[Any, str]:
    raw = ws.receive_text()
    parsed = parse_message(json.loads(raw))
    assert not isinstance(parsed, ProtocolValidationError), raw
    return parsed, raw


def handshake(ws: WebSocketTestSession) -> HelloAck:
    send(ws, fixture("hello"))
    ack, _ = receive(ws)
    assert isinstance(ack, HelloAck)
    return ack


def clip(
    recording_id: str = "voice-1",
    data: bytes = AUDIO_MARKER,
    seq: int | None = None,
    final: bool | None = None,
    *,
    mime: str = MIME,
    base64_text: str | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {
        "version": 1,
        "type": "audio_clip",
        "id": recording_id,
        "mimeType": mime,
        "base64": base64.b64encode(data).decode() if base64_text is None else base64_text,
    }
    if seq is not None:
        message["seq"] = seq
        message["final"] = bool(final)
    return message


def cancel(target: str) -> dict[str, Any]:
    return {"version": 1, "type": "cancel", "targetId": target}


def typed_round_trip_works(ws: WebSocketTestSession, request_id: str = "typed-1") -> None:
    """Typed input still works, and nothing unexpected was queued before its reply."""
    send(ws, {**fixture("agent_request"), "id": request_id})
    reply, _ = receive(ws)
    assert isinstance(reply, AgentResponse) and reply.replyTo == request_id


def connect(stt: Any = None, agent: Any = None) -> TestClient:
    return TestClient(create_app(agent=agent if agent is not None else RecordingAgent(), stt=stt))


# --- capabilities ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(("not_ready", "expected"), [(None, True), (STTError("CREDENTIAL_MISSING", "x"), False)])
def test_hello_ack_reports_stt_only_when_a_call_could_be_made(not_ready: STTError | None, expected: bool) -> None:
    with connect(FakeSTT(not_ready=not_ready)).websocket_connect("/ws") as ws:
        ack = handshake(ws)

    assert ack.capabilities.stt is expected
    assert (ack.capabilities.bedrock, ack.capabilities.tts, ack.capabilities.mic) == (False, False, "not_applicable")


def test_the_default_backend_reports_stt_false_without_a_deepgram_key() -> None:
    with TestClient(create_app()).websocket_connect("/ws") as ws:
        assert handshake(ws).capabilities.stt is False


def test_the_default_backend_reports_stt_true_once_a_key_exists_without_calling_anything(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(API_KEY_VARIABLE, KEY)

    with TestClient(create_app()).websocket_connect("/ws") as ws:
        assert handshake(ws).capabilities.stt is True


def test_the_injected_capabilities_are_kept_except_that_stt_tells_the_truth() -> None:
    from app.protocol.messages import Capabilities

    claimed = Capabilities(bedrock=True, stt=True, tts=False, mic="not_applicable")
    app = create_app(agent=RecordingAgent(), capabilities=claimed, stt=FakeSTT(not_ready=STTError("CREDENTIAL_MISSING", "x")))

    with TestClient(app).websocket_connect("/ws") as ws:
        ack = handshake(ws)

    assert (ack.capabilities.bedrock, ack.capabilities.stt) == (True, False)


# --- transcription ------------------------------------------------------------------------------------------


def test_a_whole_clip_is_transcribed_and_answered_with_the_recording_id() -> None:
    stt = FakeSTT()
    agent = RecordingAgent()
    with connect(stt, agent).websocket_connect("/ws") as ws:
        handshake(ws)

        send(ws, clip("voice-7", b"whole clip audio"))
        result, raw = receive(ws)

    assert isinstance(result, TranscriptionResult)
    assert (result.replyTo, result.text) == ("voice-7", TRANSCRIPT)
    assert stt.calls == [(b"whole clip audio", MIME)]
    assert "whole clip audio" not in raw
    assert agent.served == []  # the transcript is returned as data; the backend acts on nothing


def test_a_chunked_recording_is_transcribed_once_from_all_its_chunks_in_order() -> None:
    stt = FakeSTT()
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)

        send(ws, clip("voice-1", b"AAAA", 0, False))
        send(ws, clip("voice-1", b"BB", 1, False))
        assert stt.calls == []  # not transcribed while incomplete
        send(ws, clip("voice-1", b"", 2, True))
        result, _ = receive(ws)

    assert isinstance(result, TranscriptionResult) and result.replyTo == "voice-1"
    assert stt.calls == [(b"AAAABB", MIME)]


def test_a_single_final_chunk_is_transcribed() -> None:
    stt = FakeSTT()
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1", b"only", 0, True))
        result, _ = receive(ws)

    assert isinstance(result, TranscriptionResult)
    assert stt.calls == [(b"only", MIME)]


def test_an_incomplete_recording_is_never_transcribed_even_when_the_connection_closes() -> None:
    stt = FakeSTT()
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1", b"part one", 0, False))
        send(ws, clip("voice-1", b"part two", 1, False))
        typed_round_trip_works(ws)  # the frames were processed and produced no reply

    assert stt.calls == []


def test_two_recordings_one_after_the_other_are_transcribed_separately() -> None:
    stt = FakeSTT()
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1", b"first", 0, True))
        first, _ = receive(ws)
        send(ws, clip("voice-2", b"second", 0, True))
        second, _ = receive(ws)

    assert (first.replyTo, second.replyTo) == ("voice-1", "voice-2")
    assert [call[0] for call in stt.calls] == [b"first", b"second"]


# --- failures are stated, never fabricated ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("code", "recoverable"),
    [("STT_UNAVAILABLE", True), ("STT_NO_SPEECH", True), ("TIMEOUT", True), ("STT_UNAVAILABLE", False)],
)
def test_a_speech_failure_becomes_an_error_message_with_no_transcript(code: str, recoverable: bool) -> None:
    stt = FakeSTT(error=STTError(code, "A fixed safe sentence.", recoverable=recoverable))  # type: ignore[arg-type]
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)

        send(ws, clip("voice-1", b"audio"))
        error, _ = receive(ws)

        assert isinstance(error, ErrorMessage)
        assert (error.code, error.replyTo, error.recoverable) == (code, "voice-1", recoverable)
        assert error.message == "A fixed safe sentence."
        typed_round_trip_works(ws)  # typed input is unaffected and nothing else was sent


def test_an_unexpected_exception_is_an_internal_error_that_leaks_nothing() -> None:
    stt = FakeSTT(error=RuntimeError(f"boom {KEY} {AUDIO_MARKER!r} {TRANSCRIPT}"))
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1"))
        error, raw = receive(ws)

        assert isinstance(error, ErrorMessage) and error.code == "INTERNAL" and error.replyTo == "voice-1"
        assert "FAKEKEYMARKER" not in raw and "FAKEAUDIOBYTES" not in raw and "SECRETTRANSCRIPT" not in raw
        typed_round_trip_works(ws)


def test_missing_credentials_collect_no_audio_make_no_call_and_report_once_per_recording() -> None:
    missing = STTError("CREDENTIAL_MISSING", "Speech recognition is not configured: DEEPGRAM_API_KEY is missing.", recoverable=False)
    stt = FakeSTT(not_ready=missing)
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)

        send(ws, clip("voice-1", b"a", 0, False))
        error, _ = receive(ws)
        send(ws, clip("voice-1", b"b", 1, False))
        send(ws, clip("voice-1", b"c", 2, True))
        typed_round_trip_works(ws)  # the rest of the recording produced no further errors

    assert isinstance(error, ErrorMessage)
    assert (error.code, error.replyTo, error.recoverable) == ("CREDENTIAL_MISSING", "voice-1", False)
    assert "DEEPGRAM_API_KEY" in error.message
    assert stt.calls == []


def test_the_default_backend_without_a_key_names_the_missing_variable_and_calls_nothing() -> None:
    with TestClient(create_app(agent=RecordingAgent())).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1"))
        error, _ = receive(ws)

    assert isinstance(error, ErrorMessage) and error.code == "CREDENTIAL_MISSING"
    assert API_KEY_VARIABLE in error.message


# --- invalid audio -----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "message",
    [
        clip(mime="text/plain"),
        clip(mime="video/webm"),
        clip(base64_text="not base64 at all!"),
        clip(base64_text="abc"),
        clip(seq=3, final=False),
        clip(recording_id=""),
    ],
    ids=["text-mime", "video-mime", "bad-base64", "bad-padding", "starts-mid-sequence", "empty-id"],
)
def test_invalid_audio_gets_a_safe_validation_error_and_is_never_transcribed(message: dict[str, Any]) -> None:
    stt = FakeSTT()
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)

        send(ws, message)
        error, raw = receive(ws)

        assert isinstance(error, ErrorMessage) and error.code == "VALIDATION_FAILED" and error.recoverable is True
        assert message["base64"] not in raw or message["base64"] == ""
        typed_round_trip_works(ws)

    assert stt.calls == []


def test_a_repeated_frame_discards_the_recording_and_nothing_is_transcribed() -> None:
    stt = FakeSTT()
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1", b"one", 0, False))
        send(ws, clip("voice-1", b"one", 0, False))  # repeated
        error, _ = receive(ws)
        send(ws, clip("voice-1", b"two", 1, True))  # the discarded recording's last frame: ignored
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and error.code == "VALIDATION_FAILED" and error.replyTo == "voice-1"
    assert stt.calls == []


def test_a_gap_in_the_sequence_discards_the_recording() -> None:
    stt = FakeSTT()
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1", b"one", 0, False))
        send(ws, clip("voice-1", b"three", 2, True))
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and "out of order" in error.message
    assert stt.calls == []


def test_a_finished_recording_cannot_be_submitted_twice() -> None:
    stt = FakeSTT()
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1", b"once"))
        receive(ws)
        send(ws, clip("voice-1", b"once"))
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and "already received" in error.message
    assert len(stt.calls) == 1


def test_a_recording_over_the_size_limit_is_refused_and_the_connection_stays_usable() -> None:
    stt = FakeSTT()
    quarter = MAX_RECORDING_BYTES // 4
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)
        for number in range(4):
            send(ws, clip("voice-1", b"x" * quarter, number, False))
        send(ws, clip("voice-1", b"y", 4, True))
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and error.code == "VALIDATION_FAILED" and "large" in error.message
    assert stt.calls == []


def test_a_recording_with_no_audio_is_no_speech_without_calling_the_provider() -> None:
    stt = FakeSTT()
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1", b"", 0, True))
        error, _ = receive(ws)

    assert isinstance(error, ErrorMessage) and error.code == "STT_NO_SPEECH" and error.replyTo == "voice-1"
    assert stt.calls == []


def test_audio_before_the_handshake_is_refused_and_not_processed() -> None:
    stt = FakeSTT()
    with connect(stt).websocket_connect("/ws") as ws:
        send(ws, clip("voice-1"))
        error, _ = receive(ws)

    assert isinstance(error, ErrorMessage) and error.code == "VALIDATION_FAILED"
    assert stt.calls == []


def test_recording_messages_without_a_configured_recorder_are_refused_with_a_stated_error() -> None:
    """Task 8.5 added the backend-local recorder; with none configured the backend says so.

    (Originally a Task 8.4 guard that these messages were unsupported. The contract is now: no
    recorder means ``MIC_UNAVAILABLE`` for a start, and a stop for nothing is a validation error.)
    """
    with connect(FakeSTT()).websocket_connect("/ws") as ws:
        assert handshake(ws).capabilities.mic == "not_applicable"

        send(ws, {"version": 1, "type": "record_start", "id": "rec-1"})
        error, _ = receive(ws)
        assert isinstance(error, ErrorMessage) and (error.code, error.recoverable) == ("MIC_UNAVAILABLE", False)

        send(ws, {"version": 1, "type": "record_stop", "id": "rec-1"})
        error, _ = receive(ws)
        assert isinstance(error, ErrorMessage) and error.code == "VALIDATION_FAILED"


# --- cancellation, disconnect, concurrency ---------------------------------------------------------------------------


def test_cancel_discards_a_partial_recording_and_the_late_final_frame_is_ignored() -> None:
    stt = FakeSTT()
    spies: list[RecordingAssembler] = []

    class Spy(RecordingAssembler):
        def __init__(self) -> None:
            super().__init__()
            spies.append(self)

    monkey = pytest.MonkeyPatch()
    monkey.setattr(main, "RecordingAssembler", Spy)
    try:
        with connect(stt).websocket_connect("/ws") as ws:
            handshake(ws)
            send(ws, clip("voice-1", b"part", 0, False))
            send(ws, cancel("voice-1"))
            send(ws, clip("voice-1", b"rest", 1, True))
            typed_round_trip_works(ws)  # no transcription, and no error for the ignored frame
            assert spies[0].partial_count == 0 and spies[0].retained_bytes == 0
    finally:
        monkey.undo()

    assert stt.calls == []


def test_cancel_stops_a_transcription_in_progress_and_sends_no_reply() -> None:
    stt = BlockingSTT()
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1"))
        assert stt.started.wait(5)

        send(ws, cancel("voice-1"))
        assert stt.cancelled.wait(5)
        typed_round_trip_works(ws)  # nothing was sent for the cancelled transcription


def test_closing_the_connection_cancels_a_transcription_in_progress() -> None:
    stt = BlockingSTT()
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1"))
        assert stt.started.wait(5)

    assert stt.cancelled.wait(5)


def test_closing_the_connection_releases_partial_recordings() -> None:
    spies: list[RecordingAssembler] = []

    class Spy(RecordingAssembler):
        def __init__(self) -> None:
            super().__init__()
            spies.append(self)

    monkey = pytest.MonkeyPatch()
    monkey.setattr(main, "RecordingAssembler", Spy)
    try:
        with connect(FakeSTT()).websocket_connect("/ws") as ws:
            handshake(ws)
            send(ws, clip("a", b"x" * 1000, 0, False))
            send(ws, clip("b", b"y" * 1000, 0, False))
            typed_round_trip_works(ws)
            assert spies[0].partial_count == 2 and spies[0].retained_bytes == 2000
    finally:
        monkey.undo()

    assert spies[0].partial_count == 0 and spies[0].retained_bytes == 0


def test_a_recording_cannot_continue_on_a_new_connection() -> None:
    stt = FakeSTT()
    app = create_app(agent=RecordingAgent(), stt=stt)
    with TestClient(app).websocket_connect("/ws") as first:
        handshake(first)
        send(first, clip("voice-1", b"part", 0, False))
        typed_round_trip_works(first)
    with TestClient(app).websocket_connect("/ws") as second:
        handshake(second)
        send(second, clip("voice-1", b"rest", 1, True))
        error, _ = receive(second)

    assert isinstance(error, ErrorMessage) and "out of order" in error.message
    assert stt.calls == []


def test_the_number_of_simultaneous_transcriptions_is_bounded() -> None:
    stt = BlockingSTT()
    with connect(stt).websocket_connect("/ws") as ws:
        handshake(ws)
        for number in range(MAX_CONCURRENT_TRANSCRIPTIONS):
            send(ws, clip(f"voice-{number}"))
        send(ws, clip("one-too-many"))
        error, _ = receive(ws)

    assert isinstance(error, ErrorMessage) and error.code == "STT_UNAVAILABLE" and error.replyTo == "one-too-many"
    assert len(stt.calls) == MAX_CONCURRENT_TRANSCRIPTIONS


def test_a_recording_id_that_is_an_agent_request_in_flight_is_refused() -> None:
    class BlockingAgent:
        def __init__(self) -> None:
            self.started = threading.Event()

        async def respond(self, request: AgentRequest) -> AgentResponse:
            self.started.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    agent = BlockingAgent()
    stt = FakeSTT()
    with connect(stt, agent).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, {**fixture("agent_request"), "id": "shared-id"})
        assert agent.started.wait(5)

        send(ws, clip("shared-id"))
        error, _ = receive(ws)

    assert isinstance(error, ErrorMessage) and error.code == "VALIDATION_FAILED" and error.replyTo == "shared-id"


# --- the real Deepgram client, over a mock transport ---------------------------------------------------------------


def deepgram_over(handler: Any, **kwargs: Any) -> DeepgramSTTClient:
    return DeepgramSTTClient(environ={API_KEY_VARIABLE: KEY}, transport=httpx.MockTransport(handler), **kwargs)


def test_the_real_client_end_to_end_with_a_mock_transport() -> None:
    seen: list[httpx.Request] = []

    def deepgram(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = {"results": {"channels": [{"alternatives": [{"transcript": "go to line forty two"}]}]}}
        return httpx.Response(200, json=body)

    with connect(deepgram_over(deepgram)).websocket_connect("/ws") as ws:
        assert handshake(ws).capabilities.stt is True
        send(ws, clip("voice-1", b"AAAA", 0, False))
        send(ws, clip("voice-1", b"BBBB", 1, True))
        result, _ = receive(ws)

    assert isinstance(result, TranscriptionResult) and result.text == "go to line forty two"
    assert len(seen) == 1 and seen[0].content == b"AAAABBBB"
    assert seen[0].headers["authorization"] == f"Token {KEY}"


@pytest.mark.parametrize(
    ("handler", "code"),
    [
        (lambda request: httpx.Response(200, json={"results": {"channels": [{"alternatives": [{"transcript": ""}]}]}}), "STT_NO_SPEECH"),
        (lambda request: httpx.Response(503, text="down"), "STT_UNAVAILABLE"),
        (lambda request: httpx.Response(200, content=b"<html>not json</html>"), "STT_UNAVAILABLE"),
    ],
    ids=["empty-transcript", "service-unavailable", "malformed-response"],
)
def test_the_real_client_failures_reach_the_extension_as_stated_errors(handler: Any, code: str) -> None:
    with connect(deepgram_over(handler)).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1"))
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and (error.code, error.replyTo) == (code, "voice-1")


def test_the_real_client_times_out_with_a_stated_error() -> None:
    async def never_answers(request: httpx.Request) -> httpx.Response:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    with connect(deepgram_over(never_answers, timeout_seconds=0.05)).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1"))
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and (error.code, error.replyTo) == ("TIMEOUT", "voice-1")


# --- privacy -----------------------------------------------------------------------------------------------------------


def test_neither_audio_nor_transcripts_nor_keys_are_logged(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)

    def deepgram(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": {"channels": [{"alternatives": [{"transcript": TRANSCRIPT}]}]}})

    with connect(deepgram_over(deepgram)).websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, clip("voice-1", AUDIO_MARKER * 4, 0, False))
        send(ws, clip("voice-1", AUDIO_MARKER * 4, 1, True))
        receive(ws)
        send(ws, clip("voice-2", base64_text="SECRETBADBASE64!!"))
        receive(ws)
        send(ws, clip("voice-3", AUDIO_MARKER, mime="text/SECRETMIME"))
        receive(ws)

    logged = caplog.text
    assert "voice-1" in logged  # ids and sizes are logged
    for secret in (
        "FAKEAUDIOBYTES",
        base64.b64encode(AUDIO_MARKER).decode(),
        "SECRETTRANSCRIPT",
        "FAKEKEYMARKER",
        "SECRETBADBASE64",
        "SECRETMIME",
    ):
        assert secret not in logged
