"""Per-connection session state: bounded history, in-flight tasks, capability snapshot.

One ``Session`` exists per WebSocket connection and is never shared. It stores no IDE context,
source code, audio, credentials or raw protocol payloads: history keeps only the compact request
text and the reply text of each turn.
"""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass

from app.protocol.messages import Capabilities

__all__ = [
    "MAX_HISTORY_TURNS",
    "STUB_CAPABILITIES",
    "DuplicateRequestError",
    "Session",
    "Turn",
]

#: Design: per-connection history of the last 6 turns.
MAX_HISTORY_TURNS = 6

#: Task 6.12 capabilities. Nothing is claimed that the stub backend cannot do.
STUB_CAPABILITIES = Capabilities(bedrock=False, stt=False, tts=False, mic="not_applicable")


class DuplicateRequestError(Exception):
    """A request id is already in flight on this connection."""


@dataclass(frozen=True)
class Turn:
    """One conversational turn: what the user asked and what KiroSight replied."""

    request: str
    response: str


class Session:
    def __init__(self, capabilities: Capabilities = STUB_CAPABILITIES) -> None:
        self._capabilities = capabilities
        self._history: deque[Turn] = deque(maxlen=MAX_HISTORY_TURNS)
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self.handshake_complete = False

    # --- capabilities ---

    @property
    def capabilities(self) -> Capabilities:
        return self._capabilities

    # --- history ---

    @property
    def history(self) -> tuple[Turn, ...]:
        """A snapshot (oldest first). Mutating it cannot affect the session."""
        return tuple(self._history)

    def add_turn(self, request: str, response: str) -> None:
        self._history.append(Turn(request=request, response=response))

    # --- in-flight tasks, keyed by protocol request id ---

    @property
    def in_flight_ids(self) -> frozenset[str]:
        return frozenset(request_id for request_id, task in self._tasks.items() if not task.done())

    def is_in_flight(self, request_id: str) -> bool:
        task = self._tasks.get(request_id)
        return task is not None and not task.done()

    def register(self, request_id: str, task: asyncio.Task[None]) -> None:
        """Track ``task`` under ``request_id``. A live task is never replaced."""
        if self.is_in_flight(request_id):
            raise DuplicateRequestError(request_id)
        self._tasks[request_id] = task

    def cancel(self, request_id: str) -> bool:
        """Cancel the live task for ``request_id``. Safe to repeat or call for unknown ids."""
        task = self._tasks.get(request_id)
        if task is None or task.done():
            return False
        task.cancel()
        return True

    def remove(self, request_id: str, task: asyncio.Task[None] | None = None) -> None:
        """Forget ``request_id``. With ``task`` given, only if it is still the registered one."""
        current = self._tasks.get(request_id)
        if current is None:
            return
        if task is None or current is task:
            del self._tasks[request_id]

    def cancel_all(self) -> tuple[asyncio.Task[None], ...]:
        """Cancel every live task and clear the registry. Returns the tasks so callers can await."""
        tasks = tuple(self._tasks.values())
        for task in tasks:
            if not task.done():
                task.cancel()
        self._tasks.clear()
        return tasks
