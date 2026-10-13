"""Strict parsing of raw model output into an ``AgentResponse`` (Task 7.3).

The model is untrusted. ``parse_agent_output`` turns whatever came back (JSON text, a mapping, or
anything else) into exactly one of two results:

* an :class:`AgentResponse` whose shape passed the protocol model, whose speech was limited to at
  most 5 sentences and 600 characters, and whose action is one of the eight allow-listed actions with
  valid parameters; or
* an :class:`AgentFailure` carrying a fixed, safe message and no action.

It never raises, never returns an action outside ``app.allowlist.ALLOWED_ACTIONS``, and never copies
model content into a failure, so nothing partial is spoken as fact (Requirements 5.5, 5.6, 7.5,
12.6, 13.4). It does not execute anything, retry, call a provider, or log.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from itertools import islice
from typing import Any, Final, Literal

from pydantic import ValidationError

from app.allowlist import ALLOWED_ACTIONS
from app.protocol.messages import MAX_SPEECH_CHARS, PROTOCOL_VERSION, AgentResponse, ErrorCode

__all__ = [
    "AGENT_FAILURE_MESSAGE",
    "MAX_RAW_OUTPUT_CHARS",
    "MAX_SPEECH_SENTENCES",
    "AgentFailure",
    "FailureReason",
    "limit_sentences",
    "limit_speech",
    "parse_agent_output",
]

#: Requirements 7.5 and 12.6: spoken answers are at most 5 sentences.
MAX_SPEECH_SENTENCES: Final = 5

#: Raw JSON text larger than this is refused before it is decoded.
MAX_RAW_OUTPUT_CHARS: Final = 64 * 1024

#: Design failure F6, shown to the user. Fixed text: it never contains model output.
AGENT_FAILURE_MESSAGE: Final = (
    "I couldn't understand the reasoning service's answer, so I did nothing. Please try rephrasing."
)

FailureReason = Literal[
    "not_json",
    "not_object",
    "too_large",
    "invalid_shape",
    "empty_speech",
    "reply_mismatch",
    "action_not_allowed",
    "action_invalid",
    "internal",
]


@dataclass(frozen=True)
class AgentFailure:
    """A safe parse failure. It carries no action and no model content.

    ``reason`` is a fixed category for metadata-only logging; ``message`` is the fixed user-facing
    text; ``error_code`` is the wire ``ErrorMessage.code`` the caller should use (design F6).
    """

    reason: FailureReason
    message: str = AGENT_FAILURE_MESSAGE
    error_code: ErrorCode = "BEDROCK_INVALID_RESPONSE"


# --- sentence and length limiting ---------------------------------------------------------------

# One sentence: starts at a non-space character and runs to the first run of . ! ? (plus closing
# quotes or brackets) that is followed by whitespace or the end, or to the end of the text. A "."
# inside "3.5" or "a.b" is not followed by whitespace, so it does not end a sentence.
#
# Two details keep this correct and fast on hostile text:
# * The start is a lookahead, not a consumed character, so a sentence that begins with a terminator
#   ("! Next." or ". A.") is ended by it exactly like "!! Next." is.
# * A terminator run is only tried from its first character (``(?<![.!?])``) and is possessive
#   (``++``, ``*+``), so each run is scanned once. Without that, a long run such as ``"a" + "!" * N +
#   "b"`` is rescanned from every position and backtracked, which takes quadratic time (about 30 s for
#   N = 20,000) and would stall the backend's event loop on a hostile model reply.
_SENTENCE = re.compile(
    r"""(?=\S).*?(?:(?<![.!?])[.!?]++["')\]]*+(?=\s|\Z)|\Z)""",
    re.DOTALL,
)


def _utf16_units(text: str) -> int:
    """Length in UTF-16 code units, the unit the protocol's speech cap uses."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def limit_sentences(text: str, max_sentences: int = MAX_SPEECH_SENTENCES) -> str:
    """The first ``max_sentences`` sentences of ``text``, exactly as written and in order.

    The result is a prefix of the input's sentences (leading and trailing whitespace trimmed), so
    nothing is reordered or rewritten. Text with fewer sentences is returned trimmed but whole.
    """
    if max_sentences <= 0:
        return ""
    spans = [match.span() for match in islice(_SENTENCE.finditer(text), max_sentences)]
    if not spans:
        return ""
    # An unterminated final sentence runs to the end of the text, so drop its trailing whitespace.
    return text[spans[0][0]:spans[-1][1]].rstrip()


def limit_speech(
    text: str,
    max_sentences: int = MAX_SPEECH_SENTENCES,
    max_units: int = MAX_SPEECH_CHARS,
) -> str:
    """Limit to ``max_sentences`` sentences and ``max_units`` UTF-16 units.

    Whole sentences are kept while they fit. If even the first sentence is too long it is cut at the
    last whitespace inside the limit (or at the limit when there is none). No text is added.
    """
    limited = limit_sentences(text, max_sentences)
    if _utf16_units(limited) <= max_units:
        return limited

    # ``limited`` starts at its first sentence, so every span is a prefix of it.
    kept_end = 0
    for match in _SENTENCE.finditer(limited):
        if _utf16_units(limited[:match.end()]) > max_units:
            break
        kept_end = match.end()
    if kept_end > 0:
        return limited[:kept_end]

    # The first sentence alone is too long: cut it inside the limit, preferring a word boundary.
    units = 0
    cut_at = len(limited)
    for index, character in enumerate(limited):
        units += 2 if ord(character) > 0xFFFF else 1
        if units > max_units:
            cut_at = index
            break
    cut = limited[:cut_at]
    boundary = max(cut.rfind(" "), cut.rfind("\n"), cut.rfind("\t"))
    return (cut[:boundary] if boundary > 0 else cut).rstrip()


# --- parsing ------------------------------------------------------------------------------------


def _fail(reason: FailureReason) -> AgentFailure:
    return AgentFailure(reason=reason)


def _decode(raw: object) -> dict[str, Any] | AgentFailure:
    """JSON text or a mapping to a fresh dict; anything else is a failure."""
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = bytes(raw).decode("utf-8")
        except UnicodeDecodeError:
            return _fail("not_json")
    if isinstance(raw, str):
        if len(raw) > MAX_RAW_OUTPUT_CHARS:
            return _fail("too_large")
        try:
            raw = json.loads(raw)
        except (ValueError, RecursionError):
            return _fail("not_json")
    if isinstance(raw, Mapping):
        return dict(raw)
    return _fail("not_object")


def _check_action(response: AgentResponse) -> AgentFailure | None:
    spec = ALLOWED_ACTIONS.get(response.action.type)
    if spec is None:
        return _fail("action_not_allowed")
    try:
        # ``type`` is the registry key; every other field must satisfy the strict parameter model.
        spec.validate_params(response.action.model_extra or {})
    except ValidationError:
        return _fail("action_invalid")
    return None


def parse_agent_output(raw: object, *, reply_to: str | None = None) -> AgentResponse | AgentFailure:
    """Validate raw model output. Returns an ``AgentResponse`` or an ``AgentFailure``; never raises.

    ``raw`` may be JSON text, bytes, or a mapping. A provider that returns only the model-authored
    fields (``speech``, ``action``, ``confirmationRequired``) may pass ``reply_to`` to supply the
    transport envelope (``version``, ``type``, ``replyTo``); fields the model did include are still
    validated, and a ``replyTo`` that disagrees with ``reply_to`` is rejected.
    """
    try:
        decoded = _decode(raw)
        if isinstance(decoded, AgentFailure):
            return decoded
        candidate = decoded

        if reply_to is not None:
            candidate.setdefault("version", PROTOCOL_VERSION)
            candidate.setdefault("type", "agent_response")
            if candidate.setdefault("replyTo", reply_to) != reply_to:
                return _fail("reply_mismatch")

        speech = candidate.get("speech")
        if isinstance(speech, str):
            limited = limit_speech(speech)
            if limited.strip() == "":
                return _fail("empty_speech")
            candidate["speech"] = limited

        try:
            response = AgentResponse.model_validate(candidate)
        except ValidationError:
            return _fail("invalid_shape")

        failure = _check_action(response)
        return failure if failure is not None else response
    except Exception:  # noqa: BLE001 - the contract is "never raises" for any input
        return _fail("internal")
