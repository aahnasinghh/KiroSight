"""Assembles ``audio_clip`` frames into complete recordings for speech-to-text (Task 8.4).

One :class:`RecordingAssembler` belongs to one WebSocket connection. It accepts the two shapes the
protocol allows and hands back a recording only when it is complete:

* a whole clip: a frame with neither ``seq`` nor ``final``;
* a chunked recording: ordered frames sharing ``id``, ``seq`` 0, 1, 2 ... and ``final: true`` on the
  last. An incomplete recording is never returned, so it can never be transcribed.

It fails closed. Any irregularity (wrong mime type, bad base64, a repeated, skipped or out-of-order
frame, a changed mime type, too much audio) discards the whole recording, because a damaged
recording must not be transcribed. The first failure of a recording is reported to the caller; any
further frames of that id are then ignored silently, so one bad recording produces one error.

State is bounded: at most ``MAX_PARTIAL_RECORDINGS`` partial recordings, ``MAX_RECORDING_BYTES`` and
``MAX_FRAMES`` each, a partial recording older than ``MAX_RECORDING_AGE_SECONDS`` is dropped, and
only the last ``TERMINAL_MEMORY`` finished ids are remembered. Everything is released on completion,
failure, cancellation and ``clear()`` (disconnect).

Audio is held only in memory and is never logged or placed in an error. This module never executes
anything and never reads the audio's content.
"""

from __future__ import annotations

import base64
import binascii
import re
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Final

from app.protocol.messages import AudioClip, ErrorCode

__all__ = [
    "MAX_FRAMES",
    "MAX_FRAME_BASE64_CHARS",
    "MAX_ID_CHARS",
    "MAX_PARTIAL_RECORDINGS",
    "MAX_RECORDING_AGE_SECONDS",
    "MAX_RECORDING_BYTES",
    "TERMINAL_MEMORY",
    "AudioRejected",
    "CompletedRecording",
    "RecordingAssembler",
]

#: Matches the extension's relay: a recording holds at most 4 MiB of audio and 2,000 frames.
MAX_RECORDING_BYTES: Final = 4 * 1024 * 1024
MAX_FRAMES: Final = 2_000
#: A frame travels in one WebSocket message, which the server already caps at 2 MiB.
MAX_FRAME_BASE64_CHARS: Final = 2_000_000
MAX_ID_CHARS: Final = 128
MAX_MIME_CHARS: Final = 100
#: One capture is live at a time; a few more allow for a superseded one whose cancel is in flight.
MAX_PARTIAL_RECORDINGS: Final = 4
#: A capture ends at 60 s. Allow for relay and network delay; a partial recording older than this is stale.
MAX_RECORDING_AGE_SECONDS: Final = 75.0
TERMINAL_MEMORY: Final = 64

_AUDIO_MIME = re.compile(r"^audio/[A-Za-z0-9.+-]+(?:;\s*[A-Za-z0-9=.+\-\" ,]+)*$")
_BASE64 = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")

_COMPLETED: Final = "completed"
_FAILED: Final = "failed"
_CANCELLED: Final = "cancelled"
_EXPIRED: Final = "expired"


class AudioRejected(Exception):
    """A frame was refused. ``message`` is fixed and safe; ``silent`` means it was already reported."""

    def __init__(self, message: str, *, code: ErrorCode = "VALIDATION_FAILED", silent: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.code: ErrorCode = code
        self.silent = silent


@dataclass(frozen=True)
class CompletedRecording:
    """A whole recording, ready for speech-to-text."""

    id: str
    mime_type: str
    audio: bytes = field(repr=False)  # never printed


@dataclass
class _Partial:
    mime_type: str
    started: float
    expected_seq: int = 0
    total_bytes: int = 0
    parts: list[bytes] = field(default_factory=list)


class RecordingAssembler:
    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._partials: dict[str, _Partial] = {}
        self._terminal: OrderedDict[str, str] = OrderedDict()

    # --- introspection (tests and logging use sizes only) ---

    @property
    def partial_count(self) -> int:
        return len(self._partials)

    @property
    def retained_bytes(self) -> int:
        return sum(partial.total_bytes for partial in self._partials.values())

    # --- state transitions ---

    def _remember(self, recording_id: str, state: str) -> None:
        self._terminal[recording_id] = state
        self._terminal.move_to_end(recording_id)
        while len(self._terminal) > TERMINAL_MEMORY:
            self._terminal.popitem(last=False)

    def _fail(self, recording_id: str, message: str, *, code: ErrorCode = "VALIDATION_FAILED") -> AudioRejected:
        """Discard everything held for ``recording_id`` and remember it as reported."""
        self._partials.pop(recording_id, None)
        self._remember(recording_id, _FAILED)
        return AudioRejected(message, code=code)

    def _drop_stale(self) -> None:
        now = self._clock()
        for recording_id in [
            key for key, partial in self._partials.items() if now - partial.started > MAX_RECORDING_AGE_SECONDS
        ]:
            del self._partials[recording_id]
            self._remember(recording_id, _EXPIRED)

    def mark_failed(self, recording_id: str) -> None:
        """Note that an error was already reported for ``recording_id`` so its later frames are ignored."""
        self._partials.pop(recording_id, None)
        self._remember(recording_id, _FAILED)

    def cancel(self, recording_id: str) -> bool:
        """Discard a partial recording. Returns True if one was held. Later frames are ignored."""
        existed = self._partials.pop(recording_id, None) is not None
        if existed:
            self._remember(recording_id, _CANCELLED)
        return existed

    def clear(self) -> None:
        """Release everything (disconnect)."""
        self._partials.clear()
        self._terminal.clear()

    # --- the one entry point ---

    def accept(self, clip: AudioClip) -> CompletedRecording | None:
        """Take one frame. Returns the recording when this frame completes it, else ``None``.

        Raises :class:`AudioRejected` for any invalid frame, after discarding the recording.
        """
        self._drop_stale()
        recording_id = clip.id

        if recording_id == "" or len(recording_id) > MAX_ID_CHARS:
            raise AudioRejected("The recording id was not valid.")

        known = self._terminal.get(recording_id)
        if known == _COMPLETED:
            raise AudioRejected("That recording was already received.")
        if known == _EXPIRED:
            self._remember(recording_id, _FAILED)
            raise AudioRejected("The recording took too long and was discarded.")
        if known is not None:  # failed or cancelled: already reported, ignore the rest silently
            raise AudioRejected("Ignored.", silent=True)

        whole = clip.seq is None
        seq = 0 if clip.seq is None else clip.seq
        final = True if clip.final is None else clip.final
        partial = self._partials.get(recording_id)

        if len(clip.mimeType) > MAX_MIME_CHARS or _AUDIO_MIME.fullmatch(clip.mimeType) is None:
            raise self._fail(recording_id, "Only audio recordings are supported.")

        if partial is None:
            if seq != 0:
                raise self._fail(recording_id, "Audio arrived out of order and the recording was discarded.")
            if len(self._partials) >= MAX_PARTIAL_RECORDINGS:
                raise self._fail(recording_id, "Too many recordings are in progress.")
            partial = _Partial(mime_type=clip.mimeType, started=self._clock())
            self._partials[recording_id] = partial
        else:
            if whole:
                raise self._fail(recording_id, "That recording id is already in progress.")
            if seq != partial.expected_seq:
                raise self._fail(recording_id, "Audio arrived out of order and the recording was discarded.")
            if clip.mimeType != partial.mime_type:
                raise self._fail(recording_id, "The audio format changed during the recording.")

        if partial.expected_seq >= MAX_FRAMES:
            raise self._fail(recording_id, "The recording has too many parts.")

        if len(clip.base64) > MAX_FRAME_BASE64_CHARS:
            raise self._fail(recording_id, "The recording is too large.")
        if len(clip.base64) % 4 != 0 or _BASE64.fullmatch(clip.base64) is None:
            raise self._fail(recording_id, "The audio was not valid.")
        try:
            data = base64.b64decode(clip.base64, validate=True)
        except (binascii.Error, ValueError):
            raise self._fail(recording_id, "The audio was not valid.") from None

        if partial.total_bytes + len(data) > MAX_RECORDING_BYTES:
            raise self._fail(recording_id, "The recording is too large.")

        if len(data) > 0:
            partial.parts.append(data)
            partial.total_bytes += len(data)
        partial.expected_seq += 1

        if not final:
            return None

        del self._partials[recording_id]
        self._remember(recording_id, _COMPLETED)
        if partial.total_bytes == 0:
            raise AudioRejected("No audio was received.", code="STT_NO_SPEECH")
        return CompletedRecording(id=recording_id, mime_type=partial.mime_type, audio=b"".join(partial.parts))
