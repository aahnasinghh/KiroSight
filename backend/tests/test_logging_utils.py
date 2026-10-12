"""Task 6.4 deterministic tests for log redaction (Task 6.5 owns the property test)."""

from __future__ import annotations

import io
import logging
import uuid
from collections.abc import Iterator

import pytest

from app.logging_utils import REDACTED, RedactingFilter, format_metadata, redact

# Distinctive fake values only. No real credentials are used anywhere.
FAKE_SECRET = "zz-fake-secret-7Q4m9"
FAKE_AWS_ID = "AKIAFAKEFAKEFAKE1234"
FAKE_AWS_SECRET = "fakeAwsSecret/Key+9x8y7z6w5v4u3t2s1r0q"
FAKE_AWS_SESSION = "fakeAwsSessionTokenValue123456"
FAKE_DEEPGRAM = "fakeDeepgramKey0123456789abcdef"
FAKE_AUTH_TOKEN = "fake-kirosight-auth-token-55aa"
FAKE_CODE = "def very_distinctive_function_name_xyz(): return 'private source'"
FAKE_AUDIO = b"RIFF\x00\x01FAKEAUDIOBYTES\xff\xfe"


# ---------------------------------------------------------------- redact()


def test_ordinary_text_and_unicode_are_unchanged() -> None:
    text = "Opened auth.ts at line 42 - tests passed ✓ café 日本語"
    assert redact(text) == text
    assert redact(text, [FAKE_SECRET]) == text


def test_empty_input_is_safe() -> None:
    assert redact("") == ""
    assert redact("", [FAKE_SECRET]) == ""


def test_single_supplied_secret_is_replaced() -> None:
    result = redact(f"connecting with {FAKE_SECRET} now", [FAKE_SECRET])
    assert FAKE_SECRET not in result
    assert result == f"connecting with {REDACTED} now"


def test_multiple_supplied_secrets_and_repeats_are_replaced() -> None:
    other = "second-fake-value-88"
    text = f"{FAKE_SECRET} / {other} / {FAKE_SECRET} / {other}"
    result = redact(text, [FAKE_SECRET, other])
    assert FAKE_SECRET not in result
    assert other not in result
    assert result.count(REDACTED) == 4


@pytest.mark.parametrize("position", ["start", "middle", "end"])
def test_secret_at_any_position(position: str) -> None:
    text = {
        "start": f"{FAKE_SECRET} then plain text",
        "middle": f"plain {FAKE_SECRET} text",
        "end": f"plain text then {FAKE_SECRET}",
    }[position]
    result = redact(text, [FAKE_SECRET])
    assert FAKE_SECRET not in result
    assert REDACTED in result


def test_overlapping_supplied_secrets_do_not_leak_the_longer_one() -> None:
    assert redact("value abc123 end", ["abc", "abc123"]) == f"value {REDACTED} end"
    assert redact("value abc123 end", ["abc123", "abc"]) == f"value {REDACTED} end"


def test_partially_overlapping_secrets_leave_no_fragment() -> None:
    result = redact("xx abcdef yy", ["abcd", "cdef"])
    assert "ef" not in result.replace(REDACTED, "").replace("yy", "")
    assert result == f"xx {REDACTED} yy"


@pytest.mark.parametrize("bad", [None, "", "   ", "\t\n"])
def test_unusable_secret_entries_are_ignored(bad: str | None) -> None:
    text = "plain text with spaces"
    assert redact(text, [bad]) == text
    assert redact(text, [bad, FAKE_SECRET]) == text


def test_a_lone_string_is_one_secret_not_a_character_list() -> None:
    assert redact("abc and xyz", "abc") == f"{REDACTED} and xyz"


def test_secret_with_surrounding_whitespace_is_also_removed_when_stripped() -> None:
    result = redact(f"value={FAKE_SECRET}.", [f"  {FAKE_SECRET}  "])
    assert FAKE_SECRET not in result


def test_secret_that_matches_marker_text_does_not_corrupt_output() -> None:
    assert redact(f"a {FAKE_SECRET} b", ["RED", FAKE_SECRET]) == f"a {REDACTED} b"


def test_redact_is_idempotent() -> None:
    once = redact(f"token={FAKE_SECRET}", [FAKE_SECRET])
    assert redact(once, [FAKE_SECRET]) == once


def test_authorization_header_value_is_redacted_but_label_kept() -> None:
    result = redact("Authorization: Bearer abc123token")
    assert "abc123token" not in result
    assert result == f"Authorization: {REDACTED}"


def test_bare_bearer_token_is_redacted() -> None:
    result = redact("sent Bearer abc123token to server")
    assert "abc123token" not in result
    assert result == f"sent Bearer {REDACTED} to server"


@pytest.mark.parametrize(
    "line, label",
    [
        (f"api_key={FAKE_SECRET}", "api_key="),
        (f'"password": "{FAKE_SECRET}"', '"password": '),
        (f"client_secret: {FAKE_SECRET}", "client_secret: "),
        (f"access_token={FAKE_SECRET}&next=1", "access_token="),
        (f"secret = {FAKE_SECRET}", "secret = "),
    ],
)
def test_key_value_secrets_are_redacted_and_label_is_kept(line: str, label: str) -> None:
    result = redact(line)
    assert FAKE_SECRET not in result
    assert label in result
    assert REDACTED in result


def test_aws_style_values_are_redacted() -> None:
    text = (
        f"AWS_ACCESS_KEY_ID={FAKE_AWS_ID}\n"
        f"AWS_SECRET_ACCESS_KEY={FAKE_AWS_SECRET}\n"
        f"AWS_SESSION_TOKEN={FAKE_AWS_SESSION}\n"
        f"standalone {FAKE_AWS_ID} id"
    )
    result = redact(text)
    for value in (FAKE_AWS_ID, FAKE_AWS_SECRET, FAKE_AWS_SESSION):
        assert value not in result
    assert "AWS_SECRET_ACCESS_KEY=" in result


def test_deepgram_style_values_are_redacted() -> None:
    result = redact(f"DEEPGRAM_API_KEY={FAKE_DEEPGRAM} and Token {FAKE_DEEPGRAM}", [FAKE_DEEPGRAM])
    assert FAKE_DEEPGRAM not in result
    assert "DEEPGRAM_API_KEY=" in result


def test_kirosight_auth_token_is_redacted() -> None:
    result = redact(f"KIROSIGHT_AUTH_TOKEN={FAKE_AUTH_TOKEN}")
    assert FAKE_AUTH_TOKEN not in result
    assert "KIROSIGHT_AUTH_TOKEN=" in result


def test_prefixed_and_jwt_tokens_are_redacted() -> None:
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.fakeSignatureValue12"
    result = redact(f"saw {jwt} and sk-fakefakefakefakefake12")
    assert jwt not in result
    assert "sk-fakefake" not in result


def test_ordinary_code_like_text_is_not_destroyed() -> None:
    text = "max_retries = 3; tokens counted: 12; secret_santa list; keyboard=us"
    assert redact(text) == text


# ------------------------------------------------------ RedactingFilter


@pytest.fixture
def capture() -> Iterator[tuple[logging.Logger, io.StringIO]]:
    """An isolated logger writing to a buffer. Root logging state is checked unchanged."""
    root = logging.getLogger()
    root_state = (list(root.handlers), list(root.filters), root.level)

    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    handler.addFilter(
        RedactingFilter(
            [FAKE_SECRET, FAKE_AWS_SECRET, FAKE_DEEPGRAM, FAKE_AUTH_TOKEN, FAKE_CODE]
        )
    )
    logger = logging.getLogger(f"kirosight.test.{uuid.uuid4().hex}")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    logger.addHandler(handler)
    try:
        yield logger, stream
    finally:
        logger.removeHandler(handler)
        assert (list(root.handlers), list(root.filters), root.level) == root_state


def test_percent_style_arg_secret_is_not_emitted(capture: tuple[logging.Logger, io.StringIO]) -> None:
    logger, stream = capture
    logger.info("token=%s", FAKE_SECRET)
    output = stream.getvalue()
    assert FAKE_SECRET not in output
    assert REDACTED in output


def test_direct_string_secret_is_not_emitted(capture: tuple[logging.Logger, io.StringIO]) -> None:
    logger, stream = capture
    logger.warning(f"startup note {FAKE_SECRET} and Authorization: Bearer abc123token")
    output = stream.getvalue()
    assert FAKE_SECRET not in output
    assert "abc123token" not in output


def test_multiple_secrets_in_args_are_removed(capture: tuple[logging.Logger, io.StringIO]) -> None:
    logger, stream = capture
    logger.error("keys %s | %s | %s", FAKE_DEEPGRAM, FAKE_AWS_SECRET, FAKE_AUTH_TOKEN)
    output = stream.getvalue()
    for value in (FAKE_DEEPGRAM, FAKE_AWS_SECRET, FAKE_AUTH_TOKEN):
        assert value not in output


def test_mapping_args_are_made_safe(capture: tuple[logging.Logger, io.StringIO]) -> None:
    logger, stream = capture
    logger.info("value %(v)s", {"v": FAKE_SECRET})
    assert FAKE_SECRET not in stream.getvalue()


def test_ordinary_metadata_remains_visible(capture: tuple[logging.Logger, io.StringIO]) -> None:
    logger, stream = capture
    logger.info("received type=%s id=%s size=%d", "agent_request", "req-17", 2048)
    assert stream.getvalue().strip() == "INFO received type=agent_request id=req-17 size=2048"


def test_filter_handles_numeric_bool_and_none_args(
    capture: tuple[logging.Logger, io.StringIO],
) -> None:
    logger, stream = capture
    logger.info("n=%s f=%s ok=%s none=%s", 3, 1.5, True, None)
    assert stream.getvalue().strip() == "INFO n=3 f=1.5 ok=True none=None"


def test_literal_percent_without_args_is_preserved(
    capture: tuple[logging.Logger, io.StringIO],
) -> None:
    logger, stream = capture
    # Standard logging does not interpolate when there are no args, so text passes through as-is.
    logger.info("progress 100%% done")
    logger.info("raw 100% sign")
    logger.info("with args 100%% of %s", "x")
    assert stream.getvalue().splitlines() == [
        "INFO progress 100%% done",
        "INFO raw 100% sign",
        "INFO with args 100% of x",
    ]


def test_bad_format_string_does_not_crash_or_leak_args(
    capture: tuple[logging.Logger, io.StringIO],
) -> None:
    logger, stream = capture
    logger.info("two placeholders %s %s", FAKE_SECRET)
    assert FAKE_SECRET not in stream.getvalue()


def test_exception_text_is_redacted_and_has_no_source_lines(
    capture: tuple[logging.Logger, io.StringIO],
) -> None:
    logger, stream = capture
    try:
        raise RuntimeError(f"upstream rejected key {FAKE_SECRET}")
    except RuntimeError:
        logger.exception("call failed")
    output = stream.getvalue()
    assert FAKE_SECRET not in output
    assert "RuntimeError" in output
    assert "Traceback" not in output
    assert "raise RuntimeError" not in output


def test_extra_string_attributes_are_redacted(capture: tuple[logging.Logger, io.StringIO]) -> None:
    logger, stream = capture
    stream_handler = logger.handlers[0]
    stream_handler.setFormatter(logging.Formatter("%(message)s extra=%(detail)s"))
    logger.info("hello", extra={"detail": f"key {FAKE_SECRET}"})
    assert FAKE_SECRET not in stream.getvalue()


def test_audio_bytes_args_are_never_emitted(capture: tuple[logging.Logger, io.StringIO]) -> None:
    logger, stream = capture
    logger.info("clip %s", FAKE_AUDIO)
    logger.info("clip %s", bytearray(FAKE_AUDIO))
    output = stream.getvalue()
    assert "FAKEAUDIOBYTES" not in output
    assert f"<{len(FAKE_AUDIO)} bytes omitted>" in output


def test_registered_source_code_payload_is_filtered(
    capture: tuple[logging.Logger, io.StringIO],
) -> None:
    logger, stream = capture
    logger.info("file contents: %s", FAKE_CODE)
    assert "very_distinctive_function_name_xyz" not in stream.getvalue()


def test_filter_never_drops_records_and_keeps_a_record_safe_for_other_handlers() -> None:
    record = logging.LogRecord("n", logging.INFO, __file__, 1, "token=%s", (FAKE_SECRET,), None)
    assert RedactingFilter([FAKE_SECRET]).filter(record) is True
    assert FAKE_SECRET not in record.getMessage()
    assert record.args == ()


def test_filter_repr_does_not_expose_secrets() -> None:
    assert FAKE_SECRET not in repr(RedactingFilter([FAKE_SECRET]))


def test_importing_and_using_the_module_adds_no_handlers() -> None:
    before = list(logging.getLogger().handlers)
    redact("x", [FAKE_SECRET])
    RedactingFilter([FAKE_SECRET])
    assert logging.getLogger().handlers == before
    assert logging.getLogger("app.logging_utils").handlers == []


# ------------------------------------------------------- format_metadata


def test_format_metadata_keeps_type_id_and_sizes() -> None:
    assert format_metadata(type="audio_clip", id="r1", size=2048) == "type=audio_clip id=r1 size=2048"


def test_format_metadata_replaces_audio_with_a_size_only() -> None:
    text = format_metadata(type="audio_clip", payload=FAKE_AUDIO)
    assert "FAKEAUDIOBYTES" not in text
    assert f"payload=<{len(FAKE_AUDIO)} bytes omitted>" in text


def test_format_metadata_does_not_render_containers_or_objects() -> None:
    text = format_metadata(context={"code": FAKE_CODE}, items=[FAKE_CODE])
    assert "very_distinctive_function_name_xyz" not in text
    assert text == "context=<dict> items=<list>"


def test_format_metadata_truncates_collapses_and_redacts_strings() -> None:
    long_code = "x = 1\n" * 100
    text = format_metadata(note=long_code, key=f"token={FAKE_SECRET}")
    assert "\n" not in text
    assert len(text) < 200
    assert FAKE_SECRET not in text
