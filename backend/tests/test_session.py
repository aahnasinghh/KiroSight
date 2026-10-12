"""Task 6.12 deterministic unit tests for ``Session`` (no WebSocket integration; that is 6.13)."""

from __future__ import annotations

import asyncio

import pytest

from app.session import (
    MAX_HISTORY_TURNS,
    STUB_CAPABILITIES,
    DuplicateRequestError,
    Session,
    Turn,
)


async def blocked_task() -> asyncio.Task[None]:
    """A task that is running and waiting forever, so cancellation is deterministic (no sleeps)."""
    started = asyncio.Event()

    async def work() -> None:
        started.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(work())
    await started.wait()
    return task


async def finish(*tasks: asyncio.Task[None]) -> None:
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


# --- history ---


def test_history_starts_empty() -> None:
    assert Session().history == ()
    assert MAX_HISTORY_TURNS == 6


def test_history_appends_in_order() -> None:
    session = Session()
    session.add_turn("one", "reply one")
    session.add_turn("two", "reply two")
    assert session.history == (Turn("one", "reply one"), Turn("two", "reply two"))


def test_history_keeps_only_the_last_six_turns() -> None:
    session = Session()
    for number in range(1, 11):
        session.add_turn(f"q{number}", f"a{number}")
    assert len(session.history) == 6
    assert [turn.request for turn in session.history] == ["q5", "q6", "q7", "q8", "q9", "q10"]
    assert session.history[0] == Turn("q5", "a5")


def test_history_snapshot_cannot_mutate_the_session() -> None:
    session = Session()
    session.add_turn("q", "a")
    snapshot = session.history
    session.add_turn("q2", "a2")
    assert snapshot == (Turn("q", "a"),)  # earlier snapshot is unchanged
    assert isinstance(snapshot, tuple)  # immutable
    with pytest.raises(AttributeError):
        snapshot[0].request = "changed"  # type: ignore[misc]


def test_each_session_has_its_own_history() -> None:
    first, second = Session(), Session()
    first.add_turn("q", "a")
    assert second.history == ()


# --- capabilities ---


def test_capability_snapshot_matches_the_stub_milestone() -> None:
    capabilities = Session().capabilities
    assert capabilities is STUB_CAPABILITIES
    assert (capabilities.bedrock, capabilities.stt, capabilities.tts) == (False, False, False)
    assert capabilities.mic == "not_applicable"


def test_handshake_starts_incomplete() -> None:
    assert Session().handshake_complete is False


# --- in-flight registry ---


async def test_register_tracks_a_live_task() -> None:
    session = Session()
    task = await blocked_task()
    session.register("r1", task)
    assert session.is_in_flight("r1")
    assert session.in_flight_ids == frozenset({"r1"})
    await finish(task)


async def test_duplicate_live_id_is_rejected_without_replacing_the_task() -> None:
    session = Session()
    first, second = await blocked_task(), await blocked_task()
    session.register("r1", first)
    with pytest.raises(DuplicateRequestError):
        session.register("r1", second)
    assert session.cancel("r1") is True  # the original task is still the registered one
    await asyncio.gather(first, return_exceptions=True)
    assert first.cancelled() and not second.done()
    await finish(second)


async def test_a_finished_id_can_be_reused() -> None:
    session = Session()
    first = await blocked_task()
    session.register("r1", first)
    await finish(first)
    second = await blocked_task()
    session.register("r1", second)  # no error: the first task is done
    assert session.is_in_flight("r1")
    await finish(second)


async def test_cancel_known_id_cancels_the_task_and_is_idempotent() -> None:
    session = Session()
    task = await blocked_task()
    session.register("r1", task)
    assert session.cancel("r1") is True
    with pytest.raises(asyncio.CancelledError):
        await task
    assert session.cancel("r1") is False  # already finished: harmless
    assert not session.is_in_flight("r1")


def test_cancel_unknown_id_does_nothing() -> None:
    session = Session()
    assert session.cancel("missing") is False
    assert session.in_flight_ids == frozenset()


async def test_remove_forgets_the_id_only_for_the_registered_task() -> None:
    session = Session()
    task, other = await blocked_task(), await blocked_task()
    session.register("r1", task)
    session.remove("r1", other)  # not the registered task: ignored
    assert session.is_in_flight("r1")
    session.remove("r1", task)
    assert not session.is_in_flight("r1")
    session.remove("r1")  # removing an unknown id is harmless
    await finish(task, other)


async def test_cancel_all_cancels_every_task_and_clears_the_registry() -> None:
    session = Session()
    tasks = [await blocked_task() for _ in range(3)]
    for index, task in enumerate(tasks):
        session.register(f"r{index}", task)
    returned = session.cancel_all()
    assert set(returned) == set(tasks)
    await asyncio.gather(*tasks, return_exceptions=True)
    assert all(task.cancelled() for task in tasks)
    assert session.in_flight_ids == frozenset()
    assert session.cancel_all() == ()  # safe to repeat
