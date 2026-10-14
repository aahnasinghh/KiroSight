"""Task 8.5: ``record_start`` / ``record_stop`` over the WebSocket, with a fake microphone.

No real audio device, no Deepgram and no network: ``FakeInput`` is the microphone and ``FakeSTT``
the speech-to-text client. The microphone only opens after a ``record_start`` the test sends, and
"nothing else happened" is shown by an ordinary typed round trip afterwards (an unexpected frame
would arrive before the agent's reply).
"""

from __future__ import annotations

import io
import logging
import wave
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.protocol.messages import ErrorMessage, TranscriptionResult
from app.speech.deepgram_service import STTError
from app.speech.local_recorder import (
    MIC_DENIED_MESSAGE,
    MIC_UNAVAILABLE_MESSAGE,
    LocalRecorder,
    MicrophoneError,
)

from ._fake_audio import FakeInput
from .test_stt_websocket import (
    TRANSCRIPT,
    BlockingSTT,
    FakeSTT,
    RecordingAgent,
    handshake,
    receive,
    send,
    typed_round_trip_works,
)

PCM = b"FAKEPCMSECRET!!!"  # 16 bytes: 8 whole samples


def start(recording_id: str = "rec-1") -> dict[str, Any]:
    return {"version": 1, "type": "record_start", "id": recording_id}


def stop(recording_id: str = "rec-1") -> dict[str, Any]:
    return {"version": 1, "type": "record_stop", "id": recording_id}


def cancel(target: str = "rec-1") -> dict[str, Any]:
    return {"version": 1, "type": "cancel", "targetId": target}


def app_with(device: FakeInput, stt: Any = None, agent: Any = None, *, max_seconds: float = 60.0) -> tuple[TestClient, LocalRecorder]:
    recorder = LocalRecorder(device, max_seconds=max_seconds)
    app = create_app(agent=agent if agent is not None else RecordingAgent(), stt=stt if stt is not None else FakeSTT(), recorder=recorder)
    return TestClient(app), recorder


def begin(ws: Any, device: FakeInput, recording_id: str = "rec-1") -> Any:
    """Send record_start and wait until the server has really opened the (fake) microphone."""
    device.opened.clear()
    send(ws, start(recording_id))
    assert device.opened.wait(5)
    return device.streams[-1]


def wav_pcm(wav_bytes: bytes) -> bytes:
    with wave.open(io.BytesIO(wav_bytes), "rb") as reader:
        assert (reader.getnchannels(), reader.getsampwidth(), reader.getframerate()) == (1, 2, 16_000)
        return reader.readframes(reader.getnframes())


# --- capabilities and "nothing starts by itself" --------------------------------------------------------------


@pytest.mark.parametrize("status", ["available", "unavailable", "denied"])
def test_hello_ack_reports_the_default_microphone_state_without_recording(status: str) -> None:
    device = FakeInput(status=status)  # type: ignore[arg-type]
    client, _ = app_with(device)

    with client.websocket_connect("/ws") as ws:
        ack = handshake(ws)

    assert ack.capabilities.mic == status
    assert device.status_calls >= 1
    assert device.open_calls == 0 and device.streams == []  # asking never records


def test_connecting_and_typing_never_open_the_microphone() -> None:
    device = FakeInput()
    client, _ = app_with(device)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        typed_round_trip_works(ws)

    assert device.open_calls == 0


def test_a_recording_is_never_transcribed_or_closed_without_a_stop_or_the_cap() -> None:
    device = FakeInput()
    stt = FakeSTT()
    client, recorder = app_with(device, stt)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        stream = begin(ws, device)
        stream.push(PCM)
        typed_round_trip_works(ws)  # the microphone is open, and nothing else happened
        assert recorder.is_recording and stream.close_calls == 0
        assert stt.calls == []

    assert stream.close_calls == 1  # closing the connection released it


# --- the normal path ----------------------------------------------------------------------------------------------


def test_start_then_stop_transcribes_the_recorded_audio_and_answers_with_the_recording_id() -> None:
    device = FakeInput()
    stt = FakeSTT()
    agent = RecordingAgent()
    client, recorder = app_with(device, stt, agent)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        stream = begin(ws, device, "rec-7")
        stream.push(PCM)
        stream.push(PCM)
        send(ws, stop("rec-7"))
        result, raw = receive(ws)

    assert isinstance(result, TranscriptionResult)
    assert (result.replyTo, result.text) == ("rec-7", TRANSCRIPT)
    assert len(stt.calls) == 1 and stt.calls[0][1] == "audio/wav"
    assert wav_pcm(stt.calls[0][0]) == PCM * 2
    assert "FAKEPCMSECRET" not in raw
    assert stream.close_calls == 1 and recorder.is_recording is False
    assert agent.served == []  # the transcript is data for the extension; the backend acts on nothing


def test_the_microphone_is_closed_before_the_clip_is_sent_to_speech_recognition() -> None:
    device = FakeInput()
    seen: list[int] = []

    class CheckingSTT(FakeSTT):
        async def transcribe(self, audio: bytes, mime_type: str) -> str:
            seen.append(len(device.open_streams))
            return await super().transcribe(audio, mime_type)

    client, _ = app_with(device, CheckingSTT())
    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        begin(ws, device).push(PCM)
        send(ws, stop())
        receive(ws)

    assert seen == [0]


def test_two_recordings_one_after_the_other_work_and_are_transcribed_separately() -> None:
    device = FakeInput()
    stt = FakeSTT()
    client, _ = app_with(device, stt)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        begin(ws, device, "a").push(PCM)
        send(ws, stop("a"))
        first, _ = receive(ws)
        begin(ws, device, "b").push(PCM * 2)
        send(ws, stop("b"))
        second, _ = receive(ws)

    assert (first.replyTo, second.replyTo) == ("a", "b")
    assert [len(wav_pcm(call[0])) for call in stt.calls] == [16, 32]
    assert all(stream.close_calls == 1 for stream in device.streams) and len(device.streams) == 2


# --- failures are stated, and typed input keeps working -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "code", "message"),
    [("unavailable", "MIC_UNAVAILABLE", MIC_UNAVAILABLE_MESSAGE), ("denied", "MIC_DENIED", MIC_DENIED_MESSAGE)],
)
def test_an_unusable_microphone_gets_a_stated_error_and_is_never_opened(status: str, code: str, message: str) -> None:
    device = FakeInput(status=status)  # type: ignore[arg-type]
    client, _ = app_with(device)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, start("rec-1"))
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage)
    assert (error.code, error.replyTo, error.message, error.recoverable) == (code, "rec-1", message, True)
    assert device.open_calls == 0


@pytest.mark.parametrize("code", ["MIC_DENIED", "MIC_UNAVAILABLE"])
def test_a_device_that_fails_when_opened_is_reported_with_its_code(code: str) -> None:
    device = FakeInput(open_error=MicrophoneError(code, "A fixed sentence."))  # type: ignore[arg-type]
    client, recorder = app_with(device)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, start())
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and (error.code, error.replyTo) == (code, "rec-1")
    assert recorder.is_recording is False


def test_a_microphone_fixed_later_works_on_the_same_connection_without_a_restart() -> None:
    device = FakeInput(status="denied")
    stt = FakeSTT()
    client, _ = app_with(device, stt)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, start("first"))
        denied, _ = receive(ws)
        device.current_status = "available"  # access granted in system settings

        begin(ws, device, "second").push(PCM)
        send(ws, stop("second"))
        result, _ = receive(ws)

    assert isinstance(denied, ErrorMessage) and denied.code == "MIC_DENIED"
    assert isinstance(result, TranscriptionResult) and result.replyTo == "second"


def test_without_speech_credentials_nothing_is_recorded() -> None:
    missing = STTError("CREDENTIAL_MISSING", "Speech recognition is not configured: DEEPGRAM_API_KEY is missing.", recoverable=False)
    device = FakeInput()
    client, _ = app_with(device, FakeSTT(not_ready=missing))

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, start())
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and (error.code, error.recoverable) == ("CREDENTIAL_MISSING", False)
    assert "DEEPGRAM_API_KEY" in error.message
    assert device.open_calls == 0  # audio that could not be transcribed is never captured


def test_a_speech_recognition_failure_after_recording_is_stated_and_the_microphone_is_already_closed() -> None:
    device = FakeInput()
    stt = FakeSTT(error=STTError("STT_UNAVAILABLE", "Speech recognition is unavailable."))
    client, _ = app_with(device, stt)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        stream = begin(ws, device)
        stream.push(PCM)
        send(ws, stop())
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and (error.code, error.replyTo) == ("STT_UNAVAILABLE", "rec-1")
    assert stream.close_calls == 1


def test_a_recording_with_no_audio_is_no_speech_without_calling_the_provider() -> None:
    device = FakeInput()
    stt = FakeSTT()
    client, _ = app_with(device, stt)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        stream = begin(ws, device)
        send(ws, stop())
        error, _ = receive(ws)

    assert isinstance(error, ErrorMessage) and (error.code, error.replyTo) == ("STT_NO_SPEECH", "rec-1")
    assert stt.calls == [] and stream.close_calls == 1


def test_a_device_that_stops_mid_recording_is_a_stated_error_and_is_released() -> None:
    device = FakeInput()
    stt = FakeSTT()
    client, recorder = app_with(device, stt)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        stream = begin(ws, device)
        stream.push(PCM)
        stream.lose()
        send(ws, stop())
        error, _ = receive(ws)
        typed_round_trip_works(ws)

    assert isinstance(error, ErrorMessage) and (error.code, error.replyTo) == ("MIC_UNAVAILABLE", "rec-1")
    assert stt.calls == [] and stream.close_calls == 1 and recorder.is_recording is False


# --- start / stop discipline -------------------------------------------------------------------------------------------------


def test_a_second_start_while_recording_is_refused_and_the_first_recording_survives() -> None:
    device = FakeInput()
    stt = FakeSTT()
    client, _ = app_with(device, stt)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        stream = begin(ws, device, "first")
        stream.push(PCM)
        send(ws, start("second"))
        refused, _ = receive(ws)
        send(ws, stop("first"))
        result, _ = receive(ws)

    assert isinstance(refused, ErrorMessage) and refused.code == "VALIDATION_FAILED" and refused.replyTo == "second"
    assert "already in progress" in refused.message
    assert isinstance(result, TranscriptionResult) and result.replyTo == "first"
    assert device.open_calls == 1


def test_a_repeated_stop_is_ignored_and_the_clip_is_transcribed_once() -> None:
    device = FakeInput()
    stt = FakeSTT()
    client, _ = app_with(device, stt)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        begin(ws, device).push(PCM)
        send(ws, stop())
        receive(ws)
        send(ws, stop())
        send(ws, stop())
        typed_round_trip_works(ws)  # no reply, no second transcription

    assert len(stt.calls) == 1


def test_stopping_a_recording_that_never_started_is_a_validation_error() -> None:
    client, _ = app_with(FakeInput())

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        send(ws, stop("nothing"))
        error, _ = receive(ws)

    assert isinstance(error, ErrorMessage) and error.code == "VALIDATION_FAILED" and error.replyTo == "nothing"


def test_a_stop_for_a_different_id_does_not_end_the_live_recording() -> None:
    device = FakeInput()
    client, recorder = app_with(device)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        stream = begin(ws, device, "mine")
        send(ws, stop("someone-else"))
        error, _ = receive(ws)
        assert recorder.is_recording and stream.close_calls == 0

    assert isinstance(error, ErrorMessage) and error.code == "VALIDATION_FAILED"


def test_a_finished_recording_id_cannot_be_started_again() -> None:
    device = FakeInput()
    client, _ = app_with(device)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        begin(ws, device, "once").push(PCM)
        send(ws, stop("once"))
        receive(ws)
        send(ws, start("once"))
        error, _ = receive(ws)

    assert isinstance(error, ErrorMessage) and error.code == "VALIDATION_FAILED" and error.replyTo == "once"
    assert device.open_calls == 1


def test_recording_messages_before_the_handshake_do_not_open_the_microphone() -> None:
    device = FakeInput()
    client, _ = app_with(device)

    with client.websocket_connect("/ws") as ws:
        send(ws, start())
        error, _ = receive(ws)

    assert isinstance(error, ErrorMessage) and error.code == "VALIDATION_FAILED"
    assert device.open_calls == 0


# --- cancellation, disconnect, limits ---------------------------------------------------------------------------------------


def test_cancel_discards_the_recording_releases_the_microphone_and_sends_no_reply() -> None:
    device = FakeInput()
    stt = FakeSTT()
    client, recorder = app_with(device, stt)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        stream = begin(ws, device)
        stream.push(PCM)
        send(ws, cancel())
        send(ws, stop())  # the extension's late stop: ignored, not an error
        typed_round_trip_works(ws)

    assert stream.close_calls == 1 and recorder.is_recording is False
    assert stt.calls == []


def test_cancel_stops_a_transcription_already_in_progress() -> None:
    device = FakeInput()
    stt = BlockingSTT()
    client, _ = app_with(device, stt)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        begin(ws, device).push(PCM)
        send(ws, stop())
        assert stt.started.wait(5)

        send(ws, cancel())
        assert stt.cancelled.wait(5)
        typed_round_trip_works(ws)


def test_disconnecting_during_a_recording_closes_the_microphone_and_frees_the_recorder() -> None:
    device = FakeInput()
    stt = FakeSTT()
    client, recorder = app_with(device, stt)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        stream = begin(ws, device)
        stream.push(PCM)

    assert stream.close_calls == 1 and recorder.is_recording is False
    assert stt.calls == []  # a dropped connection never sends audio anywhere
    recorder.start().cancel()  # the next recording can begin


def test_disconnecting_during_transcription_cancels_it() -> None:
    device = FakeInput()
    stt = BlockingSTT()
    client, _ = app_with(device, stt)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        begin(ws, device).push(PCM)
        send(ws, stop())
        assert stt.started.wait(5)

    assert stt.cancelled.wait(5)


def test_the_microphone_is_shared_so_a_second_connection_cannot_record_at_the_same_time() -> None:
    device = FakeInput()
    stt = FakeSTT()
    client, _ = app_with(device, stt)

    with client.websocket_connect("/ws") as first, client.websocket_connect("/ws") as second:
        handshake(first)
        handshake(second)
        begin(first, device, "mine").push(PCM)

        send(second, start("theirs"))
        refused, _ = receive(second)
        send(first, stop("mine"))
        result, _ = receive(first)

    assert isinstance(refused, ErrorMessage) and refused.code == "MIC_UNAVAILABLE" and refused.replyTo == "theirs"
    assert isinstance(result, TranscriptionResult)
    assert device.open_calls == 1


def test_the_backend_stops_and_transcribes_at_its_own_recording_cap() -> None:
    device = FakeInput()
    stt = FakeSTT()
    client, recorder = app_with(device, stt, max_seconds=0.05)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        stream = begin(ws, device, "long")
        stream.push(PCM)
        result, _ = receive(ws)  # arrives with no record_stop: the cap ended the recording

        assert isinstance(result, TranscriptionResult) and result.replyTo == "long"
        assert stream.close_calls == 1 and recorder.is_recording is False
        send(ws, stop("long"))  # the extension's own stop arrives late: ignored
        typed_round_trip_works(ws)

    assert len(stt.calls) == 1


def test_audio_beyond_the_cap_is_dropped_before_it_reaches_speech_recognition() -> None:
    device = FakeInput()
    stt = FakeSTT()
    client, recorder = app_with(device, stt, max_seconds=0.01)  # 160 samples = 320 bytes

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        stream = begin(ws, device)
        for _ in range(20):
            stream.push(PCM * 4)  # 64 bytes each, 1,280 offered
        send(ws, stop())
        receive(ws)

    assert len(wav_pcm(stt.calls[0][0])) <= recorder.max_bytes == 320


# --- privacy -----------------------------------------------------------------------------------------------------------------


def test_no_audio_or_transcript_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    device = FakeInput()
    client, _ = app_with(device, FakeSTT(text="SECRETWORDS spoken aloud"))

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        begin(ws, device, "rec-log").push(PCM)
        send(ws, stop("rec-log"))
        receive(ws)

    assert "rec-log" in caplog.text  # ids and sizes are logged
    assert "FAKEPCMSECRET" not in caplog.text and "SECRETWORDS" not in caplog.text


def test_a_full_recording_leaves_no_file_behind(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TMP", str(tmp_path))
    monkeypatch.setenv("TEMP", str(tmp_path))
    device = FakeInput()
    client, _ = app_with(device)

    with client.websocket_connect("/ws") as ws:
        handshake(ws)
        begin(ws, device, "a").push(PCM)
        send(ws, stop("a"))
        receive(ws)
        begin(ws, device, "b").push(PCM)
        send(ws, cancel("b"))
        typed_round_trip_works(ws)

    assert list(tmp_path.iterdir()) == []


async def test_a_microphone_opened_for_a_cancelled_connection_is_closed_not_leaked() -> None:
    """If the connection task is cancelled while the device is still opening, nobody owns the stream."""
    import asyncio
    import threading

    from app.main import Connection

    gate = threading.Event()
    device = FakeInput()
    recorder = LocalRecorder(device)
    real_start = recorder.start

    def slow_start() -> Any:
        assert gate.wait(5)
        return real_start()

    recorder.start = slow_start  # type: ignore[method-assign]
    opening = asyncio.ensure_future(Connection._open_microphone(recorder))  # noqa: SLF001
    await asyncio.sleep(0)
    opening.cancel()
    with pytest.raises(asyncio.CancelledError):
        await opening

    gate.set()
    for _ in range(200):
        if device.streams and device.streams[0].closed:
            break
        await asyncio.sleep(0.01)

    assert len(device.streams) == 1 and device.streams[0].close_calls == 1
    assert recorder.is_recording is False
