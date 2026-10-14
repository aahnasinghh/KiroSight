"""Task 8.4: ``RecordingAssembler`` turns ``audio_clip`` frames into complete recordings.

Covers whole clips and chunked recordings, strict ordering, every rejection, cancellation, expiry,
bounded state and release of partial buffers, with Hypothesis properties for ordering and bounds.
"""

from __future__ import annotations

import base64
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.protocol.messages import AudioClip
from app.speech.recording import (
    MAX_FRAMES,
    MAX_ID_CHARS,
    MAX_PARTIAL_RECORDINGS,
    MAX_RECORDING_AGE_SECONDS,
    MAX_RECORDING_BYTES,
    TERMINAL_MEMORY,
    AudioRejected,
    CompletedRecording,
    RecordingAssembler,
)

MIME = "audio/webm;codecs=opus"


def frame(
    recording_id: str = "voice-1",
    data: bytes = b"\x01\x02\x03",
    seq: int | None = None,
    final: bool | None = None,
    *,
    mime: str = MIME,
    base64_text: str | None = None,
) -> AudioClip:
    fields: dict[str, Any] = {
        "version": 1,
        "type": "audio_clip",
        "id": recording_id,
        "mimeType": mime,
        "base64": base64.b64encode(data).decode() if base64_text is None else base64_text,
    }
    if seq is not None:
        fields["seq"] = seq
    if final is not None:
        fields["final"] = final
    return AudioClip(**fields)


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def rejected(assembler: RecordingAssembler, clip: AudioClip) -> AudioRejected:
    with pytest.raises(AudioRejected) as caught:
        assembler.accept(clip)
    return caught.value


# --- accepted shapes ---------------------------------------------------------------------------------


def test_a_whole_clip_completes_at_once() -> None:
    assembler = RecordingAssembler()

    done = assembler.accept(frame(data=b"whole clip bytes"))

    assert done == CompletedRecording(id="voice-1", mime_type=MIME, audio=b"whole clip bytes")
    assert assembler.partial_count == 0 and assembler.retained_bytes == 0


def test_a_single_frame_recording_with_seq_zero_and_final_completes() -> None:
    done = RecordingAssembler().accept(frame(data=b"abc", seq=0, final=True))

    assert done is not None and done.audio == b"abc"


def test_a_chunked_recording_completes_only_on_the_final_frame_in_the_original_order() -> None:
    assembler = RecordingAssembler()

    assert assembler.accept(frame(data=b"AAAA", seq=0, final=False)) is None
    assert assembler.partial_count == 1 and assembler.retained_bytes == 4
    assert assembler.accept(frame(data=b"BB", seq=1, final=False)) is None
    done = assembler.accept(frame(data=b"CCC", seq=2, final=True))

    assert done is not None
    assert (done.id, done.mime_type, done.audio) == ("voice-1", MIME, b"AAAABBCCC")
    assert assembler.partial_count == 0 and assembler.retained_bytes == 0


def test_an_empty_final_marker_completes_a_recording_that_has_audio() -> None:
    assembler = RecordingAssembler()
    assembler.accept(frame(data=b"abc", seq=0, final=False))

    done = assembler.accept(frame(data=b"", seq=1, final=True))

    assert done is not None and done.audio == b"abc"


def test_an_incomplete_recording_is_never_returned() -> None:
    assembler = RecordingAssembler()

    results = [assembler.accept(frame(data=bytes([n]), seq=n, final=False)) for n in range(10)]

    assert results == [None] * 10
    assert assembler.partial_count == 1


def test_recordings_are_independent_by_id() -> None:
    assembler = RecordingAssembler()
    assembler.accept(frame("a", b"A1", seq=0, final=False))
    assembler.accept(frame("b", b"B1", seq=0, final=False))

    done_a = assembler.accept(frame("a", b"A2", seq=1, final=True))
    done_b = assembler.accept(frame("b", b"B2", seq=1, final=True))

    assert done_a is not None and done_a.audio == b"A1A2"
    assert done_b is not None and done_b.audio == b"B1B2"


def test_the_completed_recording_does_not_print_its_audio() -> None:
    done = RecordingAssembler().accept(frame(data=b"SECRETAUDIOBYTES"))

    assert "SECRETAUDIOBYTES" not in repr(done)


# --- empty recordings --------------------------------------------------------------------------------


def test_a_recording_with_no_audio_at_all_is_no_speech() -> None:
    assembler = RecordingAssembler()
    assembler.accept(frame(data=b"", seq=0, final=False))

    error = rejected(assembler, frame(data=b"", seq=1, final=True))

    assert error.code == "STT_NO_SPEECH" and not error.silent
    assert assembler.partial_count == 0


def test_an_empty_whole_clip_is_no_speech() -> None:
    assert rejected(RecordingAssembler(), frame(data=b"")).code == "STT_NO_SPEECH"


# --- validation ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "mime",
    ["text/plain", "video/webm", "application/octet-stream", "audio/", "", "audio/webm\r\nX: 1", "audio/" + "a" * 120],
)
def test_unsupported_formats_are_rejected(mime: str) -> None:
    assembler = RecordingAssembler()

    error = rejected(assembler, frame(mime=mime))

    assert error.code == "VALIDATION_FAILED"
    assert assembler.partial_count == 0


@pytest.mark.parametrize("mime", ["audio/webm", "audio/webm;codecs=opus", "audio/ogg; codecs=opus", "audio/wav", "audio/mp4", "audio/x-wav"])
def test_the_recorder_formats_are_accepted(mime: str) -> None:
    assert RecordingAssembler().accept(frame(mime=mime)) is not None


@pytest.mark.parametrize(
    "text",
    ["not base64!", "abc", "====", "AA=A", "AAAA\n", " AAAA", "AA AA", "A===", "é" * 4, "AAAA" + "=" * 4],
)
def test_malformed_base64_is_rejected_and_the_recording_discarded(text: str) -> None:
    assembler = RecordingAssembler()
    assembler.accept(frame(data=b"good", seq=0, final=False))

    error = rejected(assembler, frame(seq=1, final=False, base64_text=text))

    assert error.code == "VALIDATION_FAILED"
    assert assembler.partial_count == 0 and assembler.retained_bytes == 0


@pytest.mark.parametrize("recording_id", ["", "x" * (MAX_ID_CHARS + 1)])
def test_an_unusable_recording_id_is_rejected(recording_id: str) -> None:
    assert rejected(RecordingAssembler(), frame(recording_id)).code == "VALIDATION_FAILED"


def test_the_longest_allowed_id_is_accepted() -> None:
    assert RecordingAssembler().accept(frame("x" * MAX_ID_CHARS)) is not None


# --- size and count limits ------------------------------------------------------------------------------


def test_a_recording_at_the_byte_limit_completes_and_one_byte_more_is_refused() -> None:
    mebibyte = 1024 * 1024
    quarter = MAX_RECORDING_BYTES // 4
    assert quarter == mebibyte
    at_limit = RecordingAssembler()
    for number in range(3):
        at_limit.accept(frame(data=b"a" * quarter, seq=number, final=False))
    done = at_limit.accept(frame(data=b"b" * quarter, seq=3, final=True))
    assert done is not None and len(done.audio) == MAX_RECORDING_BYTES

    over = RecordingAssembler()
    for number in range(3):
        over.accept(frame(data=b"a" * quarter, seq=number, final=False))
    error = rejected(over, frame(data=b"b" * (quarter + 1), seq=3, final=True))
    assert error.code == "VALIDATION_FAILED" and "large" in error.message
    assert over.partial_count == 0 and over.retained_bytes == 0


def test_a_whole_clip_over_the_byte_limit_is_refused() -> None:
    assert "large" in rejected(RecordingAssembler(), frame(data=b"a" * (MAX_RECORDING_BYTES + 1))).message


def test_the_frame_count_is_bounded() -> None:
    assembler = RecordingAssembler()
    for number in range(MAX_FRAMES):
        assert assembler.accept(frame(data=b"", seq=number, final=False)) is None

    error = rejected(assembler, frame(data=b"x", seq=MAX_FRAMES, final=False))

    assert "parts" in error.message
    assert assembler.partial_count == 0


def test_the_number_of_recordings_in_progress_is_bounded() -> None:
    assembler = RecordingAssembler()
    for number in range(MAX_PARTIAL_RECORDINGS):
        assembler.accept(frame(f"r{number}", seq=0, final=False))

    error = rejected(assembler, frame("one-too-many", seq=0, final=False))

    assert "Too many" in error.message
    assert assembler.partial_count == MAX_PARTIAL_RECORDINGS
    # Finishing one frees a slot.
    assembler.accept(frame("r0", seq=1, final=True))
    assert assembler.accept(frame("after", seq=0, final=False)) is None


def test_retained_bytes_never_exceed_the_per_recording_cap_times_the_recording_cap() -> None:
    assembler = RecordingAssembler()
    chunk = b"z" * (MAX_RECORDING_BYTES // 4)
    for number in range(MAX_PARTIAL_RECORDINGS):
        for part in range(4):  # each recording is filled to its own byte limit
            assembler.accept(frame(f"r{number}", chunk, seq=part, final=False))

    assert assembler.retained_bytes == MAX_PARTIAL_RECORDINGS * MAX_RECORDING_BYTES
    error = rejected(assembler, frame("r0", b"z", seq=4, final=False))  # a full recording takes no more
    assert "large" in error.message
    assert assembler.retained_bytes == (MAX_PARTIAL_RECORDINGS - 1) * MAX_RECORDING_BYTES


# --- ordering and repetition ----------------------------------------------------------------------------


def test_a_repeated_frame_discards_the_recording_and_is_reported_once() -> None:
    assembler = RecordingAssembler()
    assembler.accept(frame(data=b"one", seq=0, final=False))

    first = rejected(assembler, frame(data=b"one", seq=0, final=False))
    later = rejected(assembler, frame(data=b"two", seq=1, final=True))

    assert not first.silent and "out of order" in first.message
    assert later.silent  # already reported; one bad recording gives one error
    assert assembler.partial_count == 0 and assembler.retained_bytes == 0


def test_a_skipped_sequence_number_is_rejected() -> None:
    assembler = RecordingAssembler()
    assembler.accept(frame(seq=0, final=False))

    error = rejected(assembler, frame(seq=2, final=True))

    assert "out of order" in error.message and not error.silent
    assert assembler.partial_count == 0


@pytest.mark.parametrize("seq", [1, 5, 1999])
def test_a_recording_that_does_not_start_at_zero_is_rejected(seq: int) -> None:
    assembler = RecordingAssembler()

    error = rejected(assembler, frame(seq=seq, final=False))

    assert "out of order" in error.message
    assert assembler.partial_count == 0
    assert rejected(assembler, frame(seq=0, final=False)).silent  # the id is closed


def test_a_changed_mime_type_discards_the_recording() -> None:
    assembler = RecordingAssembler()
    assembler.accept(frame(seq=0, final=False, mime="audio/webm"))

    error = rejected(assembler, frame(seq=1, final=True, mime="audio/ogg"))

    assert "format changed" in error.message
    assert assembler.partial_count == 0


def test_a_whole_clip_cannot_reuse_the_id_of_a_recording_in_progress() -> None:
    assembler = RecordingAssembler()
    assembler.accept(frame(seq=0, final=False))

    error = rejected(assembler, frame(data=b"whole"))

    assert "already in progress" in error.message
    assert assembler.partial_count == 0


def test_a_finished_recording_cannot_be_submitted_again() -> None:
    assembler = RecordingAssembler()
    assembler.accept(frame(data=b"abc", seq=0, final=True))

    for repeat in (frame(data=b"abc", seq=0, final=True), frame(data=b"abc"), frame(data=b"x", seq=1, final=True)):
        error = rejected(assembler, repeat)
        assert "already received" in error.message and not error.silent


# --- cancellation and release ------------------------------------------------------------------------------


def test_cancel_discards_a_partial_recording_and_ignores_what_arrives_after() -> None:
    assembler = RecordingAssembler()
    assembler.accept(frame(data=b"abcdef", seq=0, final=False))

    assert assembler.cancel("voice-1") is True

    assert assembler.partial_count == 0 and assembler.retained_bytes == 0
    assert rejected(assembler, frame(data=b"x", seq=1, final=True)).silent
    assert rejected(assembler, frame(data=b"x", seq=0, final=True)).silent  # never transcribed


def test_cancel_of_an_unknown_or_finished_id_is_harmless() -> None:
    assembler = RecordingAssembler()
    assembler.accept(frame("done", seq=0, final=True))

    assert assembler.cancel("nobody") is False
    assert assembler.cancel("done") is False
    assert assembler.cancel("done") is False


def test_clear_releases_everything() -> None:
    assembler = RecordingAssembler()
    assembler.accept(frame("a", seq=0, final=False))
    assembler.accept(frame("b", seq=0, final=False))

    assembler.clear()

    assert assembler.partial_count == 0 and assembler.retained_bytes == 0
    assert assembler.accept(frame("a", seq=0, final=False)) is None  # a clean slate


def test_mark_failed_silences_later_frames_of_that_id() -> None:
    assembler = RecordingAssembler()
    assembler.mark_failed("voice-1")

    assert rejected(assembler, frame(seq=0, final=False)).silent


# --- expiry -----------------------------------------------------------------------------------------------


def test_a_partial_recording_just_inside_the_age_limit_still_completes() -> None:
    clock = Clock()
    assembler = RecordingAssembler(clock=clock)
    assembler.accept(frame(data=b"a", seq=0, final=False))
    clock.now += MAX_RECORDING_AGE_SECONDS

    done = assembler.accept(frame(data=b"b", seq=1, final=True))

    assert done is not None and done.audio == b"ab"


def test_a_stale_partial_recording_is_dropped_and_reported_once() -> None:
    clock = Clock()
    assembler = RecordingAssembler(clock=clock)
    assembler.accept(frame(data=b"a" * 100, seq=0, final=False))
    clock.now += MAX_RECORDING_AGE_SECONDS + 0.01

    first = rejected(assembler, frame(data=b"b", seq=1, final=True))
    second = rejected(assembler, frame(data=b"c", seq=2, final=True))

    assert "took too long" in first.message and not first.silent
    assert second.silent
    assert assembler.partial_count == 0 and assembler.retained_bytes == 0


def test_stale_recordings_are_released_when_any_later_frame_arrives() -> None:
    clock = Clock()
    assembler = RecordingAssembler(clock=clock)
    assembler.accept(frame("old", b"a" * 100, seq=0, final=False))
    clock.now += MAX_RECORDING_AGE_SECONDS + 1

    assembler.accept(frame("new", b"b", seq=0, final=False))

    assert assembler.partial_count == 1 and assembler.retained_bytes == 1


def test_remembered_finished_ids_are_bounded() -> None:
    assembler = RecordingAssembler()
    for number in range(TERMINAL_MEMORY * 3):
        assembler.accept(frame(f"id-{number}", seq=0, final=True))

    assert len(assembler._terminal) <= TERMINAL_MEMORY  # noqa: SLF001 - the documented memory bound


# --- properties -------------------------------------------------------------------------------------------


@st.composite
def split_recording(draw: st.DrawFn) -> tuple[bytes, list[bytes]]:
    whole = draw(st.binary(min_size=1, max_size=600))
    cuts = sorted(draw(st.lists(st.integers(min_value=0, max_value=len(whole)), max_size=8)))
    pieces: list[bytes] = []
    start = 0
    for cut in [*cuts, len(whole)]:
        pieces.append(whole[start:cut])
        start = cut
    return whole, pieces


@settings(max_examples=200, deadline=None)
@given(split_recording())
def test_property_in_order_frames_reassemble_exactly_and_only_at_the_end(case: tuple[bytes, list[bytes]]) -> None:
    whole, pieces = case
    assembler = RecordingAssembler()
    results = [
        assembler.accept(frame("p", piece, seq=number, final=number == len(pieces) - 1))
        for number, piece in enumerate(pieces)
    ]

    assert results[:-1] == [None] * (len(pieces) - 1)
    done = results[-1]
    assert done is not None and done.audio == whole
    assert assembler.partial_count == 0 and assembler.retained_bytes == 0


@settings(max_examples=250, deadline=None)
@given(st.lists(st.tuples(st.integers(0, 6), st.booleans()), min_size=1, max_size=14))
def test_property_only_the_exact_ordered_sequence_ever_completes(frames: list[tuple[int, bool]]) -> None:
    """Negative control: any other sequence of (seq, final) frames never yields a recording."""
    assembler = RecordingAssembler()
    expected_next = 0
    alive = True
    for seq, final in frames:
        clip = frame("only", bytes([seq + 1]), seq=seq, final=final)
        if not alive:
            with pytest.raises(AudioRejected) as caught:
                assembler.accept(clip)
            assert caught.value.silent or "already received" in caught.value.message
            continue
        if seq != expected_next:
            with pytest.raises(AudioRejected):
                assembler.accept(clip)
            alive = False
            assert assembler.partial_count == 0
            continue
        done = assembler.accept(clip)
        expected_next += 1
        if final:
            assert done is not None and done.audio == bytes(range(1, seq + 2))
            alive = False
        else:
            assert done is None
    # Whatever happened, nothing is left behind for a finished or failed recording.
    if not alive:
        assert assembler.partial_count == 0 and assembler.retained_bytes == 0


@settings(max_examples=150, deadline=None)
@given(
    st.lists(
        st.tuples(st.sampled_from(["a", "b", "c", "d", "e", "f", "g"]), st.integers(0, 3), st.booleans(), st.binary(max_size=50)),
        max_size=60,
    )
)
def test_property_state_stays_bounded_whatever_arrives(frames: list[tuple[str, int, bool, bytes]]) -> None:
    assembler = RecordingAssembler()
    for recording_id, seq, final, data in frames:
        try:
            assembler.accept(frame(recording_id, data, seq=seq, final=final))
        except AudioRejected:
            pass
        assert assembler.partial_count <= MAX_PARTIAL_RECORDINGS
        assert assembler.retained_bytes <= MAX_PARTIAL_RECORDINGS * MAX_RECORDING_BYTES
        assert len(assembler._terminal) <= TERMINAL_MEMORY  # noqa: SLF001
