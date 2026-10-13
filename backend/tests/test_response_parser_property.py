"""Task 7.4 / Property 22: agent output never yields an unsafe action.

Feature: kirosight-mvp, Property 22: For any raw model output (arbitrary strings, malformed JSON,
valid JSON of the wrong shape, valid responses with disallowed or extra-field actions),
``parse_agent_output`` returns either an ``AgentResponse`` whose action is allow-listed and
schema-valid, or a safe error with no action. It never raises and never returns an action outside
the allow-list. (Validates: Requirements 5.5, 5.6, 13.4)

Every property calls ``parse_agent_output`` directly, so an exception fails the property. Safety is
judged by an INDEPENDENT oracle written in this file (the eight action names, their parameter
fields and value rules, and the keys that must never appear), not by the registry the parser uses;
one test only checks that the oracle and the registry agree.

The sentence and length limit is Property 23 (Task 7.5) and is deliberately not asserted here.
"""

from __future__ import annotations

import json
from typing import Any, Final, get_args

from hypothesis import assume, example, given, settings, strategies as st

from app.agent.response_parser import (
    AGENT_FAILURE_MESSAGE,
    MAX_RAW_OUTPUT_CHARS,
    AgentFailure,
    FailureReason,
    parse_agent_output,
)
from app.allowlist import ALLOWED_ACTIONS
from app.protocol.messages import AgentResponse
from app.protocol.validators import parse_message

EXAMPLES = 100
SETTINGS = settings(max_examples=EXAMPLES, deadline=None)

# --- independent oracle ------------------------------------------------------------------------

EXPECTED_ACTIONS: Final = frozenset(
    {
        "NO_ACTION",
        "GO_TO_DIAGNOSTIC",
        "NEXT_DIAGNOSTIC",
        "PREVIOUS_DIAGNOSTIC",
        "OPEN_FILE",
        "GO_TO_LINE",
        "FOCUS_EDITOR",
        "RUN_TESTS",
    }
)
PARAM_FIELDS: Final[dict[str, frozenset[str]]] = {
    "NO_ACTION": frozenset(),
    "GO_TO_DIAGNOSTIC": frozenset({"index", "severity"}),
    "NEXT_DIAGNOSTIC": frozenset({"severity"}),
    "PREVIOUS_DIAGNOSTIC": frozenset({"severity"}),
    "OPEN_FILE": frozenset({"path"}),
    "GO_TO_LINE": frozenset({"line"}),
    "FOCUS_EDITOR": frozenset(),
    "RUN_TESTS": frozenset(),
}
REQUIRED_FIELDS: Final[dict[str, tuple[str, ...]]] = {
    "GO_TO_DIAGNOSTIC": ("index",),
    "OPEN_FILE": ("path",),
    "GO_TO_LINE": ("line",),
}
SEVERITIES: Final = ("error", "warning", "any")
MAX_SAFE_INTEGER: Final = 2**53 - 1
FORBIDDEN_KEYS: Final = (
    "command", "cmd", "shell", "args", "argv", "script", "exec", "executable", "run", "code",
    "commandLine", "program", "binary",
)
FAILURE_REASONS: Final = frozenset(get_args(FailureReason))
RESPONSE_KEYS: Final = {"version", "type", "replyTo", "speech", "action", "confirmationRequired"}


def is_int(value: object) -> bool:
    return type(value) is int


def assert_params_valid(action_type: str, extras: dict[str, Any]) -> None:
    """The oracle's own rule for every parameter value (independent of the registry)."""
    for key, value in extras.items():
        if key == "index":
            assert is_int(value) and 0 <= value <= MAX_SAFE_INTEGER
        elif key == "line":
            assert is_int(value) and 1 <= value <= MAX_SAFE_INTEGER
        elif key == "severity":
            assert value is None or value in SEVERITIES
        elif key == "path":
            assert isinstance(value, str) and 1 <= len(value) <= 256 and "\x00" not in value
        else:  # pragma: no cover - guarded by the PARAM_FIELDS subset check
            raise AssertionError(f"unexpected parameter {key!r}")
    for required in REQUIRED_FIELDS.get(action_type, ()):
        assert required in extras, f"{action_type} is missing {required}"


def assert_safe(result: object) -> None:
    """Property 22: a safe failure with no action, or an allow-listed, schema-valid action."""
    if isinstance(result, AgentFailure):
        assert result.reason in FAILURE_REASONS
        assert result.message == AGENT_FAILURE_MESSAGE
        assert result.error_code == "BEDROCK_INVALID_RESPONSE"
        assert not hasattr(result, "action")
        return

    assert isinstance(result, AgentResponse)
    action = result.action
    assert action.type in EXPECTED_ACTIONS
    extras = dict(action.model_extra or {})
    assert set(extras) <= PARAM_FIELDS[action.type]
    assert not set(extras) & set(FORBIDDEN_KEYS)
    assert_params_valid(action.type, extras)

    wire = result.model_dump(mode="json")
    assert set(wire) == RESPONSE_KEYS
    assert parse_message(json.loads(json.dumps(wire))) == result


# --- generators --------------------------------------------------------------------------------

word = st.text(alphabet="abcdefghijklmnopqrstuvwxyz", min_size=1, max_size=8)
plain_text = st.text(max_size=40)
# Includes lone surrogates, control characters, astral and combining characters.
wild_text = st.text(alphabet=st.characters(blacklist_categories=()), max_size=40)
any_text = st.one_of(plain_text, wild_text)
json_leaf = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(-(10**12), 10**12),
    st.floats(allow_nan=False, allow_infinity=False),
    any_text,
)
json_any = st.recursive(
    json_leaf,
    lambda children: st.one_of(
        st.lists(children, max_size=4),
        st.dictionaries(any_text, children, max_size=4),
    ),
    max_leaves=12,
)
json_object = st.dictionaries(any_text, json_any, max_size=5)

severity = st.sampled_from(SEVERITIES)
speech_text = st.text(
    alphabet=st.characters(blacklist_categories=("Cs", "Zs", "Cc", "Zl", "Zp")), min_size=1, max_size=60
)
path_text = st.text(
    alphabet=st.characters(blacklist_characters="\x00", blacklist_categories=("Cs",)),
    min_size=1,
    max_size=120,
)

# Every strategy below builds a FRESH dict per example: other strategies mutate the actions they
# draw, so a shared ``st.just({...})`` would leak edits between examples.
VALID_BY_TYPE: Final[dict[str, st.SearchStrategy[dict[str, Any]]]] = {
    "NO_ACTION": st.builds(lambda: {"type": "NO_ACTION"}),
    "FOCUS_EDITOR": st.builds(lambda: {"type": "FOCUS_EDITOR"}),
    "RUN_TESTS": st.builds(lambda: {"type": "RUN_TESTS"}),
    "GO_TO_DIAGNOSTIC": st.one_of(
        st.builds(lambda index: {"type": "GO_TO_DIAGNOSTIC", "index": index}, st.integers(0, MAX_SAFE_INTEGER)),
        st.builds(
            lambda index, sev: {"type": "GO_TO_DIAGNOSTIC", "index": index, "severity": sev},
            st.integers(0, 10**6),
            severity,
        ),
    ),
    "NEXT_DIAGNOSTIC": st.one_of(
        st.builds(lambda: {"type": "NEXT_DIAGNOSTIC"}),
        st.builds(lambda sev: {"type": "NEXT_DIAGNOSTIC", "severity": sev}, severity),
    ),
    "PREVIOUS_DIAGNOSTIC": st.one_of(
        st.builds(lambda: {"type": "PREVIOUS_DIAGNOSTIC"}),
        st.builds(lambda sev: {"type": "PREVIOUS_DIAGNOSTIC", "severity": sev}, severity),
    ),
    "OPEN_FILE": st.builds(lambda path: {"type": "OPEN_FILE", "path": path}, path_text),
    "GO_TO_LINE": st.builds(lambda line: {"type": "GO_TO_LINE", "line": line}, st.integers(1, MAX_SAFE_INTEGER)),
}
assert set(VALID_BY_TYPE) == EXPECTED_ACTIONS
valid_action = st.one_of(*VALID_BY_TYPE.values())


def envelope_of(action: dict[str, Any], speech: str, confirm: bool, reply_to: str) -> dict[str, Any]:
    return {
        "version": 1,
        "type": "agent_response",
        "replyTo": reply_to,
        "speech": speech,
        "action": action,
        "confirmationRequired": confirm,
    }


valid_envelopes = st.builds(envelope_of, valid_action, speech_text, st.booleans(), word)


@st.composite
def mutated_envelopes(draw: st.DrawFn) -> dict[str, Any]:
    """A valid envelope with one structural mutation. It may remain valid; the invariant holds."""
    envelope = draw(valid_envelopes)
    kind = draw(
        st.sampled_from(
            ["drop", "replace", "extra", "action_extra", "action_replace", "action_drop", "action_type"]
        )
    )
    key = draw(st.sampled_from(sorted(RESPONSE_KEYS)))
    if kind == "drop":
        del envelope[key]
    elif kind == "replace":
        envelope[key] = draw(json_any)
    elif kind == "extra":
        extra_key = draw(any_text.filter(lambda name: name not in RESPONSE_KEYS))
        envelope[extra_key] = draw(json_any)
    elif kind == "action_extra":
        extra_key = draw(st.one_of(st.sampled_from(FORBIDDEN_KEYS), any_text.filter(lambda n: n != "type")))
        envelope["action"][extra_key] = draw(json_any)
    elif kind == "action_replace":
        envelope["action"] = draw(json_any)
    elif kind == "action_drop":
        envelope["action"].pop(draw(st.sampled_from(sorted(envelope["action"]))), None)
    else:
        envelope["action"]["type"] = draw(json_any)
    return envelope


def encode(value: object, how: str) -> object:
    if how == "object":
        return value
    text = json.dumps(value)
    return text.encode("utf-8") if how == "bytes" else text


encodings = st.sampled_from(["object", "text", "bytes"])

cyclic: dict[str, Any] = {"version": 1}
cyclic["self"] = cyclic
cyclic_action = envelope_of({"type": "NO_ACTION"}, "Hello.", False, "r")
cyclic_action["action"]["loop"] = cyclic

arbitrary_objects = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(),
    st.floats(),
    st.text(),
    wild_text,
    st.binary(max_size=200),
    st.lists(json_any, max_size=4),
    st.tuples(json_any, json_any),
    st.sets(st.integers(), max_size=3),
    st.frozensets(st.integers(), max_size=3),
    st.just(object()),
    st.just(...),
    json_object,
)

raw_outputs = st.one_of(
    arbitrary_objects,
    st.builds(encode, json_any, encodings),
    st.builds(encode, mutated_envelopes(), encodings),
    st.builds(encode, valid_envelopes, encodings),
)


# --- Property 22 --------------------------------------------------------------------------------


@SETTINGS
@given(raw=raw_outputs)
@example(raw=cyclic)
@example(raw=cyclic_action)
def test_property_22_any_raw_output_is_a_safe_response_or_a_safe_failure(raw: object) -> None:
    # Feature: kirosight-mvp, Property 22: Agent output never yields an unsafe action
    assert_safe(parse_agent_output(raw))


@SETTINGS
@given(raw=raw_outputs, reply_to=st.one_of(st.none(), word))
def test_property_22_holds_with_a_caller_supplied_reply_to(raw: object, reply_to: str | None) -> None:
    result = parse_agent_output(raw, reply_to=reply_to)
    assert_safe(result)
    if isinstance(result, AgentResponse) and reply_to is not None:
        assert result.replyTo == reply_to  # a supplied correlation id is never overridden


@SETTINGS
@given(
    action=valid_action,
    speech=speech_text,
    confirm=st.booleans(),
    reply_to=word,
    how=encodings,
)
def test_property_22_positive_control_valid_allow_listed_output_passes_through(
    action: dict[str, Any], speech: str, confirm: bool, reply_to: str, how: str
) -> None:
    """The invariant is not met by always failing: valid output is accepted and not altered."""
    result = parse_agent_output(encode(envelope_of(action, speech, confirm, reply_to), how))

    assert isinstance(result, AgentResponse), result
    assert {"type": result.action.type, **(result.action.model_extra or {})} == action
    assert result.replyTo == reply_to
    assert result.confirmationRequired is confirm
    assert isinstance(result.speech, str)
    assert_safe(result)


# --- unsafe by construction: the result MUST be a failure ---------------------------------------

DANGEROUS_NAMES: Final = (
    "RUN_COMMAND", "GO_TO_SYMBOL", "EXECUTE", "SHELL", "EXEC", "RUN", "DELETE_FILE", "WRITE_FILE",
    "OPEN_URL", "SEND_KEYS", "EVAL", "GIT_PUSH", "INSTALL", "",
)


def case_or_space_variants(name: str) -> list[str]:
    variants = [name.lower(), name.title(), name.swapcase(), f" {name}", f"{name} ", f"{name}\n", f"{name}\x00"]
    return [variant for variant in variants if variant not in EXPECTED_ACTIONS]


disallowed_names = st.one_of(
    st.text(max_size=30).filter(lambda name: name not in EXPECTED_ACTIONS),
    st.sampled_from(DANGEROUS_NAMES),
    st.sampled_from(sorted(EXPECTED_ACTIONS)).flatmap(lambda name: st.sampled_from(case_or_space_variants(name))),
    st.sampled_from(sorted(EXPECTED_ACTIONS)).flatmap(lambda name: word.map(lambda tail: f"{name}_{tail}")),
)


@SETTINGS
@given(name=disallowed_names, params=st.dictionaries(word, json_any, max_size=4), how=encodings)
def test_property_22_actions_outside_the_allow_list_are_always_refused(
    name: str, params: dict[str, Any], how: str
) -> None:
    action = {**params, "type": name}
    result = parse_agent_output(encode(envelope_of(action, "Doing it.", False, "r"), how))

    assert isinstance(result, AgentFailure), result
    assert result.reason == "action_not_allowed"
    assert_safe(result)


@SETTINGS
@given(
    action=valid_action,
    key=st.one_of(st.sampled_from(FORBIDDEN_KEYS), word),
    value=json_any,
    how=encodings,
)
def test_property_22_extra_fields_on_an_allowed_action_are_always_refused(
    action: dict[str, Any], key: str, value: Any, how: str
) -> None:
    assume(key not in PARAM_FIELDS[action["type"]] and key != "type")  # only genuine extras
    result = parse_agent_output(encode(envelope_of({**action, key: value}, "Doing it.", False, "r"), how))

    assert isinstance(result, AgentFailure), result
    assert result.reason == "action_invalid"
    assert_safe(result)


INVALID_VALUES: Final[dict[str, st.SearchStrategy[Any]]] = {
    "index": st.one_of(
        st.integers(max_value=-1),
        st.integers(min_value=MAX_SAFE_INTEGER + 1),
        st.floats(allow_nan=False),
        st.booleans(),
        st.none(),
        st.text(max_size=10),
        st.lists(st.integers(), max_size=2),
        st.dictionaries(word, st.integers(), max_size=2),
    ),
    "line": st.one_of(
        st.integers(max_value=0),
        st.integers(min_value=MAX_SAFE_INTEGER + 1),
        st.floats(allow_nan=False),
        st.booleans(),
        st.none(),
        st.text(max_size=10),
        st.lists(st.integers(), max_size=2),
    ),
    "severity": st.one_of(
        st.text(max_size=12).filter(lambda value: value not in SEVERITIES),
        st.integers(),
        st.floats(allow_nan=False),
        st.booleans(),
        st.lists(st.text(max_size=4), max_size=2),
        st.dictionaries(word, st.integers(), max_size=2),
    ),
    "path": st.one_of(
        st.just(""),
        st.text(min_size=257, max_size=300, alphabet="ab"),
        st.builds(lambda a, b: f"{a}\x00{b}", word, word),
        st.integers(),
        st.booleans(),
        st.none(),
        st.lists(st.text(max_size=4), max_size=2),
    ),
}
PARAMETERIZED = sorted((name, field) for name, fields in PARAM_FIELDS.items() for field in fields)


@SETTINGS
@given(case=st.sampled_from(PARAMETERIZED), data=st.data(), how=encodings)
def test_property_22_invalid_parameter_values_are_always_refused(
    case: tuple[str, str], data: st.DataObject, how: str
) -> None:
    action_type, field = case
    base = data.draw(VALID_BY_TYPE[action_type])
    action = {**base, field: data.draw(INVALID_VALUES[field])}
    result = parse_agent_output(encode(envelope_of(action, "Doing it.", False, "r"), how))

    assert isinstance(result, AgentFailure), result
    assert result.reason == "action_invalid"
    assert_safe(result)


@SETTINGS
@given(action_type=st.sampled_from(sorted(REQUIRED_FIELDS)), how=encodings)
def test_property_22_missing_required_parameters_are_always_refused(action_type: str, how: str) -> None:
    result = parse_agent_output(encode(envelope_of({"type": action_type}, "Doing it.", False, "r"), how))

    assert isinstance(result, AgentFailure), result
    assert result.reason == "action_invalid"


@SETTINGS
@given(action_type=json_any.filter(lambda value: not isinstance(value, str)), how=encodings)
def test_property_22_a_non_string_action_type_is_refused(action_type: Any, how: str) -> None:
    result = parse_agent_output(encode(envelope_of({"type": action_type}, "Doing it.", False, "r"), how))

    assert isinstance(result, AgentFailure), result
    assert result.reason == "invalid_shape"


@SETTINGS
@given(action=json_any.filter(lambda value: not isinstance(value, dict)), how=encodings)
def test_property_22_a_non_object_action_is_refused(action: Any, how: str) -> None:
    result = parse_agent_output(encode(envelope_of(action, "Doing it.", False, "r"), how))

    assert isinstance(result, AgentFailure), result
    assert result.reason == "invalid_shape"


# --- malformed and wrong-shaped raw output ------------------------------------------------------


@SETTINGS
@given(envelope=valid_envelopes, cut=st.floats(min_value=0, max_value=0.999), bytes_form=st.booleans())
def test_property_22_truncated_json_is_always_refused(
    envelope: dict[str, Any], cut: float, bytes_form: bool
) -> None:
    text = json.dumps(envelope)
    truncated = text[: int(len(text) * cut)]  # always a proper prefix of an object, never valid JSON
    result = parse_agent_output(truncated.encode("utf-8") if bytes_form else truncated)

    assert isinstance(result, AgentFailure), result
    assert result.reason == "not_json"


@SETTINGS
@given(raw=st.text(max_size=60).filter(lambda text: not _is_json(text)))
def test_property_22_text_that_is_not_json_is_always_refused(raw: str) -> None:
    result = parse_agent_output(raw)

    assert isinstance(result, AgentFailure), result
    assert result.reason == "not_json"


def _is_json(text: str) -> bool:
    try:
        json.loads(text)
    except (ValueError, RecursionError):
        return False
    return True


@SETTINGS
@given(value=json_any.filter(lambda value: not isinstance(value, dict)), how=st.sampled_from(["text", "bytes"]))
def test_property_22_valid_json_that_is_not_an_object_is_always_refused(value: Any, how: str) -> None:
    result = parse_agent_output(encode(value, how))

    assert isinstance(result, AgentFailure), result
    assert result.reason == "not_object"


@SETTINGS
@given(value=st.one_of(st.none(), st.booleans(), st.integers(), st.lists(st.integers(), max_size=3), st.tuples(st.integers())))
def test_property_22_values_that_are_not_text_bytes_or_mappings_are_refused(value: Any) -> None:
    result = parse_agent_output(value)

    assert isinstance(result, AgentFailure), result
    assert result.reason == "not_object"


@SETTINGS
@given(offset=st.integers(-3, 3), filler=st.sampled_from(["x", " ", "{"]))
def test_property_22_the_raw_size_limit_is_exact(offset: int, filler: str) -> None:
    result = parse_agent_output(filler * (MAX_RAW_OUTPUT_CHARS + offset))

    assert isinstance(result, AgentFailure), result
    if offset > 0:
        assert result.reason == "too_large"
    else:
        assert result.reason != "too_large"


def _is_number_one(value: Any) -> bool:
    return type(value) in (int, float) and value == 1


#: For each envelope field, values that can never be valid for it (a different valid string or
#: boolean would still be a valid response, so those are excluded by construction).
INVALID_ENVELOPE_VALUES: Final[dict[str, st.SearchStrategy[Any]]] = {
    "version": json_any.filter(lambda value: not _is_number_one(value)),
    "type": json_any.filter(lambda value: value != "agent_response"),
    "replyTo": json_any.filter(lambda value: not isinstance(value, str)),
    "speech": json_any.filter(lambda value: not isinstance(value, str)),
    "action": json_any.filter(lambda value: not isinstance(value, dict)),
    "confirmationRequired": json_any.filter(lambda value: not isinstance(value, bool)),
}


@SETTINGS
@given(
    envelope=valid_envelopes,
    key=st.sampled_from(sorted(RESPONSE_KEYS)),
    drop=st.booleans(),
    data=st.data(),
    how=encodings,
)
def test_property_22_every_missing_or_retyped_envelope_field_is_refused(
    envelope: dict[str, Any], key: str, drop: bool, data: st.DataObject, how: str
) -> None:
    broken = dict(envelope)
    if drop:
        del broken[key]
    else:
        broken[key] = data.draw(INVALID_ENVELOPE_VALUES[key])
    result = parse_agent_output(encode(broken, how))

    assert isinstance(result, AgentFailure), result
    assert_safe(result)


@SETTINGS
@given(envelope=valid_envelopes, key=any_text.filter(lambda name: name not in RESPONSE_KEYS), value=json_any)
def test_property_22_unexpected_top_level_fields_are_always_refused(
    envelope: dict[str, Any], key: str, value: Any
) -> None:
    result = parse_agent_output({**envelope, key: value})

    assert isinstance(result, AgentFailure), result
    assert result.reason == "invalid_shape"


# --- failures never echo model content ----------------------------------------------------------


@SETTINGS
@given(marker=word.map(lambda text: f"MARK_{text}_ZZ"), where=st.sampled_from(range(6)), how=encodings)
def test_property_22_failures_never_contain_model_content(marker: str, where: int, how: str) -> None:
    ok = envelope_of({"type": "NO_ACTION"}, marker, False, marker)
    bad: list[dict[str, Any]] = [
        {**ok, marker: marker},
        {**ok, "action": {"type": "NO_ACTION", "command": marker}},
        {**ok, "action": {"type": marker, "command": marker}},
        {**ok, "action": {"type": "GO_TO_LINE", "line": marker}},
        {**ok, "version": marker},
        {**ok, "confirmationRequired": marker},
    ]
    result = parse_agent_output(encode(bad[where], how))

    assert isinstance(result, AgentFailure), result
    assert marker not in repr(result)
    assert marker not in result.message


def test_property_22_oracle_matches_the_registry() -> None:
    assert set(ALLOWED_ACTIONS) == EXPECTED_ACTIONS
    assert len(EXPECTED_ACTIONS) == 8
    assert "RUN_COMMAND" not in ALLOWED_ACTIONS and "GO_TO_SYMBOL" not in ALLOWED_ACTIONS
    for name, spec in ALLOWED_ACTIONS.items():
        assert set(spec.params_model.model_fields) == PARAM_FIELDS[name]
