"""A fake microphone for tests. No test may touch real audio hardware."""

from __future__ import annotations

import threading
from collections.abc import Callable

from app.speech.local_recorder import MicrophoneError, MicStatus


class FakeStream:
    def __init__(self, device: FakeInput, on_block: Callable[[bytes], None], on_lost: Callable[[], None]) -> None:
        self.device = device
        self.on_block = on_block
        self.on_lost = on_lost
        self.close_calls = 0

    def close(self) -> None:
        self.close_calls += 1
        if self.device.close_error:
            raise RuntimeError("device refused to close")

    @property
    def closed(self) -> bool:
        return self.close_calls > 0

    def push(self, data: bytes) -> None:
        """Deliver a block as the audio thread would."""
        self.on_block(data)

    def lose(self) -> None:
        """The device stops by itself (unplugged, disabled)."""
        self.on_lost()


class FakeInput:
    """Records every call so tests can prove what did and did not happen."""

    def __init__(self, status: MicStatus = "available", open_error: MicrophoneError | None = None) -> None:
        self.current_status: MicStatus = status
        self.open_error = open_error
        self.close_error = False
        self.status_calls = 0
        self.open_calls = 0
        self.streams: list[FakeStream] = []
        self.opened = threading.Event()

    def status(self) -> MicStatus:
        self.status_calls += 1
        return self.current_status

    def open(self, on_block: Callable[[bytes], None], on_lost: Callable[[], None]) -> FakeStream:
        self.open_calls += 1
        if self.open_error is not None:
            raise self.open_error
        stream = FakeStream(self, on_block, on_lost)
        self.streams.append(stream)
        self.opened.set()
        return stream

    @property
    def open_streams(self) -> list[FakeStream]:
        return [stream for stream in self.streams if not stream.closed]
