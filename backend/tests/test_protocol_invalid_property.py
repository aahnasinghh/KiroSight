"""Task 6.11 / Property 8: invalid protocol messages are rejected without dispatch (Python side).

Every invalid input is built from a VALID shared fixture plus ONE controlled mutation that violates
the accepted schema by construction (the replacement values are drawn from pools that can never be
valid for the targeted field). Each property asserts:

* ``parse_message`` returns a ``ProtocolValidationError`` (it never raises),
* a test-only dispatch sentinel was never called,
* the stable error category where the validator defines one.

No production dispatcher exists yet, so the sentinel lives in this file only. Nothing here imports
or calls the allow-list or any action code.
"""

from __future__ import annotations

import copy
import json
import string
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings, strategies as st

from app.protocol.messages import BACKEND_MESSAGE_TYPES
from app.protocol.validators import ProtocolValidationError, parse_message
from tests._protocol_integer_fields import BASES, INTEGER_FIELDS, IntegerField, set_at

EXAMPLES = 100
FIXTURES = (
    Path(__file__).resolve().parents[2] / "extension" / "src" / "protocol" / "fixtures" / "messages"
)
VF = "VALIDATION_FAILED"
UV = "UNSUPPORTED_VERSION"
UT = "UNKNOWN_TYPE"

Draw = Callable[[st.SearchStrategy[Any]], Any]
Message = dict[str, Any]
Mutation = tuple[str, Callable[[Message, Draw], None], str]

# --- test-only dispatch sentinel ---


class Dispatcher:
    """Stands in for "act on a message". Counts calls; does nothing else."""

    def __init__(self) -> None:
        self.count = 0

    def dispatch(self, message: object) -> None:
        self.count += 1


def validate_then_dispatch(raw: Any, dispatcher: Dispatcher) -> Any:
    result = parse_message(raw)  # called directly: an exception here fails the property
    if not isinstance(result, ProtocolValidationError):
        dispatcher.dispatch(result)
    return result


def assert_rejected(raw: Any, expected_code: str | None = None) -> ProtocolValidationError:
    dispatcher = Dispatcher()
    result = validate_then_dispatch(raw, dispatcher)
    assert isinstance(result, ProtocolValidationError), "an invalid message was accepted"
    assert dispatcher.count == 0, "an invalid message was dispatched"
    if expected_code is not None:
        assert result.code == expected_code
    return result


# --- fixtures and value pools ---


def fixture(name: str) -> Message:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


word = st.text(alphabet=string.ascii_lowercase, min_size=1, max_size=8)
number = st.integers(1, 40)
unknown_string = word.map(lambda w: "~" + w)  # '~' starts no valid enum / literal in the schemas
text = st.text(alphabet=string.ascii_letters + string.digits + " _-.", max_size=12)
finite_float = st.floats(allow_nan=False, allow_infinity=False)
small_int = st.integers(-1000, 1000)
small_list = st.lists(small_int, max_size=2)
small_dict = st.dictionaries(word, small_int, max_size=2)
non_str = st.one_of(st.none(), st.booleans(), small_int, finite_float, small_list, small_dict)
non_str_scalar = st.one_of(st.none(), st.booleans(), small_int, finite_float)
non_bool_scalar = st.one_of(st.none(), text, small_int, finite_float)
non_object = st.one_of(st.none(), st.booleans(), small_int, finite_float, text, small_list)
non_list = st.one_of(st.none(), st.booleans(), small_int, finite_float, text, small_dict)
absolute_prefix = st.sampled_from(["/", "C:\\", "c:/", "Z:\\", "\\\\"])
absolute_path = st.builds(lambda p, w: p + w, absolute_prefix, word)
fractional = number.map(lambda n: n + 0.5)  # never an integer
non_positive = st.integers(-10_000, 0)
negative = st.integers(-10_000, -1)

WRONG_VALUE: dict[str, st.SearchStrategy[Any]] = {
    "str": non_str,
    "bool": st.one_of(st.none(), text, small_int, finite_float, small_list, small_dict),
    "obj": non_object,
    "arr": non_list,
    "enum": st.one_of(non_str, unknown_string),
}

REQUIRED: dict[str, dict[str, str]] = {
    "hello": {"client": "enum"},
    "hello_ack": {"supportedVersions": "arr", "capabilities": "obj"},
    "agent_request": {"id": "str", "kind": "enum", "context": "obj"},
    "agent_response": {"replyTo": "str", "speech": "str", "action": "obj", "confirmationRequired": "bool"},
    "action_request": {"id": "str", "action": "obj", "reason": "str"},
    "action_result": {"replyTo": "str", "result": "obj"},
    "record_start": {"id": "str"},
    "record_stop": {"id": "str"},
    "audio_clip": {"id": "str", "mimeType": "str", "base64": "str"},
    "transcription_result": {"replyTo": "str", "text": "str"},
    "speech_request": {"id": "str", "text": "str"},
    "speech_audio": {"replyTo": "str", "mimeType": "str", "base64": "str"},
    "cancel": {"targetId": "str"},
    "error_message": {"code": "enum", "message": "str", "recoverable": "bool"},
}

EXTRA_KEYS = ["command", "shell", "debug", "unexpected", "seq", "final", "activeFile"]

# The supported version is the JSON NUMBER 1, which Python decodes as 1 or 1.0 (same value as
# JavaScript's single Number 1). So numbers equal to 1 are VALID and excluded by construction below;
# bool (a subclass of int), strings, null, containers and every other number are invalid.
VALID_VERSION_SPELLINGS = [1, 1.0]
WRONG_VERSION = st.one_of(
    small_int.filter(lambda v: v != 1),
    st.integers(2**40, 2**60),
    text,
    finite_float.filter(lambda v: v != 1),  # 1.0 == 1, so this never yields a valid version
    st.booleans(),
    st.none(),
    small_list,
    small_dict,
)


# --- generic mutations, applicable to every message type ---


def generic_mutations(message_type: str) -> list[Mutation]:
    required = REQUIRED[message_type]
    names = sorted(required)

    def remove_version(m: Message, d: Draw) -> None:
        del m["version"]

    def wrong_version(m: Message, d: Draw) -> None:
        m["version"] = d(WRONG_VERSION)

    def remove_type(m: Message, d: Draw) -> None:
        del m["type"]

    def non_string_type(m: Message, d: Draw) -> None:
        m["type"] = d(non_str)

    def unknown_type(m: Message, d: Draw) -> None:
        m["type"] = d(word.filter(lambda w: w not in BACKEND_MESSAGE_TYPES))

    def extra_top_level(m: Message, d: Draw) -> None:
        key = d(st.one_of(st.sampled_from(EXTRA_KEYS), word))
        if key in m:
            key += "_x"
        m[key] = d(st.one_of(non_str_scalar, text))

    def remove_required(m: Message, d: Draw) -> None:
        del m[d(st.sampled_from(names))]

    def wrong_type(m: Message, d: Draw) -> None:
        field = d(st.sampled_from(names))
        m[field] = d(WRONG_VALUE[required[field]])

    return [
        ("remove_version", remove_version, VF),
        ("wrong_version", wrong_version, UV),
        ("remove_type", remove_type, VF),
        ("non_string_type", non_string_type, VF),
        ("unknown_type", unknown_type, UT),
        ("extra_top_level_field", extra_top_level, VF),
        ("remove_required_field", remove_required, VF),
        ("wrong_required_field_type", wrong_type, VF),
    ]


# --- malformed action envelopes (unknown action NAMES are not malformed) ---


def bad_action(d: Draw) -> Any:
    return d(
        st.one_of(
            st.none(),
            text,
            small_int,
            st.booleans(),
            small_list,
            st.just({}),
            non_str.map(lambda v: {"type": v}),
            st.dictionaries(word.filter(lambda k: k != "type"), small_int, min_size=1, max_size=2),
        )
    )


def action_mutation(m: Message, d: Draw) -> None:
    m["action"] = bad_action(d)


# --- test run summary ---

VALID_TEST_RUN: Message = {
    "outcome": "failed",
    "command": "npm test",
    "exitCode": 1,
    "passed": 3,
    "failed": 1,
    "totalFailedNames": 1,
    "failingTests": [{"name": "sample test", "messageExcerpt": "expected 1"}],
    "outputTruncated": False,
    "durationMs": 1200,
}
SUMMARY_REQUIRED = [
    "outcome", "command", "exitCode", "passed", "failed", "totalFailedNames",
    "failingTests", "outputTruncated", "durationMs",
]  # fmt: skip


def summary_mutations() -> list[tuple[str, Callable[[Message, Draw], None]]]:
    def count_field(s: Message, d: Draw, value: st.SearchStrategy[Any]) -> None:
        s[d(st.sampled_from(["passed", "failed", "totalFailedNames"]))] = d(value)

    return [
        ("unknown_outcome", lambda s, d: s.__setitem__("outcome", d(st.one_of(unknown_string, non_str)))),
        ("negative_count", lambda s, d: count_field(s, d, negative)),
        ("fractional_count", lambda s, d: count_field(s, d, fractional)),
        ("wrong_type_count", lambda s, d: count_field(s, d, st.one_of(text, st.booleans(), small_list))),
        (
            "too_many_failing_tests",
            lambda s, d: s.__setitem__("failingTests", [{"name": "t"} for _ in range(20 + d(number))]),
        ),
        ("failing_test_missing_name", lambda s, d: s.__setitem__("failingTests", [{"messageExcerpt": "x"}])),
        ("failing_test_name_wrong_type", lambda s, d: s.__setitem__("failingTests", [{"name": d(non_str)}])),
        (
            "failing_test_extra_field",
            lambda s, d: s.__setitem__("failingTests", [{"name": "t", "x" + d(word): d(small_int)}]),
        ),
        (
            "excerpt_wrong_type",
            lambda s, d: s.__setitem__("failingTests", [{"name": "t", "messageExcerpt": d(non_str)}]),
        ),
        ("failing_tests_not_a_list", lambda s, d: s.__setitem__("failingTests", d(non_list))),
        ("command_wrong_type", lambda s, d: s.__setitem__("command", d(non_str))),
        ("exit_code_wrong", lambda s, d: s.__setitem__("exitCode", d(st.one_of(text, st.booleans(), fractional)))),
        ("duration_negative", lambda s, d: s.__setitem__("durationMs", d(st.floats(max_value=-0.5, allow_infinity=False)))),
        ("duration_wrong_type", lambda s, d: s.__setitem__("durationMs", d(st.one_of(text, st.booleans(), st.none())))),
        ("truncated_wrong_type", lambda s, d: s.__setitem__("outputTruncated", d(non_bool_scalar))),
        ("summary_extra_field", lambda s, d: s.update({"x" + d(word): d(small_int)})),
        ("summary_missing_field", lambda s, d: s.pop(d(st.sampled_from(SUMMARY_REQUIRED)))),
    ]  # fmt: skip


SUMMARY = summary_mutations()


def apply_summary_mutation(summary: Message, d: Draw) -> None:
    _, fn = d(st.sampled_from(SUMMARY))
    fn(summary, d)


# --- IDEContext ---


def context_mutations() -> list[tuple[str, Callable[[Message, Draw], None]]]:
    def diag(c: Message) -> Message:
        return c["diagnostics"][0]

    def set_in(target_getter: Callable[[Message], Message], key: str, value_strategy: st.SearchStrategy[Any]):
        return lambda c, d: target_getter(c).__setitem__(key, d(value_strategy))

    return [
        ("absolute_relative_path", set_in(lambda c: c, "relativePath", absolute_path)),
        ("absolute_diagnostic_path", set_in(diag, "relativePath", absolute_path)),
        ("cursor_line_not_positive", set_in(lambda c: c["cursor"], "line", non_positive)),
        ("cursor_column_not_positive", set_in(lambda c: c["cursor"], "column", non_positive)),
        ("cursor_fractional", set_in(lambda c: c["cursor"], "line", fractional)),
        ("cursor_wrong_type", set_in(lambda c: c["cursor"], "column", st.one_of(text, st.booleans(), st.none()))),
        (
            "selection_bad_shape",
            lambda c, d: c.__setitem__(
                "selection",
                d(
                    st.sampled_from(
                        [
                            {"isEmpty": "yes"},
                            {"isEmpty": False},
                            {"isEmpty": True, "start": {"line": 1, "column": 1}},
                            {"start": {"line": 1, "column": 1}, "end": {"line": 1, "column": 1}},
                            5,
                            "x",
                            [],
                        ]
                    )
                ),
            ),
        ),
        ("nearby_text_too_long", lambda c, d: c["nearbyCode"].__setitem__("text", "x" * (6000 + d(number)))),
        ("nearby_unknown_source", set_in(lambda c: c["nearbyCode"], "source", unknown_string)),
        ("nearby_truncated_wrong_type", set_in(lambda c: c["nearbyCode"], "truncated", non_bool_scalar)),
        ("nearby_start_line_zero", set_in(lambda c: c["nearbyCode"], "startLine", non_positive)),
        ("nearby_extra_field", lambda c, d: c["nearbyCode"].__setitem__("x" + d(word), d(small_int))),
        ("symbol_missing_name", lambda c, d: c["currentSymbol"].pop("name")),
        ("symbol_kind_wrong_type", set_in(lambda c: c["currentSymbol"], "kind", non_str)),
        ("symbol_line_not_positive", set_in(lambda c: c["currentSymbol"], "startLine", non_positive)),
        ("unknown_symbol_status", set_in(lambda c: c, "symbolStatus", st.one_of(unknown_string, non_str))),
        (
            "too_many_diagnostics",
            lambda c, d: c.__setitem__("diagnostics", [copy.deepcopy(diag(c)) for _ in range(25 + d(number))]),
        ),
        ("diagnostic_bad_severity", set_in(diag, "severity", st.one_of(unknown_string, non_str))),
        ("diagnostic_message_too_long", lambda c, d: diag(c).__setitem__("message", "x" * (500 + d(number)))),
        ("diagnostic_line_not_positive", set_in(diag, "line", non_positive)),
        ("diagnostic_extra_field", lambda c, d: diag(c).__setitem__("x" + d(word), d(small_int))),
        ("diagnostic_source_null", lambda c, d: diag(c).__setitem__("source", None)),
        ("diagnostic_code_wrong_type", set_in(diag, "code", non_str)),
        ("counts_negative", lambda c, d: c["diagnosticCounts"].__setitem__(d(st.sampled_from(["error", "warning", "information", "hint"])), d(negative))),
        ("counts_missing_key", lambda c, d: c["diagnosticCounts"].pop(d(st.sampled_from(["error", "warning", "information", "hint"])))),
        ("counts_extra_key", lambda c, d: c["diagnosticCounts"].__setitem__("x" + d(word), d(small_int))),
        ("counts_fractional", lambda c, d: c["diagnosticCounts"].__setitem__("error", d(fractional))),
        ("workspace_root_negative", set_in(lambda c: c["workspace"], "rootCount", negative)),
        ("workspace_name_wrong_type", set_in(lambda c: c["workspace"], "name", st.one_of(small_int, st.booleans(), small_list))),
        ("workspace_extra_field", lambda c, d: c["workspace"].__setitem__("x" + d(word), d(small_int))),
        ("absolute_path_field", lambda c, d: c.__setitem__(d(st.sampled_from(["activeFile", "fsPath", "absolutePath", "workspaceRootPath"])), d(text))),
        ("context_extra_field", lambda c, d: c.__setitem__("x" + d(word), d(small_int))),
        (
            "context_missing_field",
            lambda c, d: c.pop(
                d(
                    st.sampled_from(
                        [
                            "workspace", "relativePath", "languageId", "cursor", "selection", "nearbyCode",
                            "currentSymbol", "symbolStatus", "diagnostics", "diagnosticCounts",
                        ]  # fmt: skip
                    )
                )
            ),
        ),
    ]  # fmt: skip


CONTEXT = context_mutations()


def context_mutation(m: Message, d: Draw) -> None:
    _, fn = d(st.sampled_from(CONTEXT))
    fn(m["context"], d)


# --- action_result details ---

DETAILS_BASES: dict[str, Message] = {
    "file_opened": {"kind": "file_opened", "relativePath": "src/a.ts"},
    "diagnostic_reached": {
        "kind": "diagnostic_reached",
        "relativePath": "src/a.ts",
        "line": 3,
        "severity": "error",
        "message": "m",
        "symbol": "s",
        "wrapped": False,
    },
    "location_reached": {"kind": "location_reached", "relativePath": "src/a.ts", "line": 3},
    "ambiguous_files": {"kind": "ambiguous_files", "matches": ["a/x.ts", "b/x.ts"], "totalMatches": 2},
    "test_run": {"kind": "test_run", "summary": VALID_TEST_RUN},
}


def details_mutation(m: Message, d: Draw) -> None:
    kind = d(st.sampled_from(sorted(DETAILS_BASES)))
    x = copy.deepcopy(DETAILS_BASES[kind])

    def generic(choice: int) -> None:
        if choice == 0:
            x["x" + d(word)] = d(small_int)
        elif choice == 1:
            x["kind"] = d(st.one_of(unknown_string, non_str))
        else:
            m["result"]["details"] = d(non_object)

    per_kind: dict[str, list[Callable[[], None]]] = {
        "file_opened": [
            lambda: x.pop("relativePath"),
            lambda: x.__setitem__("relativePath", d(absolute_path)),
            lambda: x.__setitem__("relativePath", d(non_str)),
        ],
        "diagnostic_reached": [
            lambda: x.__setitem__("wrapped", d(non_bool_scalar)),
            lambda: x.__setitem__("symbol", d(non_str)),
            lambda: x.__setitem__("line", d(non_positive)),
            lambda: x.__setitem__("severity", d(non_str)),
            lambda: x.__setitem__("message", d(non_str)),
            lambda: x.__setitem__("relativePath", d(absolute_path)),
            lambda: x.pop("line"),
        ],
        "location_reached": [
            lambda: x.__setitem__("line", d(non_positive)),
            lambda: x.__setitem__("line", d(fractional)),
            lambda: x.__setitem__("relativePath", d(absolute_path)),
        ],
        "ambiguous_files": [
            lambda: x.__setitem__("matches", [f"f{i}.ts" for i in range(10 + d(number))]),
            lambda: x.__setitem__("matches", ["ok.ts", d(absolute_path)]),
            lambda: x.__setitem__("matches", d(non_list)),
            lambda: x.__setitem__("totalMatches", d(negative)),
            lambda: x.__setitem__("totalMatches", d(fractional)),
            lambda: x.pop("matches"),
        ],
        "test_run": [
            lambda: apply_summary_mutation(x["summary"], d),
            lambda: x.pop("summary"),
            lambda: x.__setitem__("summary", d(non_object)),
        ],
    }
    choices = per_kind[kind]
    m["result"]["details"] = x  # set first: the generic "not an object" case replaces it below
    pick = d(st.integers(0, len(choices) + 2))
    if pick < len(choices):
        choices[pick]()
    else:
        generic(pick - len(choices))


def result_mutation(m: Message, d: Draw) -> None:
    result = m["result"]
    which = d(st.integers(0, 9))
    if which == 0:
        m["result"] = d(non_object)
    elif which == 1:
        result["status"] = d(st.one_of(unknown_string, non_str))
    elif which == 2:
        result.pop(d(st.sampled_from(["actionType", "status", "message"])))
    elif which == 3:
        result["actionType"] = d(non_str)
    elif which == 4:
        result["message"] = d(non_str)
    elif which == 5:
        result["x" + d(word)] = d(small_int)
    elif which == 6:
        result["details"] = None  # optional but not nullable
    elif which == 7:
        result["details"] = d(non_object)
    else:
        details_mutation(m, d)


# --- per-type specific mutations ---


def agent_request_base_with_test_run() -> Message:
    message = fixture("agent_request")
    message["kind"] = "summarize_test_run"
    message["testRun"] = copy.deepcopy(VALID_TEST_RUN)
    return message


def specific_mutations(message_type: str) -> list[Mutation]:
    def m(name: str, fn: Callable[[Message, Draw], None], code: str = VF) -> Mutation:
        return (name, fn, code)

    if message_type == "hello":
        return [
            m("client_not_the_literal", lambda x, d: x.__setitem__("client", d(st.one_of(unknown_string, non_str)))),
            m("token_wrong_type", lambda x, d: x.__setitem__("token", d(non_str))),
        ]
    if message_type == "hello_ack":
        caps = lambda x: x["capabilities"]  # noqa: E731
        return [
            m(
                "supported_versions_bad_elements",
                lambda x, d: x.__setitem__(
                    "supportedVersions",
                    d(
                        st.sampled_from(
                            [["1"], [True], [1.5], [None], [[1]], [1, "2"], "1", {"0": 1}]
                        )
                    ),
                ),
            ),
            m("capability_flag_wrong_type", lambda x, d: caps(x).__setitem__(d(st.sampled_from(["bedrock", "stt", "tts"])), d(WRONG_VALUE["bool"]))),
            m("mic_not_a_known_value", lambda x, d: caps(x).__setitem__("mic", d(st.one_of(unknown_string, non_str)))),
            m("capability_extra_field", lambda x, d: caps(x).__setitem__("x" + d(word), d(small_int))),
            m("capability_missing_field", lambda x, d: caps(x).pop(d(st.sampled_from(["bedrock", "stt", "tts", "mic"])))),
        ]
    if message_type == "agent_request":
        def utterance(x: Message) -> Message:
            return x["utterance"]

        return [
            m("unknown_kind", lambda x, d: x.__setitem__("kind", d(st.one_of(unknown_string, non_str)))),
            m("utterance_text_wrong_type", lambda x, d: utterance(x).__setitem__("text", d(non_str))),
            m("utterance_text_too_long", lambda x, d: utterance(x).__setitem__("text", "x" * (4000 + d(number)))),
            m("utterance_unknown_source", lambda x, d: utterance(x).__setitem__("source", d(st.one_of(unknown_string, non_str)))),
            m("utterance_missing_text", lambda x, d: utterance(x).pop("text")),
            m("utterance_extra_field", lambda x, d: utterance(x).__setitem__("x" + d(word), d(small_int))),
            m("utterance_null", lambda x, d: x.__setitem__("utterance", None)),
            m("utterance_not_an_object", lambda x, d: x.__setitem__("utterance", d(non_object))),
            m("context_mutation", context_mutation),
            m("test_run_null", lambda x, d: x.__setitem__("testRun", None)),
            m("test_run_not_an_object", lambda x, d: x.__setitem__("testRun", d(non_object))),
            m(
                "test_run_mutation",
                lambda x, d: (x.update(agent_request_base_with_test_run()), apply_summary_mutation(x["testRun"], d))[1],
            ),
        ]
    if message_type == "agent_response":
        return [
            m("speech_too_long", lambda x, d: x.__setitem__("speech", "x" * (600 + d(number)))),
            m("action_envelope_malformed", action_mutation),
        ]
    if message_type == "action_request":
        return [m("action_envelope_malformed", action_mutation)]
    if message_type == "action_result":
        return [m("result_mutation", result_mutation)]
    if message_type == "speech_request":
        return [m("reply_to_wrong_type", lambda x, d: x.__setitem__("replyTo", d(non_str)))]
    if message_type == "error_message":
        return [
            m("unknown_error_code", lambda x, d: x.__setitem__("code", d(st.one_of(unknown_string, word.map(str.upper).filter(lambda c: c not in ERROR_CODE_SET), non_str)))),
            m("reply_to_wrong_type", lambda x, d: x.__setitem__("replyTo", d(non_str))),
        ]
    return []


ERROR_CODE_SET = {
    "VALIDATION_FAILED", "UNSUPPORTED_VERSION", "UNKNOWN_TYPE", "UNAUTHORIZED", "BEDROCK_UNAVAILABLE",
    "BEDROCK_INVALID_RESPONSE", "STT_UNAVAILABLE", "STT_NO_SPEECH", "TTS_UNAVAILABLE", "MIC_UNAVAILABLE",
    "MIC_DENIED", "CREDENTIAL_MISSING", "TIMEOUT", "CANCELLED", "INTERNAL",
}  # fmt: skip

ALL_MUTATIONS = {t: generic_mutations(t) + specific_mutations(t) for t in BACKEND_MESSAGE_TYPES}


def base_message(message_type: str) -> Message:
    return fixture(message_type)


# --- properties ---


def test_every_message_type_has_a_mutation_catalog() -> None:
    assert len(BACKEND_MESSAGE_TYPES) == 14
    assert set(ALL_MUTATIONS) == set(BACKEND_MESSAGE_TYPES)
    assert set(REQUIRED) == set(BACKEND_MESSAGE_TYPES)
    for message_type, mutations in ALL_MUTATIONS.items():
        assert len(mutations) >= 8, message_type


def test_fixture_bases_are_valid_before_mutation() -> None:
    for message_type in BACKEND_MESSAGE_TYPES:
        assert not isinstance(parse_message(base_message(message_type)), ProtocolValidationError)
    assert not isinstance(parse_message(agent_request_base_with_test_run()), ProtocolValidationError)


@pytest.mark.parametrize("message_type", BACKEND_MESSAGE_TYPES)
@settings(max_examples=EXAMPLES)
@given(data=st.data())
def test_property_8_each_message_type_rejects_one_controlled_mutation(
    message_type: str, data: st.DataObject
) -> None:
    name, mutate, expected_code = data.draw(st.sampled_from(ALL_MUTATIONS[message_type]))
    message = base_message(message_type)
    mutate(message, data.draw)
    assert_rejected(message, expected_code)


@pytest.mark.parametrize("message_type", BACKEND_MESSAGE_TYPES)
@settings(max_examples=EXAMPLES)
@given(data=st.data())
def test_property_8_version_problems(message_type: str, data: st.DataObject) -> None:
    message = base_message(message_type)
    if data.draw(st.booleans()):
        del message["version"]
        assert_rejected(message, VF)
    else:
        message["version"] = data.draw(WRONG_VERSION)
        assert_rejected(message, UV)


@pytest.mark.parametrize("message_type", BACKEND_MESSAGE_TYPES)
@settings(max_examples=EXAMPLES)
@given(version=st.sampled_from(VALID_VERSION_SPELLINGS))
def test_property_8_positive_control_numeric_one_is_protocol_valid(message_type: str, version: Any) -> None:
    """A decoded numeric 1 / 1.0 is a valid version, so it WOULD reach the dispatch sentinel."""
    message = base_message(message_type)
    message["version"] = version
    dispatcher = Dispatcher()
    result = validate_then_dispatch(message, dispatcher)
    assert not isinstance(result, ProtocolValidationError)
    assert dispatcher.count == 1
    assert type(result.version) is int and result.version == 1


@pytest.mark.parametrize("message_type", BACKEND_MESSAGE_TYPES)
@settings(max_examples=EXAMPLES)
@given(data=st.data())
def test_property_8_unknown_type_is_classified(message_type: str, data: st.DataObject) -> None:
    message = base_message(message_type)
    message["type"] = data.draw(
        st.one_of(
            word.filter(lambda w: w not in BACKEND_MESSAGE_TYPES),
            word.map(lambda w: w.upper()),
            st.sampled_from(["run_command", "ping", "ready", "execute", "", " hello", "hello "]),
            st.sampled_from(BACKEND_MESSAGE_TYPES).map(lambda t: t + "_x"),
        )
    )
    assert_rejected(message, UT)


@pytest.mark.parametrize("message_type", BACKEND_MESSAGE_TYPES)
@settings(max_examples=EXAMPLES)
@given(data=st.data())
def test_property_8_missing_or_non_string_type(message_type: str, data: st.DataObject) -> None:
    message = base_message(message_type)
    if data.draw(st.booleans()):
        del message["type"]
    else:
        message["type"] = data.draw(non_str)
    assert_rejected(message, VF)


@pytest.mark.parametrize("message_type", BACKEND_MESSAGE_TYPES)
@settings(max_examples=EXAMPLES)
@given(data=st.data())
def test_property_8_strict_top_level_rejects_any_extra_field(message_type: str, data: st.DataObject) -> None:
    message = base_message(message_type)
    key = data.draw(st.one_of(st.sampled_from(EXTRA_KEYS), word))
    if key in message:
        key += "_x"
    message[key] = data.draw(st.one_of(non_str, text))
    assert_rejected(message, VF)


def invalid_integer_value(field: IntegerField) -> st.SearchStrategy[Any]:
    """Values that are invalid for an integer field BY CONSTRUCTION.

    Integral floats (5.0) are VALID wherever 5 is (JSON has one number type), so they are never
    generated here. Invalid: fractions, booleans, strings, non-finite numbers, containers, values
    outside the safe-integer range, null for non-nullable fields, and below-minimum integers.
    """
    pools: list[st.SearchStrategy[Any]] = [
        fractional,
        st.booleans(),
        text,
        # Non-finite, and finite integral values just outside / far outside JavaScript's safe range
        # (MAX_SAFE_INTEGER + 1 as int and float, 1e20, +/-1e300, +/-2**60).
        st.sampled_from(
            [
                float("nan"), float("inf"), float("-inf"),
                2**53, float(2**53), -(2**53), -float(2**53),
                1e20, 1e300, -1e300, 2.0**60, 2**60, -(2**60),
            ]  # fmt: skip
        ),
        small_list,
        small_dict,
    ]
    if not field.nullable:
        pools.append(st.none())
    if field.minimum is not None:
        pools.append(st.integers(-10_000, field.minimum - 1))
        pools.append(st.integers(-10_000, field.minimum - 1).map(float))  # integral float, still below the bound
    return st.one_of(*pools)


@settings(max_examples=EXAMPLES)
@given(data=st.data())
def test_property_8_invalid_integer_values_are_rejected_in_every_integer_field(data: st.DataObject) -> None:
    field = data.draw(st.sampled_from(INTEGER_FIELDS))
    message = BASES[field.base]()
    set_at(message, field.path, data.draw(invalid_integer_value(field)))
    assert_rejected(message, VF)


@settings(max_examples=EXAMPLES)
@given(data=st.data())
def test_property_8_positive_control_integral_floats_are_valid_integers(data: st.DataObject) -> None:
    """An integral float is the same JSON number as the integer, so it IS dispatched."""
    field = data.draw(st.sampled_from(INTEGER_FIELDS))
    low = 0 if field.minimum is None else field.minimum
    value = data.draw(st.integers(low, low + 1000))
    message = BASES[field.base]()
    set_at(message, field.path, float(value))
    dispatcher = Dispatcher()
    result = validate_then_dispatch(message, dispatcher)
    assert not isinstance(result, ProtocolValidationError), field.label
    assert dispatcher.count == 1


@settings(max_examples=EXAMPLES)
@given(raw=st.one_of(st.none(), st.booleans(), small_int, finite_float, text, small_list))
def test_property_8_non_object_input_is_rejected(raw: Any) -> None:
    assert_rejected(raw, VF)


@pytest.mark.parametrize("message_type", ["agent_response", "action_request"])
@settings(max_examples=EXAMPLES)
@given(data=st.data())
def test_property_8_malformed_action_envelopes_are_rejected(message_type: str, data: st.DataObject) -> None:
    message = base_message(message_type)
    message["action"] = bad_action(data.draw)
    assert_rejected(message, VF)


@pytest.mark.parametrize("message_type", ["agent_response", "action_request"])
@settings(max_examples=EXAMPLES)
@given(data=st.data())
def test_property_8_boundary_unknown_action_names_are_not_protocol_errors(
    message_type: str, data: st.DataObject
) -> None:
    """Positive control: allow-list rejection is NOT the protocol's job, so these are dispatched."""
    name = data.draw(
        st.one_of(
            st.sampled_from(["RUN_COMMAND", "GO_TO_SYMBOL", "UNKNOWN_ACTION_FROM_MODEL"]),
            word.map(str.upper),
        )
    )
    extras = data.draw(st.dictionaries(word.filter(lambda k: k != "type"), small_int, max_size=2))
    message = base_message(message_type)
    message["action"] = {"type": name, **extras}
    dispatcher = Dispatcher()
    result = validate_then_dispatch(message, dispatcher)
    assert not isinstance(result, ProtocolValidationError)
    assert dispatcher.count == 1

    message["action"] = {"type": "RUN_TESTS", "command": data.draw(text)}
    assert not isinstance(parse_message(message), ProtocolValidationError)


@pytest.mark.parametrize("message_type", BACKEND_MESSAGE_TYPES)
@settings(max_examples=EXAMPLES)
@given(data=st.data(), marker_word=word)
def test_property_8_errors_never_echo_payload_values(
    message_type: str, data: st.DataObject, marker_word: str
) -> None:
    marker = f"ZQMK{marker_word}QZ"
    name, mutate, _ = data.draw(st.sampled_from(ALL_MUTATIONS[message_type]))
    message = base_message(message_type)
    taint(message, marker)
    mutate(message, data.draw)
    message["key_" + marker] = marker  # an unexpected property whose name and value are the marker
    error = assert_rejected(message)
    shown = repr(error) + json.dumps(error.paths)
    assert marker not in shown
    assert "ZQMK" not in shown


def taint(message: Message, marker: str) -> None:
    """Replace every string value except top-level ``type`` with the marker."""

    def walk(value: Any) -> Any:
        if isinstance(value, str):
            return marker
        if isinstance(value, list):
            return [walk(item) for item in value]
        if isinstance(value, dict):
            return {key: walk(item) for key, item in value.items()}
        return value

    for key in list(message):
        if key not in ("type", "version"):
            message[key] = walk(message[key])


json_leaf = st.one_of(st.none(), st.booleans(), small_int, finite_float, text)
json_any = st.recursive(
    json_leaf,
    lambda children: st.one_of(st.lists(children, max_size=3), st.dictionaries(text, children, max_size=3)),
    max_leaves=8,
)


@settings(max_examples=EXAMPLES)
@given(raw=json_any)
def test_property_8_arbitrary_json_never_makes_the_parser_raise(raw: Any) -> None:
    # No invalidity assumption: this only proves the public parser returns (never raises) and that
    # nothing is dispatched unless parsing succeeded.
    dispatcher = Dispatcher()
    result = validate_then_dispatch(raw, dispatcher)
    assert dispatcher.count == (0 if isinstance(result, ProtocolValidationError) else 1)
