"""Task 6.10 / Property 7: protocol messages round-trip (Python side).

For every generated VALID message of each of the 14 types:

    parse_message -> dump_message -> json.dumps -> json.loads -> parse_message -> dump_message

Both parses must succeed and the two canonical dumps must be equal. Generators only produce values
inside the accepted contract; malformed input belongs to Property 8 (Task 6.11).

``dump_message`` (``model_dump(mode="json", exclude_unset=True)``) is the wire serializer. A plain
``model_dump`` would emit ``null`` for absent optional fields, which the protocol (like the Zod
schemas) rejects, so ``exclude_unset`` is part of the wire form.
"""

from __future__ import annotations

import copy
import json
import string
from typing import Any

import pytest
from hypothesis import given, settings, strategies as st

from app.protocol.messages import BACKEND_MESSAGE_TYPES, ERROR_CODES, dump_message
from app.protocol.validators import ProtocolValidationError, parse_message

EXAMPLES = 100
_ABSENT = object()

# --- building blocks (bounded, synthetic, no credential-shaped values) ---

SAFE_ALPHABET = string.ascii_letters + string.digits + " _-.,:;!?()éß日"
safe_text = st.text(alphabet=SAFE_ALPHABET, max_size=40)
ident = st.text(alphabet=string.ascii_lowercase + string.digits + "-_", min_size=1, max_size=24)
mime = st.sampled_from(["audio/webm", "audio/mpeg", "audio/wav", "audio/ogg;codecs=opus"])
base64_like = st.text(alphabet=string.ascii_letters + string.digits + "+/=", max_size=24)


def with_optional(required: dict[str, st.SearchStrategy[Any]], optional: dict[str, st.SearchStrategy[Any]]):
    """Dict strategy where each optional key may be absent (never ``None`` unless the value is)."""
    optional_parts = {key: st.one_of(st.just(_ABSENT), value) for key, value in optional.items()}
    return st.tuples(st.fixed_dictionaries(required), st.fixed_dictionaries(optional_parts)).map(
        lambda pair: {**pair[0], **{k: v for k, v in pair[1].items() if v is not _ABSENT}}
    )


path_segment = st.text(alphabet=string.ascii_lowercase + string.digits + "_-.", min_size=1, max_size=8)
relative_path = st.lists(path_segment, min_size=1, max_size=3).map("/".join)
positive = st.integers(min_value=1, max_value=10_000)
count = st.integers(min_value=0, max_value=1_000)
pos = st.fixed_dictionaries({"line": positive, "column": positive})

# --- WireIDEContext ---

diagnostic = with_optional(
    {
        "severity": st.sampled_from(["error", "warning", "information", "hint"]),
        "relativePath": relative_path,
        "line": positive,
        "column": positive,
        "message": st.text(alphabet=SAFE_ALPHABET, max_size=60),
    },
    {
        "source": safe_text,
        "code": safe_text,
        "symbolName": st.one_of(st.none(), safe_text),
    },
)

wire_context = st.fixed_dictionaries(
    {
        "workspace": st.fixed_dictionaries(
            {"name": st.one_of(st.none(), safe_text), "rootCount": st.integers(0, 5)}
        ),
        "relativePath": st.one_of(st.none(), relative_path),
        "languageId": st.one_of(st.none(), st.sampled_from(["typescript", "python", "json"])),
        "cursor": st.one_of(st.none(), pos),
        "selection": st.one_of(
            st.none(),
            st.just({"isEmpty": True}),
            st.fixed_dictionaries({"isEmpty": st.just(False), "start": pos, "end": pos}),
        ),
        "nearbyCode": st.one_of(
            st.none(),
            st.fixed_dictionaries(
                {
                    "source": st.sampled_from(["selection", "symbol", "cursor_window"]),
                    "startLine": positive,
                    "endLine": positive,
                    "text": st.text(alphabet=SAFE_ALPHABET + "\n", max_size=120),
                    "truncated": st.booleans(),
                }
            ),
        ),
        "currentSymbol": st.one_of(
            st.none(),
            st.fixed_dictionaries(
                {"name": safe_text, "kind": safe_text, "startLine": positive, "endLine": positive}
            ),
        ),
        "symbolStatus": st.sampled_from(["found", "none_enclosing", "provider_unavailable", "no_editor"]),
        "diagnostics": st.lists(diagnostic, max_size=4),
        "diagnosticCounts": st.fixed_dictionaries(
            {"error": count, "warning": count, "information": count, "hint": count}
        ),
    }
)

utterance = with_optional({"text": safe_text}, {"source": st.sampled_from(["typed", "voice"])})

# --- TestRunSummary ---

failing_test = with_optional({"name": safe_text}, {"messageExcerpt": safe_text})
test_run_summary = st.fixed_dictionaries(
    {
        "outcome": st.sampled_from(
            ["passed", "failed", "completed_unparsed", "did_not_execute", "timed_out", "cancelled", "not_configured"]
        ),
        "command": safe_text,
        "exitCode": st.one_of(st.none(), st.integers(-255, 255)),
        "passed": st.one_of(st.none(), count),
        "failed": st.one_of(st.none(), count),
        "totalFailedNames": count,
        "failingTests": st.lists(failing_test, max_size=5),
        "outputTruncated": st.booleans(),
        "durationMs": st.one_of(st.integers(0, 10**6), st.floats(0, 10**6, allow_nan=False)),
    }
)

# --- ActionResult ---

details = st.one_of(
    st.fixed_dictionaries({"kind": st.just("file_opened"), "relativePath": relative_path}),
    with_optional(
        {
            "kind": st.just("diagnostic_reached"),
            "relativePath": relative_path,
            "line": positive,
            "severity": safe_text,
            "message": safe_text,
        },
        {"symbol": safe_text, "wrapped": st.booleans()},
    ),
    st.fixed_dictionaries(
        {"kind": st.just("location_reached"), "relativePath": relative_path, "line": positive}
    ),
    st.fixed_dictionaries(
        {
            "kind": st.just("ambiguous_files"),
            "matches": st.lists(relative_path, max_size=10),
            "totalMatches": count,
        }
    ),
    st.fixed_dictionaries({"kind": st.just("test_run"), "summary": test_run_summary}),
)

APPROVED_ACTIONS = [
    "NO_ACTION",
    "GO_TO_DIAGNOSTIC",
    "NEXT_DIAGNOSTIC",
    "PREVIOUS_DIAGNOSTIC",
    "OPEN_FILE",
    "GO_TO_LINE",
    "FOCUS_EDITOR",
    "RUN_TESTS",
]
action_type_string = st.one_of(
    st.sampled_from(APPROVED_ACTIONS),
    st.text(alphabet=string.ascii_uppercase + "_", min_size=1, max_size=20),
    safe_text,
)

action_result = with_optional(
    {
        "actionType": action_type_string,
        "status": st.sampled_from(
            ["ok", "failed", "declined", "not_permitted", "needs_clarification", "not_configured"]
        ),
        "message": safe_text,
    },
    {"details": details},
)

# --- action envelope: object with a string type, extras kept untouched ---

json_scalar = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(-10_000, 10_000),
    st.floats(-1e6, 1e6, allow_nan=False, allow_infinity=False),
    safe_text,
)
json_value = st.recursive(
    json_scalar,
    lambda children: st.one_of(
        st.lists(children, max_size=3),
        st.dictionaries(st.text(alphabet=string.ascii_lowercase, min_size=1, max_size=6), children, max_size=3),
    ),
    max_leaves=6,
)
extra_key = st.text(alphabet=string.ascii_lowercase, min_size=1, max_size=8).filter(lambda k: k != "type")
extras = st.dictionaries(extra_key, json_value, max_size=3)

action_envelope = st.one_of(
    st.builds(lambda name, more: {"type": name, **more}, st.sampled_from(APPROVED_ACTIONS), extras),
    st.builds(
        lambda name, more: {"type": name, **more},
        st.text(alphabet=string.ascii_uppercase + "_", min_size=1, max_size=20),
        extras,
    ),
    st.builds(lambda command, more: {**more, "type": "RUN_TESTS", "command": command}, safe_text, extras),
    st.just({"type": "NO_ACTION"}),
)

# --- one strategy per message type ---


def message(message_type: str, required: dict[str, Any], optional: dict[str, Any] | None = None):
    base = {"version": st.just(1), "type": st.just(message_type), **required}
    return with_optional(base, optional or {})


MESSAGE_STRATEGIES: dict[str, st.SearchStrategy[dict[str, Any]]] = {
    "hello": message("hello", {"client": st.just("kirosight-extension")}, {"token": safe_text}),
    "hello_ack": message(
        "hello_ack",
        {
            "supportedVersions": st.lists(st.integers(1, 5), max_size=4),
            "capabilities": st.fixed_dictionaries(
                {
                    "bedrock": st.booleans(),
                    "stt": st.booleans(),
                    "tts": st.booleans(),
                    "mic": st.sampled_from(["available", "unavailable", "denied", "not_applicable"]),
                }
            ),
        },
    ),
    "agent_request": message(
        "agent_request",
        {
            "id": ident,
            "kind": st.sampled_from(["utterance", "summarize_test_run"]),
            "context": wire_context,
        },
        {"utterance": utterance, "testRun": test_run_summary},
    ),
    "agent_response": message(
        "agent_response",
        {
            "replyTo": ident,
            "speech": st.text(alphabet=SAFE_ALPHABET, max_size=120),
            "action": action_envelope,
            "confirmationRequired": st.booleans(),
        },
    ),
    "action_request": message(
        "action_request", {"id": ident, "action": action_envelope, "reason": safe_text}
    ),
    "action_result": message("action_result", {"replyTo": ident, "result": action_result}),
    "record_start": message("record_start", {"id": ident}),
    "record_stop": message("record_stop", {"id": ident}),
    "audio_clip": message("audio_clip", {"id": ident, "mimeType": mime, "base64": base64_like}),
    "transcription_result": message("transcription_result", {"replyTo": ident, "text": safe_text}),
    "speech_request": message("speech_request", {"id": ident, "text": safe_text}, {"replyTo": ident}),
    "speech_audio": message("speech_audio", {"replyTo": ident, "mimeType": mime, "base64": base64_like}),
    "cancel": message("cancel", {"targetId": ident}),
    "error_message": message(
        "error_message",
        {
            "code": st.sampled_from(ERROR_CODES),
            "message": safe_text,
            "recoverable": st.booleans(),
        },
        {"replyTo": ident},
    ),
}


# --- the property ---


def round_trip(raw: dict[str, Any]) -> None:
    snapshot = copy.deepcopy(raw)

    first = parse_message(raw)
    assert not isinstance(first, ProtocolValidationError), first
    assert raw == snapshot, "parsing must not mutate its input"

    canonical_first = dump_message(first)
    canonical_first_copy = copy.deepcopy(canonical_first)

    wire_text = json.dumps(canonical_first)
    second = parse_message(json.loads(wire_text))
    assert not isinstance(second, ProtocolValidationError), second
    assert canonical_first == canonical_first_copy, "serializing must not mutate the first result"

    canonical_second = dump_message(second)
    assert canonical_first == canonical_second
    assert canonical_second["type"] == raw["type"]
    assert canonical_second["version"] == 1
    # Nothing was lost or changed relative to the generated wire message.
    assert canonical_second == raw
    assert type(first) is type(second)


def test_strategies_cover_exactly_the_fourteen_message_types() -> None:
    assert len(BACKEND_MESSAGE_TYPES) == 14
    assert set(MESSAGE_STRATEGIES) == set(BACKEND_MESSAGE_TYPES)


@pytest.mark.parametrize("message_type", BACKEND_MESSAGE_TYPES)
@settings(max_examples=EXAMPLES)
@given(data=st.data())
def test_property_7_each_message_type_round_trips(message_type: str, data: st.DataObject) -> None:
    round_trip(data.draw(MESSAGE_STRATEGIES[message_type]))


@settings(max_examples=EXAMPLES)
@given(raw=st.one_of(*MESSAGE_STRATEGIES.values()))
def test_property_7_any_message_type_round_trips(raw: dict[str, Any]) -> None:
    round_trip(raw)


@settings(max_examples=EXAMPLES)
@given(raw=st.one_of(*MESSAGE_STRATEGIES.values()), numeric_one=st.sampled_from([1, 1.0]))
def test_property_7_numeric_one_versions_normalize_to_canonical_one(
    raw: dict[str, Any], numeric_one: Any
) -> None:
    """A decoded version of 1.0 is the supported version and round-trips as the integer 1."""
    first = parse_message({**raw, "version": numeric_one})
    assert not isinstance(first, ProtocolValidationError), first
    wire = json.dumps(dump_message(first))
    assert json.loads(wire)["version"] == 1 and type(json.loads(wire)["version"]) is int
    second = parse_message(json.loads(wire))
    assert not isinstance(second, ProtocolValidationError)
    assert dump_message(second) == dump_message(first)


def _integer_paths(value: Any, prefix: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    """Paths of integer values in a generated message, excluding version and plain-number fields."""
    if isinstance(value, bool):
        return []
    if isinstance(value, int):
        return [prefix]
    paths: list[tuple[Any, ...]] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ("version", "durationMs"):
                continue
            paths += _integer_paths(item, (*prefix, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            paths += _integer_paths(item, (*prefix, index))
    return paths


def _get(value: Any, path: tuple[Any, ...]) -> Any:
    for part in path:
        value = value[part]
    return value


@settings(max_examples=EXAMPLES)
@given(raw=MESSAGE_STRATEGIES["agent_request"], data=st.data())
def test_property_7_integral_float_equals_integer_on_the_wire(raw: dict[str, Any], data: st.DataObject) -> None:
    """JSON 5 and 5.0 are one wire value: swapping one integer for its float form normalizes back."""
    path = data.draw(st.sampled_from(_integer_paths(raw)))  # context counts guarantee a non-empty list
    swapped = copy.deepcopy(raw)
    parent = _get(swapped, path[:-1])
    parent[path[-1]] = float(parent[path[-1]])

    first = parse_message(json.loads(json.dumps(swapped)))
    assert not isinstance(first, ProtocolValidationError), first
    canonical = dump_message(first)
    assert canonical == raw  # normalized back to the original integer wire message
    assert type(_get(canonical, path)) is int
    second = parse_message(json.loads(json.dumps(canonical)))
    assert not isinstance(second, ProtocolValidationError)
    assert dump_message(second) == canonical


@settings(max_examples=EXAMPLES)
@given(raw=MESSAGE_STRATEGIES["agent_response"])
def test_property_7_action_envelope_extras_survive(raw: dict[str, Any]) -> None:
    again = parse_message(json.loads(json.dumps(dump_message(parse_message(raw)))))
    assert not isinstance(again, ProtocolValidationError)
    assert dump_message(again)["action"] == raw["action"]
