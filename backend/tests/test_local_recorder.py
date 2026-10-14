"""Task 8.5: the backend-local recorder, with a fake microphone.

No real audio device is ever opened. ``FakeInput`` stands in for the hardware, and the
``sounddevice`` adapter is exercised against a fake module handed to it by a loader function.
"""

from __future__ import annotations

import io
import re
import sys
import threading
import wave
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.speech import local_recorder
from app.speech.local_recorder import (
    CHANNELS,
    MAX_RECORDING_SECONDS,
    MIC_DENIED_MESSAGE,
    MIC_LOST_MESSAGE,
    MIC_UNAVAILABLE_MESSAGE,
    SAMPLE_RATE,
    SAMPLE_WIDTH_BYTES,
    LocalRecorder,
    MicrophoneError,
    RecordingNotActive,
    SoundDeviceInput,
    default_audio_input,
)

from ._fake_audio import FakeInput

PCM_MARKER = b"\x7f\x01" * 8  # recognisable sample data


def wav_params(data: bytes) -> tuple[int, int, int, int, bytes]:
    with wave.open(io.BytesIO(data), "rb") as reader:
        return (
            reader.getnchannels(),
            reader.getsampwidth(),
            reader.getframerate(),
            reader.getnframes(),
            reader.readframes(reader.getnframes()),
        )


def recorder_for(device: FakeInput, **kwargs: Any) -> LocalRecorder:
    return LocalRecorder(device, **kwargs)


# --- nothing happens by itself ---------------------------------------------------------------------------


def test_building_a_recorder_and_reading_its_status_never_opens_the_microphone() -> None:
    device = FakeInput()
    recorder = recorder_for(device)

    assert recorder.status() == "available"
    assert recorder.status() == "available"

    assert device.open_calls == 0 and device.streams == []
    assert recorder.is_recording is False


def test_the_default_input_is_created_without_touching_hardware_or_importing_the_library(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delitem(sys.modules, "sounddevice", raising=False)

    device = default_audio_input()

    assert isinstance(device, SoundDeviceInput)
    assert "sounddevice" not in sys.modules  # only imported when the microphone is first needed


# --- a normal recording -------------------------------------------------------------------------------------


def test_a_recording_is_returned_as_a_valid_wav_of_exactly_what_was_captured() -> None:
    device = FakeInput()
    recorder = recorder_for(device)

    session = recorder.start()
    assert recorder.is_recording and session.is_active
    device.streams[0].push(PCM_MARKER)
    device.streams[0].push(PCM_MARKER)
    recording = session.stop()

    channels, width, rate, frames, pcm = wav_params(recording.wav)
    assert (channels, width, rate) == (CHANNELS, SAMPLE_WIDTH_BYTES, SAMPLE_RATE) == (1, 2, 16_000)
    assert pcm == PCM_MARKER * 2 and frames == len(PCM_MARKER)
    assert recording.pcm_bytes == len(PCM_MARKER) * 2 and recording.truncated is False
    assert recording.seconds == pytest.approx(frames / SAMPLE_RATE)


def test_stop_closes_the_microphone_and_frees_the_recorder() -> None:
    device = FakeInput()
    recorder = recorder_for(device)
    session = recorder.start()

    session.stop()

    assert device.streams[0].close_calls == 1 and device.open_streams == []
    assert recorder.is_recording is False and session.is_active is False
    recorder.start().cancel()  # a new recording can begin


def test_the_clip_object_does_not_print_its_audio() -> None:
    device = FakeInput()
    session = recorder_for(device).start()
    device.streams[0].push(b"\x01\x02" * 100)

    assert "\\x01\\x02" not in repr(session.stop())


def test_an_empty_recording_reports_zero_audio() -> None:
    session = recorder_for(FakeInput()).start()

    recording = session.stop()

    assert recording.pcm_bytes == 0 and recording.seconds == 0.0


# --- double start, repeated stop, cancel ---------------------------------------------------------------------


def test_a_second_start_is_refused_and_leaves_the_first_recording_intact() -> None:
    device = FakeInput()
    recorder = recorder_for(device)
    first = recorder.start()
    device.streams[0].push(PCM_MARKER)

    with pytest.raises(MicrophoneError) as refused:
        recorder.start()

    assert refused.value.code == "MIC_UNAVAILABLE" and "already" in refused.value.message
    assert device.open_calls == 1 and len(device.streams) == 1  # nothing else was opened
    assert first.stop().pcm_bytes == len(PCM_MARKER)


def test_a_repeated_stop_is_refused_and_does_not_close_twice() -> None:
    device = FakeInput()
    session = recorder_for(device).start()
    session.stop()

    with pytest.raises(RecordingNotActive):
        session.stop()

    assert device.streams[0].close_calls == 1


def test_cancel_discards_the_audio_and_releases_the_microphone() -> None:
    device = FakeInput()
    recorder = recorder_for(device)
    session = recorder.start()
    device.streams[0].push(PCM_MARKER)

    session.cancel()

    assert device.streams[0].close_calls == 1 and recorder.is_recording is False
    assert session.byte_count == 0 and session.is_active is False
    with pytest.raises(RecordingNotActive):
        session.stop()  # the audio is gone; it cannot be collected afterwards


def test_cancel_is_safe_to_repeat_and_after_stop() -> None:
    device = FakeInput()
    session = recorder_for(device).start()
    session.cancel()
    session.cancel()
    other = recorder_for(FakeInput()).start()
    other.stop()
    other.cancel()

    assert device.streams[0].close_calls == 1


def test_audio_arriving_after_the_recording_ended_is_dropped() -> None:
    device = FakeInput()
    session = recorder_for(device).start()
    stream = device.streams[0]
    stream.push(PCM_MARKER)
    session.stop()

    stream.push(PCM_MARKER)  # a late callback from the audio thread

    assert session.byte_count == 0


# --- permission and device failures; the microphone is re-checked on every start -----------------------------


@pytest.mark.parametrize(
    ("status", "code", "message"),
    [("denied", "MIC_DENIED", MIC_DENIED_MESSAGE), ("unavailable", "MIC_UNAVAILABLE", MIC_UNAVAILABLE_MESSAGE)],
)
def test_an_unusable_microphone_is_refused_without_opening_anything(status: str, code: str, message: str) -> None:
    device = FakeInput(status=status)  # type: ignore[arg-type]
    recorder = recorder_for(device)

    with pytest.raises(MicrophoneError) as refused:
        recorder.start()

    assert (refused.value.code, refused.value.message) == (code, message)
    assert device.open_calls == 0 and recorder.is_recording is False


@pytest.mark.parametrize(
    "error",
    [MicrophoneError("MIC_DENIED", MIC_DENIED_MESSAGE), MicrophoneError("MIC_UNAVAILABLE", MIC_UNAVAILABLE_MESSAGE)],
)
def test_a_device_that_fails_to_open_is_reported_and_leaves_nothing_active(error: MicrophoneError) -> None:
    device = FakeInput(open_error=error)
    recorder = recorder_for(device)

    with pytest.raises(MicrophoneError) as refused:
        recorder.start()

    assert refused.value.code == error.code
    assert recorder.is_recording is False
    device.open_error = None
    recorder.start().cancel()  # recovers without restarting anything


def test_an_unexpected_device_exception_is_unavailable_and_leaks_no_detail() -> None:
    class Exploding(FakeInput):
        def open(self, on_block: Any, on_lost: Any) -> Any:
            raise RuntimeError("secret device name: Contoso Mic 9000")

    recorder = recorder_for(Exploding())

    with pytest.raises(MicrophoneError) as refused:
        recorder.start()

    assert refused.value.code == "MIC_UNAVAILABLE" and "Contoso" not in refused.value.message
    assert recorder.is_recording is False


def test_a_broken_status_probe_means_unavailable_not_a_crash() -> None:
    class BrokenProbe(FakeInput):
        def status(self) -> Any:
            raise OSError("probe failed")

    recorder = recorder_for(BrokenProbe())

    assert recorder.status() == "unavailable"
    with pytest.raises(MicrophoneError):
        recorder.start()


def test_the_microphone_is_checked_again_on_every_start() -> None:
    device = FakeInput(status="denied")
    recorder = recorder_for(device)
    with pytest.raises(MicrophoneError):
        recorder.start()

    device.current_status = "unavailable"
    with pytest.raises(MicrophoneError) as second:
        recorder.start()
    assert second.value.code == "MIC_UNAVAILABLE"

    device.current_status = "available"  # access granted / device plugged in later
    session = recorder.start()
    session.stop()

    assert device.status_calls == 3


def test_a_device_that_stops_by_itself_fails_the_recording_and_still_releases_it() -> None:
    device = FakeInput()
    recorder = recorder_for(device)
    session = recorder.start()
    device.streams[0].push(PCM_MARKER)
    device.streams[0].lose()

    with pytest.raises(MicrophoneError) as lost:
        session.stop()

    assert (lost.value.code, lost.value.message) == ("MIC_UNAVAILABLE", MIC_LOST_MESSAGE)
    assert device.streams[0].close_calls == 1 and recorder.is_recording is False
    assert session.byte_count == 0
    recorder.start().cancel()  # and a later recording works


def test_a_lost_device_can_still_be_cancelled() -> None:
    device = FakeInput()
    session = recorder_for(device).start()
    device.streams[0].lose()

    session.cancel()

    assert device.streams[0].close_calls == 1


def test_a_device_that_refuses_to_close_still_frees_the_recorder() -> None:
    device = FakeInput()
    device.close_error = True
    recorder = recorder_for(device)
    session = recorder.start()

    session.stop()  # must not raise

    assert recorder.is_recording is False and device.streams[0].close_calls == 1


# --- limits ---------------------------------------------------------------------------------------------------


def test_the_default_cap_is_sixty_seconds_of_sixteen_kilohertz_mono_audio() -> None:
    recorder = recorder_for(FakeInput())

    assert MAX_RECORDING_SECONDS == recorder.max_seconds == 60.0
    assert recorder.max_bytes == 60 * 16_000 * 2 == 1_920_000


def test_audio_past_the_cap_is_dropped_and_the_buffer_never_exceeds_it() -> None:
    device = FakeInput()
    recorder = recorder_for(device, max_seconds=0.01)  # 160 samples = 320 bytes
    session = recorder.start()
    stream = device.streams[0]

    for _ in range(10):
        stream.push(b"\x01\x02" * 100)  # 200 bytes each: 2,000 offered, 320 allowed

    assert session.byte_count == recorder.max_bytes == 320 and session.truncated is True
    recording = session.stop()
    assert recording.pcm_bytes == 320 and recording.truncated is True
    assert wav_params(recording.wav)[3] == 160


def test_a_recording_exactly_at_the_cap_is_not_marked_truncated() -> None:
    device = FakeInput()
    recorder = recorder_for(device, max_seconds=0.01)
    session = recorder.start()

    device.streams[0].push(b"\x01\x02" * 160)

    assert session.byte_count == 320 and session.truncated is False


def test_only_whole_samples_are_kept() -> None:
    device = FakeInput()
    session = recorder_for(device).start()

    device.streams[0].push(b"\x01\x02\x03")  # an odd byte count: the half sample is dropped

    assert session.byte_count == 2


# --- no persistence ------------------------------------------------------------------------------------------


def test_a_full_recording_writes_no_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TMP", str(tmp_path))
    monkeypatch.setenv("TEMP", str(tmp_path))
    device = FakeInput()
    session = recorder_for(device).start()
    device.streams[0].push(PCM_MARKER * 100)
    session.stop()
    cancelled = recorder_for(device).start()
    cancelled.cancel()

    assert list(tmp_path.iterdir()) == []


def test_the_recorder_source_has_no_file_or_network_or_credential_access() -> None:
    source = Path(local_recorder.__file__).read_text(encoding="utf-8")
    code = re.sub(r'"""[\s\S]*?"""', "", source)  # the docstring explains the rules in words

    assert not re.search(r"""\bopen\(\s*["']|tempfile|write_bytes|write_text|tofile|Path\(""", code)
    assert not re.search(r"httpx|requests|urllib|socket|environ|getenv|api[_-]?key|logging|print\(", code, re.I)


# --- properties --------------------------------------------------------------------------------------------------


@settings(max_examples=250, deadline=None)
@given(
    # A device delivers whole 16-bit samples, so every block has an even length. (Odd blocks are a
    # malformed-input case with their own test: the stray byte is dropped.)
    st.lists(st.binary(max_size=64).map(lambda raw: raw[: len(raw) // 2 * 2]), max_size=30),
    st.integers(min_value=0, max_value=400).map(lambda samples: samples / SAMPLE_RATE),
)
def test_property_the_clip_is_a_whole_sample_prefix_of_the_input_and_never_exceeds_the_cap(
    blocks: list[bytes], max_seconds: float
) -> None:
    device = FakeInput()
    recorder = recorder_for(device, max_seconds=max_seconds)
    session = recorder.start()
    for block in blocks:
        device.streams[0].push(block)
        assert session.byte_count <= recorder.max_bytes  # bounded at every moment

    recording = session.stop()

    offered = b"".join(blocks)
    _, _, _, frames, pcm = wav_params(recording.wav)
    assert len(pcm) == recording.pcm_bytes == frames * SAMPLE_WIDTH_BYTES
    assert recording.pcm_bytes <= recorder.max_bytes
    assert recording.pcm_bytes % SAMPLE_WIDTH_BYTES == 0
    assert pcm == offered[: len(pcm)]  # nothing reordered, altered or invented
    if len(offered) > recorder.max_bytes:
        assert recording.truncated is True
    assert device.streams[0].close_calls == 1 and recorder.is_recording is False


@settings(max_examples=150, deadline=None)
@given(st.lists(st.sampled_from(["start", "stop", "cancel", "push", "lose", "status_flip"]), max_size=40))
def test_property_the_microphone_is_never_left_open_when_no_recording_is_active(actions: list[str]) -> None:
    """Whatever sequence of operations happens, an open stream means exactly one live recording."""
    device = FakeInput()
    recorder = recorder_for(device, max_seconds=0.01)
    session = None
    for action in actions:
        try:
            if action == "start":
                session = recorder.start()
            elif action == "stop" and session is not None:
                session.stop()
            elif action == "cancel" and session is not None:
                session.cancel()
            elif action == "push" and device.open_streams:
                device.open_streams[0].push(b"\x01\x02" * 50)
            elif action == "lose" and device.open_streams:
                device.open_streams[0].lose()
            elif action == "status_flip":
                device.current_status = "available" if device.current_status != "available" else "unavailable"
        except (MicrophoneError, RecordingNotActive):
            pass
        assert len(device.open_streams) <= 1
        assert (len(device.open_streams) == 1) == recorder.is_recording
        assert all(stream.close_calls <= 1 for stream in device.streams)  # never closed twice


# --- the sounddevice adapter, against a fake module ----------------------------------------------------------------


class FakePortAudioError(Exception):
    pass


class FakeRawInputStream:
    """Mimics the parts of ``sounddevice.RawInputStream`` the adapter uses."""

    created: list[FakeRawInputStream] = []
    start_error: Exception | None = None

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.started = False
        self.aborted = 0
        self.closed = 0
        FakeRawInputStream.created.append(self)

    def start(self) -> None:
        if FakeRawInputStream.start_error is not None:
            raise FakeRawInputStream.start_error
        self.started = True

    def abort(self) -> None:
        self.aborted += 1

    def close(self) -> None:
        self.closed += 1


def fake_sounddevice(**overrides: Any) -> SimpleNamespace:
    module = SimpleNamespace(
        PortAudioError=FakePortAudioError,
        query_devices=lambda kind=None: {"name": "Secret Mic"},
        check_input_settings=lambda **kwargs: None,
        RawInputStream=FakeRawInputStream,
    )
    for name, value in overrides.items():
        setattr(module, name, value)
    return module


@pytest.fixture(autouse=True)
def _reset_fake_stream() -> None:
    FakeRawInputStream.created = []
    FakeRawInputStream.start_error = None


def raising(error: Exception) -> Any:
    def raiser(*args: Any, **kwargs: Any) -> None:
        raise error

    return raiser


def test_the_adapter_reports_available_when_the_default_device_supports_our_format() -> None:
    calls: list[Any] = []
    module = fake_sounddevice(check_input_settings=lambda **kwargs: calls.append(kwargs))

    assert SoundDeviceInput(lambda: module).status() == "available"
    assert calls == [{"channels": 1, "dtype": "int16", "samplerate": 16_000}]
    assert FakeRawInputStream.created == []  # asking never opens a stream


def test_the_adapter_reports_unavailable_when_the_library_cannot_be_loaded() -> None:
    def missing() -> Any:
        raise OSError("PortAudio library not found")

    assert SoundDeviceInput(missing).status() == "unavailable"
    with pytest.raises(MicrophoneError) as refused:
        SoundDeviceInput(missing).open(lambda block: None, lambda: None)
    assert refused.value.code == "MIC_UNAVAILABLE"


def test_the_adapter_reports_unavailable_when_there_is_no_input_device() -> None:
    module = fake_sounddevice(query_devices=raising(FakePortAudioError("Error querying device -1")))

    assert SoundDeviceInput(lambda: module).status() == "unavailable"


def test_the_adapter_reports_unavailable_when_the_format_is_unsupported() -> None:
    module = fake_sounddevice(check_input_settings=raising(FakePortAudioError("Invalid sample rate")))

    assert SoundDeviceInput(lambda: module).status() == "unavailable"


@pytest.mark.parametrize(
    "text",
    ["Unanticipated host error [PaErrorCode -9999]: 'Access is denied.' [MME error 5]", "E_ACCESSDENIED", "Permission denied"],
)
def test_the_adapter_recognises_a_blocked_microphone_as_denied(text: str) -> None:
    status_module = fake_sounddevice(check_input_settings=raising(FakePortAudioError(text)))
    assert SoundDeviceInput(lambda: status_module).status() == "denied"

    FakeRawInputStream.start_error = FakePortAudioError(text)
    with pytest.raises(MicrophoneError) as refused:
        SoundDeviceInput(lambda: fake_sounddevice()).open(lambda block: None, lambda: None)
    assert refused.value.code == "MIC_DENIED" and refused.value.message == MIC_DENIED_MESSAGE
    assert text not in refused.value.message
    assert FakeRawInputStream.created[0].closed == 1  # a stream that failed to start is released


def test_a_device_open_failure_that_is_not_about_permission_is_unavailable_and_hides_the_device_text() -> None:
    FakeRawInputStream.start_error = FakePortAudioError("Device 'Secret Mic' unavailable")

    with pytest.raises(MicrophoneError) as refused:
        SoundDeviceInput(lambda: fake_sounddevice()).open(lambda block: None, lambda: None)

    assert refused.value.code == "MIC_UNAVAILABLE" and "Secret" not in refused.value.message


def test_the_adapter_opens_a_16khz_mono_int16_stream_and_passes_copies_of_each_block() -> None:
    blocks: list[bytes] = []
    stream = SoundDeviceInput(lambda: fake_sounddevice()).open(blocks.append, lambda: None)

    raw = FakeRawInputStream.created[0]
    assert raw.started is True
    assert (raw.kwargs["samplerate"], raw.kwargs["channels"], raw.kwargs["dtype"]) == (16_000, 1, "int16")
    buffer = bytearray(b"\x01\x02\x03\x04")
    raw.kwargs["callback"](buffer, 2, None, None)
    buffer[:] = b"\x00\x00\x00\x00"  # PortAudio reuses its buffer
    assert blocks == [b"\x01\x02\x03\x04"]
    stream.close()


def test_closing_the_adapter_stream_releases_the_device_once_and_is_not_a_device_loss() -> None:
    lost: list[bool] = []
    stream = SoundDeviceInput(lambda: fake_sounddevice()).open(lambda block: None, lambda: lost.append(True))
    raw = FakeRawInputStream.created[0]

    stream.close()
    raw.kwargs["finished_callback"]()  # PortAudio reports the stop we asked for
    stream.close()

    assert (raw.aborted, raw.closed) == (1, 1) and lost == []


def test_a_stream_that_ends_by_itself_is_reported_as_a_device_loss() -> None:
    lost: list[bool] = []
    SoundDeviceInput(lambda: fake_sounddevice()).open(lambda block: None, lambda: lost.append(True))

    FakeRawInputStream.created[0].kwargs["finished_callback"]()

    assert lost == [True]


def test_an_adapter_block_handler_that_raises_does_not_reach_the_audio_thread() -> None:
    def broken(block: bytes) -> None:
        raise RuntimeError("handler bug")

    SoundDeviceInput(lambda: fake_sounddevice()).open(broken, lambda: None)

    FakeRawInputStream.created[0].kwargs["callback"](b"\x00\x00", 1, None, None)  # must not raise


def test_the_recorder_works_end_to_end_over_the_adapter_and_closes_the_device() -> None:
    recorder = LocalRecorder(SoundDeviceInput(lambda: fake_sounddevice()))
    session = recorder.start()
    FakeRawInputStream.created[0].kwargs["callback"](b"\x05\x06" * 10, 10, None, None)

    recording = session.stop()

    assert wav_params(recording.wav)[4] == b"\x05\x06" * 10
    assert FakeRawInputStream.created[0].closed == 1


def test_the_adapter_loads_the_library_once_and_only_when_needed() -> None:
    loads: list[int] = []

    def loader() -> Any:
        loads.append(1)
        return fake_sounddevice()

    device = SoundDeviceInput(loader)
    assert loads == []
    device.status()
    device.status()
    device.open(lambda block: None, lambda: None).close()
    assert loads == [1]


def test_the_status_probe_is_safe_to_call_from_other_threads() -> None:
    device = SoundDeviceInput(lambda: fake_sounddevice())
    results: list[str] = []
    threads = [threading.Thread(target=lambda: results.append(device.status())) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert results == ["available"] * 8
