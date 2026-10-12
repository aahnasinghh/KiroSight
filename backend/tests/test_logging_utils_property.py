"""Task 6.5 Property 27 tests for redaction (no production changes)."""

from __future__ import annotations

import logging

from hypothesis import given, settings, strategies as st

from app.logging_utils import REDACTED, RedactingFilter, redact

# Lowercase/digit secrets cannot be substrings of the uppercase replacement marker. The fixed
# surrounding text uses uppercase delimiters so the generated value cannot occur there by chance.
SECRET_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
SECRET = st.text(alphabet=SECRET_ALPHABET, min_size=6, max_size=64)
SHORT_SECRET = st.text(alphabet=SECRET_ALPHABET, min_size=6, max_size=32)

LABELS = st.sampled_from(
    [
        "api_key",
        "password",
        "passwd",
        "secret",
        "secret_key",
        "auth_token",
        "access_token",
        "DEEPGRAM_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
    ]
)


@given(secret=SECRET)
@settings(max_examples=100)
def test_every_generated_explicit_secret_is_removed(secret: str) -> None:
    text = f"LEFT|{secret}|RIGHT"

    result = redact(text, [secret])

    assert secret not in result
    assert REDACTED in result
    assert "LEFT|" in result
    assert "|RIGHT" in result


@given(secrets=st.lists(SHORT_SECRET, min_size=1, max_size=6, unique=True))
@settings(max_examples=100)
def test_every_generated_secret_in_a_list_is_removed(
    secrets: list[str],
) -> None:
    # Exact uniqueness is required, but prefix/suffix overlap remains possible and intentional.
    text = "BEGIN|" + "|".join(
        f"slot{index}={secret}|repeat={secret}" for index, secret in enumerate(secrets)
    ) + "|END"

    result = redact(text, secrets)

    for secret in secrets:
        assert secret not in result
    assert "BEGIN|" in result
    assert "|END" in result
    assert REDACTED in result


@given(label=LABELS, value=SHORT_SECRET)
@settings(max_examples=100)
def test_generated_labeled_credentials_are_removed_without_explicit_secrets(
    label: str,
    value: str,
) -> None:
    text = f"prefix {label}={value} suffix"

    result = redact(text)

    assert value not in result
    assert label in result
    assert REDACTED in result
    assert "prefix " in result
    assert " suffix" in result


@given(secret=SECRET)
@settings(max_examples=100)
def test_redacting_filter_removes_generated_secret_from_percent_args(secret: str) -> None:
    record = logging.LogRecord(
        "kirosight.property",
        logging.INFO,
        __file__,
        1,
        "type=agent_request id=req-1 token=%s",
        (secret,),
        None,
    )

    result = RedactingFilter([secret]).filter(record)

    assert result is True
    assert secret not in record.getMessage()
    assert "type=agent_request" in record.getMessage()
    assert "id=req-1" in record.getMessage()
    assert record.args == ()


@given(secret=SECRET)
@settings(max_examples=100)
def test_generated_secret_redaction_is_idempotent(secret: str) -> None:
    text = f"START token={secret} END"

    once = redact(text, [secret])
    twice = redact(once, [secret])

    assert secret not in once
    assert twice == once
