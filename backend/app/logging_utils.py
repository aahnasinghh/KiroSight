"""Log redaction and metadata-only logging helpers (Requirement 17.6).

Public API:

* ``REDACTED`` - the replacement marker (same literal as ``extension/src/util/redact.ts``).
* ``redact(text, secrets=())`` - pure function that removes supplied secret values and common
  credential/token patterns from text.
* ``RedactingFilter`` - a ``logging.Filter`` that makes the *final formatted* log line safe.
  Attach it to a handler (handler filters see records propagated from child loggers; logger
  filters do not). Nothing is installed at import time.
* ``format_metadata(**fields)`` - renders ``key=value`` metadata (type, id, sizes) while refusing
  to render raw payloads such as audio bytes, code or containers.

Policy: backend logs carry metadata only. Audio, source/file contents and credentials are never
logged. This module never reads ``os.environ`` or ``Config`` values.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable, Mapping
from typing import Any

__all__ = ["REDACTED", "RedactingFilter", "format_metadata", "redact"]

REDACTED = "[REDACTED]"

_MAX_EXCEPTION_TEXT = 200
_MAX_METADATA_STRING = 64

_FLAGS = re.IGNORECASE

# Same shapes as extension/src/util/redact.ts, plus generic secret/passwd labels. A label is only
# matched when not preceded by a letter or digit, so ordinary words are left alone.
_AUTHORIZATION = re.compile(
    r"""(["']?authorization["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)""",
    _FLAGS,
)
_LABELED_SECRET = re.compile(
    r"""(["']?(?<![A-Za-z0-9])(?:(?:x[_-]?)?api[_-]?key|access[_-]?token|auth[_-]?token"""
    r"""|bearer[_-]?token|token|password|passwd|client[_-]?secret|secret(?:[_-]?key)?"""
    r"""|deepgram[_-]?(?:api[_-]?)?key|aws[_-]?access[_-]?key[_-]?id"""
    r"""|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)["']?\s*[:=]\s*)"""
    r"""(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&#]+)""",
    _FLAGS,
)
_BEARER = re.compile(r"\bbearer\s+[a-z0-9._~+/\-]+=*", _FLAGS)
_AWS_ACCESS_KEY_ID = re.compile(r"\b(?:AIDA|AKIA|AROA|ASIA)[A-Z0-9]{16}\b")
_JWT = re.compile(r"\beyJ[a-z0-9_\-]{8,}\.[a-z0-9_\-]{8,}\.[a-z0-9_\-]{8,}\b", _FLAGS)
_PREFIXED_TOKEN = re.compile(
    r"\b(?:dg[_\-][a-z0-9_\-]{16,}|gh[pousr]_[a-z0-9]{16,}|sk-[a-z0-9_\-]{16,})\b", _FLAGS
)

_BYTES_LIKE = (bytes, bytearray, memoryview)

# Attributes every LogRecord has; anything else came from ``extra=``.
_STANDARD_RECORD_ATTRIBUTES = frozenset(
    logging.LogRecord("", 0, "", 0, "", (), None).__dict__
) | {"message", "asctime"}


def _normalize_secrets(secrets: Iterable[str | None] | str | None) -> tuple[str, ...]:
    """Return usable secrets, longest first. Blank/None/non-str entries are ignored.

    A secret is also registered in its stripped form, so a value logged without its
    surrounding whitespace is still removed.
    """
    if secrets is None:
        return ()
    if isinstance(secrets, str):  # a lone string must not be iterated character by character
        secrets = (secrets,)
    usable: set[str] = set()
    for candidate in secrets:
        if not isinstance(candidate, str):
            continue
        for variant in (candidate, candidate.strip()):
            if variant.strip() != "" and variant != REDACTED:
                usable.add(variant)
    return tuple(sorted(usable, key=lambda value: (-len(value), value)))


def _redact_supplied(text: str, secrets: tuple[str, ...]) -> str:
    """Replace every occurrence of every secret, merging overlapping matches.

    Spans are located in the original text and merged before replacement, so a shorter secret
    can never expose part of a longer or partially overlapping one.
    """
    spans: list[tuple[int, int]] = []
    for secret in secrets:
        start = text.find(secret)
        while start != -1:
            spans.append((start, start + len(secret)))
            start = text.find(secret, start + 1)
    if not spans:
        return text

    spans.sort()
    merged = [spans[0]]
    for begin, end in spans[1:]:
        last_begin, last_end = merged[-1]
        if begin <= last_end:
            merged[-1] = (last_begin, max(last_end, end))
        else:
            merged.append((begin, end))

    pieces: list[str] = []
    cursor = 0
    for begin, end in merged:
        pieces.append(text[cursor:begin])
        pieces.append(REDACTED)
        cursor = end
    pieces.append(text[cursor:])
    return "".join(pieces)


def redact(text: str, secrets: Iterable[str | None] | str | None = None) -> str:
    """Return ``text`` with supplied secret values and common credential patterns replaced.

    Pure and deterministic. ``None`` or empty text yields ``""``. Non-secret text is preserved.
    Labeled values keep their label (``token=[REDACTED]``). Idempotent.
    """
    if not text:
        return ""
    sanitized = _redact_supplied(text, _normalize_secrets(secrets))
    sanitized = _AUTHORIZATION.sub(lambda m: m.group(1) + REDACTED, sanitized)
    sanitized = _LABELED_SECRET.sub(lambda m: m.group(1) + REDACTED, sanitized)
    sanitized = _BEARER.sub("Bearer " + REDACTED, sanitized)
    sanitized = _AWS_ACCESS_KEY_ID.sub(REDACTED, sanitized)
    sanitized = _JWT.sub(REDACTED, sanitized)
    sanitized = _PREFIXED_TOKEN.sub(REDACTED, sanitized)
    return sanitized


def _bytes_marker(value: bytes | bytearray | memoryview) -> str:
    return f"<{memoryview(value).nbytes} bytes omitted>"


def _sanitize_value(value: Any) -> Any:
    """Replace raw binary payloads (for example audio) with a size-only marker."""
    if isinstance(value, _BYTES_LIKE):
        return _bytes_marker(value)
    return value


def _sanitize_args(args: Any) -> Any:
    if isinstance(args, tuple):
        return tuple(_sanitize_value(item) for item in args)
    if isinstance(args, Mapping):
        return {key: _sanitize_value(item) for key, item in args.items()}
    return args


class RedactingFilter(logging.Filter):
    """Make the final emitted log text free of secret values.

    The record's message is fully formatted first (``msg % args``) and *then* redacted, so a
    secret passed as a ``%s`` argument cannot survive interpolation. Binary arguments are
    replaced by a size marker. Exceptions are reduced to ``Type: message`` (no stack frames, which
    would print source code) and redacted. ``extra=`` string attributes are redacted. The filter
    never drops a record and never changes logger or root configuration.
    """

    def __init__(self, secrets: Iterable[str | None] | str | None = None, name: str = "") -> None:
        super().__init__(name)
        self._secrets = _normalize_secrets(secrets)

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            self._sanitize(record)
        except Exception:  # never let logging leak or crash because sanitizing failed
            record.msg = "[log record could not be sanitized]"
            record.args = ()
            record.exc_info = None
            record.exc_text = None
            record.stack_info = None
        return True

    def _sanitize(self, record: logging.LogRecord) -> None:
        record.args = _sanitize_args(record.args)
        try:
            message = record.getMessage()
        except Exception:
            # Bad format string: use the template only, never the (unsafe) arguments.
            message = str(record.msg)
        record.msg = redact(message, self._secrets)
        record.args = ()

        if record.exc_info and record.exc_info[0] is not None:
            record.exc_text = redact(self._describe_exception(record.exc_info), self._secrets)
        elif record.exc_text:
            record.exc_text = redact(record.exc_text, self._secrets)
        record.stack_info = None

        for key, value in list(record.__dict__.items()):
            if key in _STANDARD_RECORD_ATTRIBUTES:
                continue
            if isinstance(value, str):
                record.__dict__[key] = redact(value, self._secrets)
            elif isinstance(value, _BYTES_LIKE):
                record.__dict__[key] = _bytes_marker(value)

    @staticmethod
    def _describe_exception(exc_info: Any) -> str:
        exc_type, exc_value = exc_info[0], exc_info[1]
        try:
            detail = str(exc_value) if exc_value is not None else ""
        except Exception:
            detail = ""
        text = f"{exc_type.__name__}: {detail}" if detail else exc_type.__name__
        return text[:_MAX_EXCEPTION_TEXT]


def _format_metadata_value(value: Any) -> str:
    if value is None or isinstance(value, (bool, int, float)):
        return str(value)
    if isinstance(value, _BYTES_LIKE):
        return _bytes_marker(value)
    if isinstance(value, str):
        single_line = " ".join(value.split())
        if len(single_line) > _MAX_METADATA_STRING:
            single_line = single_line[:_MAX_METADATA_STRING] + "..."
        return redact(single_line)
    # Containers and arbitrary objects may hold code, audio or credentials: type name only.
    return f"<{type(value).__name__}>"


def format_metadata(**fields: Any) -> str:
    """Render safe ``key=value`` metadata, for example ``type=audio_clip id=r1 size=2048``.

    Numbers, booleans and ``None`` pass through. Strings are collapsed to one line, truncated and
    redacted. Bytes-like values become ``<N bytes omitted>``. Any other object becomes
    ``<TypeName>``, so payloads cannot be logged by accident.
    """
    return " ".join(f"{key}={_format_metadata_value(value)}" for key, value in fields.items())
