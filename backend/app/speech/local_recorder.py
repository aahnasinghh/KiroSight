"""Backend-local microphone recorder (Task 8.5; Requirements 19.6, 19.8).

Used only when the extension selects ``BackendLocalVoiceInput`` (design D11): the backend, not the
webview, records from the machine's default microphone. This module records and nothing else. It
holds no credential, makes no network call and does not know about speech-to-text: the WebSocket
layer takes the finished clip and hands it to the STT client.

Privacy and safety rules, enforced here and tested with a fake device:

* **Nothing records by itself.** Creating a recorder, asking for its status, and the WebSocket
  handshake never open the microphone. Only :meth:`LocalRecorder.start` does, and the WebSocket
  layer calls it only for a ``record_start`` message the user caused.
* **The microphone is re-checked on every start**, so a later fix (a plugged-in or re-enabled
  device, granted OS access) works without restarting anything.
* **Bounded.** At most ``MAX_RECORDING_SECONDS`` (60 s) of 16 kHz mono 16-bit audio, which is
  1,920,000 bytes. Audio beyond the cap is dropped; the buffer never grows past it. One recording
  at a time.
* **Released reliably.** The device stream is closed on stop, cancel, device loss and failure, and
  a recording that has ended can never take more audio.
* **In memory only.** The clip is a WAV built in a ``BytesIO``. Nothing is written to disk, logged
  or put in an error. Error messages are fixed sentences; the device's own error text (which can
  name hardware) is used only to choose between "denied" and "unavailable", then dropped.

The device is behind the small :class:`AudioInput` interface so tests use a fake and never touch
real hardware. :class:`SoundDeviceInput` is the real one, built on ``sounddevice`` (PortAudio),
imported only when the microphone is first needed.
"""

from __future__ import annotations

import importlib
import io
import threading
import wave
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Final, Literal, Protocol

__all__ = [
    "CHANNELS",
    "MAX_RECORDING_SECONDS",
    "MIC_BUSY_MESSAGE",
    "MIC_DENIED_MESSAGE",
    "MIC_LOST_MESSAGE",
    "MIC_UNAVAILABLE_MESSAGE",
    "SAMPLE_RATE",
    "SAMPLE_WIDTH_BYTES",
    "WAV_MIME_TYPE",
    "AudioInput",
    "AudioStream",
    "LocalRecorder",
    "MicStatus",
    "MicrophoneError",
    "Recording",
    "RecordingNotActive",
    "RecordingSession",
    "SoundDeviceInput",
    "default_audio_input",
]

#: Audio format delivered by every :class:`AudioInput`: signed 16-bit little-endian PCM, mono, 16 kHz.
SAMPLE_RATE: Final = 16_000
CHANNELS: Final = 1
SAMPLE_WIDTH_BYTES: Final = 2
WAV_MIME_TYPE: Final = "audio/wav"

#: Requirement 9.1 / design: a capture ends at 60 seconds.
MAX_RECORDING_SECONDS: Final = 60.0

MicStatus = Literal["available", "unavailable", "denied"]
MicErrorCode = Literal["MIC_UNAVAILABLE", "MIC_DENIED"]

MIC_UNAVAILABLE_MESSAGE: Final = "No microphone is available. Check that a microphone is connected and enabled."
MIC_DENIED_MESSAGE: Final = (
    "Microphone access was denied. Allow microphone access for desktop apps in your system privacy "
    "settings, then try again."
)
MIC_BUSY_MESSAGE: Final = "The microphone is already being used by another KiroSight recording."
MIC_LOST_MESSAGE: Final = "The microphone stopped working during the recording."


class MicrophoneError(Exception):
    """The microphone cannot be used. ``message`` is a fixed, safe sentence for the user."""

    def __init__(self, code: MicErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: MicErrorCode = code
        self.message = message


class RecordingNotActive(Exception):
    """``stop`` was called on a recording that has already ended."""


class AudioStream(Protocol):
    """An open capture stream. ``close`` must release the device and be safe to call twice."""

    def close(self) -> None: ...


class AudioInput(Protocol):
    """The microphone seam. Delivers 16 kHz mono signed 16-bit PCM blocks (see ``SAMPLE_RATE``)."""

    def status(self) -> MicStatus:
        """Whether a default input device looks usable. Must not capture audio or open a stream."""
        ...

    def open(self, on_block: Callable[[bytes], None], on_lost: Callable[[], None]) -> AudioStream:
        """Start capturing. ``on_block`` gets each block; ``on_lost`` is called if the device
        stops by itself. Raises :class:`MicrophoneError` if it cannot start."""
        ...


@dataclass(frozen=True)
class Recording:
    """A finished clip. ``pcm_bytes`` is the audio length (0 means nothing was captured)."""

    wav: bytes = field(repr=False)  # never printed
    pcm_bytes: int
    seconds: float
    truncated: bool


def _to_wav(pcm: bytes) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as writer:
        writer.setnchannels(CHANNELS)
        writer.setsampwidth(SAMPLE_WIDTH_BYTES)
        writer.setframerate(SAMPLE_RATE)
        writer.writeframes(pcm)
    return out.getvalue()


def _close_quietly(stream: AudioStream | None) -> None:
    if stream is None:
        return
    try:
        stream.close()
    except Exception:  # noqa: BLE001 - releasing the device must never raise
        pass


class RecordingSession:
    """One live recording. Created by :meth:`LocalRecorder.start`; ended by ``stop`` or ``cancel``."""

    def __init__(self, recorder: LocalRecorder, max_bytes: int) -> None:
        self._recorder = recorder
        self._max_bytes = max_bytes
        self._lock = threading.Lock()
        self._buffer = bytearray()
        self._state: Literal["recording", "lost", "stopped", "cancelled"] = "recording"
        self._stream: AudioStream | None = None
        self._truncated = False

    # --- state, for the owner and for tests (sizes only, never audio) ---

    @property
    def is_active(self) -> bool:
        with self._lock:
            return self._state in ("recording", "lost")

    @property
    def byte_count(self) -> int:
        with self._lock:
            return len(self._buffer)

    @property
    def truncated(self) -> bool:
        with self._lock:
            return self._truncated

    # --- device callbacks (may run on the audio thread; never raise) ---

    def _attach(self, stream: AudioStream) -> None:
        with self._lock:
            self._stream = stream

    def _add(self, block: bytes) -> None:
        try:
            with self._lock:
                if self._state != "recording":
                    return  # a recording that has ended takes no more audio
                room = self._max_bytes - len(self._buffer)
                if room <= 0:
                    self._truncated = True
                    return
                chunk = bytes(block)[:room]
                if len(chunk) < len(block):
                    self._truncated = True
                chunk = chunk[: len(chunk) - (len(chunk) % SAMPLE_WIDTH_BYTES)]  # whole samples only
                self._buffer.extend(chunk)
        except Exception:  # noqa: BLE001 - never raise into the audio thread
            pass

    def _lost(self) -> None:
        with self._lock:
            if self._state == "recording":
                self._state = "lost"

    # --- ending a recording ---

    def _end(self, final: Literal["stopped", "cancelled"]) -> tuple[bytes, bool, bool, AudioStream | None]:
        """Atomically leave the recording state. Returns (audio, lost, truncated, stream to close)."""
        with self._lock:
            if self._state not in ("recording", "lost"):
                raise RecordingNotActive
            lost = self._state == "lost"
            audio = bytes(self._buffer)
            self._buffer.clear()  # nothing stays buffered once the recording has ended
            self._state = final
            stream, self._stream = self._stream, None
            return audio, lost, self._truncated, stream

    def stop(self) -> Recording:
        """Stop, release the microphone and return the clip.

        Raises :class:`MicrophoneError` (``MIC_UNAVAILABLE``) if the device stopped by itself, and
        :class:`RecordingNotActive` if the recording already ended. The device is closed either way.
        """
        audio, lost, truncated, stream = self._end("stopped")
        _close_quietly(stream)  # outside the lock: closing may wait for the audio thread
        self._recorder._release(self)  # noqa: SLF001 - the recorder owns the single active slot
        if lost:
            raise MicrophoneError("MIC_UNAVAILABLE", MIC_LOST_MESSAGE)
        frames = len(audio) // SAMPLE_WIDTH_BYTES
        return Recording(
            wav=_to_wav(audio),
            pcm_bytes=len(audio),
            seconds=frames / SAMPLE_RATE,
            truncated=truncated,
        )

    def cancel(self) -> None:
        """Discard the audio and release the microphone. Safe to repeat and after ``stop``."""
        try:
            _audio, _lost, _truncated, stream = self._end("cancelled")
        except RecordingNotActive:
            return
        _close_quietly(stream)
        self._recorder._release(self)  # noqa: SLF001


class LocalRecorder:
    """Records one clip at a time from an :class:`AudioInput`."""

    def __init__(self, device: AudioInput, *, max_seconds: float = MAX_RECORDING_SECONDS) -> None:
        self._device = device
        self._max_seconds = max_seconds
        self._max_bytes = max(int(max_seconds * SAMPLE_RATE), 0) * SAMPLE_WIDTH_BYTES
        self._lock = threading.Lock()
        self._active: RecordingSession | None = None

    @property
    def max_seconds(self) -> float:
        return self._max_seconds

    @property
    def max_bytes(self) -> int:
        return self._max_bytes

    @property
    def is_recording(self) -> bool:
        with self._lock:
            return self._active is not None

    def status(self) -> MicStatus:
        """The default microphone's state, for ``capabilities.mic``. Opens nothing."""
        try:
            return self._device.status()
        except Exception:  # noqa: BLE001 - a broken probe means "not usable", never a crash
            return "unavailable"

    def start(self) -> RecordingSession:
        """Re-check the microphone, open it and begin recording.

        Raises :class:`MicrophoneError` (``MIC_DENIED`` or ``MIC_UNAVAILABLE``) and leaves nothing
        open if it cannot. A second start while one recording is live is refused.
        """
        with self._lock:
            if self._active is not None:
                raise MicrophoneError("MIC_UNAVAILABLE", MIC_BUSY_MESSAGE)
            status = self.status()  # every start checks again
            if status == "denied":
                raise MicrophoneError("MIC_DENIED", MIC_DENIED_MESSAGE)
            if status != "available":
                raise MicrophoneError("MIC_UNAVAILABLE", MIC_UNAVAILABLE_MESSAGE)
            session = RecordingSession(self, self._max_bytes)
            try:
                stream = self._device.open(session._add, session._lost)  # noqa: SLF001
            except MicrophoneError:
                raise
            except Exception:  # noqa: BLE001 - an unexpected device failure is "unavailable"
                raise MicrophoneError("MIC_UNAVAILABLE", MIC_UNAVAILABLE_MESSAGE) from None
            session._attach(stream)  # noqa: SLF001
            self._active = session
            return session

    def _release(self, session: RecordingSession) -> None:
        with self._lock:
            if self._active is session:
                self._active = None


# --- the real microphone ------------------------------------------------------------------------------

_DENIED_HINTS: Final = (
    "denied",
    "permission",
    "not permitted",
    "not authorized",
    "not authorised",
    "e_accessdenied",
    "0x80070005",
)
_BLOCK_FRAMES: Final = SAMPLE_RATE // 10  # 100 ms blocks


def _classify(error: BaseException) -> MicStatus:
    """Choose ``denied`` or ``unavailable`` from a device error, then drop its text.

    PortAudio reports a blocked microphone as a host error whose text mentions access being
    denied; this is a heuristic, because there is no portable "permission denied" code.
    """
    try:
        text = str(error).lower()
    except Exception:  # noqa: BLE001
        return "unavailable"
    return "denied" if any(hint in text for hint in _DENIED_HINTS) else "unavailable"


class _SoundDeviceStream:
    def __init__(self, stream: Any, closing: threading.Event) -> None:
        self._stream = stream
        self._closing = closing

    def close(self) -> None:
        self._closing.set()  # a stop that we asked for is not a device loss
        stream, self._stream = self._stream, None
        if stream is None:
            return
        try:
            stream.abort()  # discard pending audio: we are done with it
        except Exception:  # noqa: BLE001
            pass
        try:
            stream.close()
        except Exception:  # noqa: BLE001
            pass


class SoundDeviceInput:
    """The default microphone through ``sounddevice``. Imported lazily; absent library means unavailable."""

    def __init__(self, loader: Callable[[], Any] | None = None) -> None:
        self._loader = loader if loader is not None else (lambda: importlib.import_module("sounddevice"))
        self._module: Any = None

    def _sd(self) -> Any:
        if self._module is None:
            self._module = self._loader()
        return self._module

    def status(self) -> MicStatus:
        try:
            sd = self._sd()
        except Exception:  # noqa: BLE001 - library or PortAudio missing
            return "unavailable"
        try:
            sd.query_devices(kind="input")  # raises when there is no default input device
            sd.check_input_settings(channels=CHANNELS, dtype="int16", samplerate=SAMPLE_RATE)
        except Exception as error:  # noqa: BLE001
            return _classify(error)
        return "available"

    def open(self, on_block: Callable[[bytes], None], on_lost: Callable[[], None]) -> AudioStream:
        try:
            sd = self._sd()
        except Exception:  # noqa: BLE001
            raise MicrophoneError("MIC_UNAVAILABLE", MIC_UNAVAILABLE_MESSAGE) from None

        closing = threading.Event()

        def callback(indata: Any, _frames: int, _time: Any, _status: Any) -> None:
            try:
                on_block(bytes(indata))  # a copy: PortAudio reuses its buffer
            except Exception:  # noqa: BLE001 - never raise into PortAudio
                pass

        def finished() -> None:
            if not closing.is_set():
                on_lost()

        stream: Any = None
        try:
            stream = sd.RawInputStream(
                samplerate=SAMPLE_RATE,
                blocksize=_BLOCK_FRAMES,
                channels=CHANNELS,
                dtype="int16",
                callback=callback,
                finished_callback=finished,
            )
            stream.start()
        except Exception as error:  # noqa: BLE001
            _SoundDeviceStream(stream, closing).close()
            if _classify(error) == "denied":
                raise MicrophoneError("MIC_DENIED", MIC_DENIED_MESSAGE) from None
            raise MicrophoneError("MIC_UNAVAILABLE", MIC_UNAVAILABLE_MESSAGE) from None
        return _SoundDeviceStream(stream, closing)


def default_audio_input() -> AudioInput | None:
    """The microphone the backend uses by default. Creating it touches no hardware."""
    return SoundDeviceInput()
