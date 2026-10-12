"""Task 6.9 deterministic tests for ``parse_message`` (no property tests; Task 6.11 owns those)."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from app.protocol.messages import BACKEND_MESSAGE_TYPES, Cancel, dump_message
from app.protocol.validators import ProtocolValidationError, parse_message

FIXTURES = (
    Path(__file__).resolve().parents[2] / "extension" / "src" / "protocol" / "fixtures" / "messages"
)


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def failure(raw: Any) -> ProtocolValidationError:
    result = parse_message(raw)
    assert isinstance(result, ProtocolValidationError), result
    return result


# ------------------------------------------------------------- success


def test_valid_message_returns_the_parsed_model() -> None:
    parsed = parse_message(fixture("cancel"))
    assert isinstance(parsed, Cancel)
    assert parsed.targetId == "req-1"
    assert dump_message(parsed) == fixture("cancel")


@pytest.mark.parametrize("message_type", BACKEND_MESSAGE_TYPES)
def test_every_fixture_parses(message_type: str) -> None:
    parsed = parse_message(fixture(message_type))
    assert not isinstance(parsed, ProtocolValidationError)
    assert parsed.type == message_type


def test_parse_does_not_mutate_its_input() -> None:
    raw = fixture("agent_response")
    raw["action"] = {"type": "RUN_TESTS", "command": "should-not-run"}
    snapshot = copy.deepcopy(raw)
    parse_message(raw)
    assert raw == snapshot


# ------------------------------------------------------------- never raises


class _Hostile:
    def __getattribute__(self, name: str) -> Any:
        raise RuntimeError("boom")


class _HostileDict(dict):  # type: ignore[type-arg]
    def __contains__(self, key: object) -> bool:
        raise RuntimeError("boom")

    def __getitem__(self, key: object) -> Any:
        raise RuntimeError("boom")

    def get(self, key: object, default: Any = None) -> Any:
        raise RuntimeError("boom")


def _cyclic() -> dict[str, Any]:
    value: dict[str, Any] = {"version": 1, "type": "cancel"}
    value["targetId"] = value
    return value


@pytest.mark.parametrize(
    "raw",
    [
        None,
        True,
        False,
        0,
        1,
        1.5,
        "",
        "hello",
        '{"version":1,"type":"cancel","targetId":"x"}',
        b"bytes",
        bytearray(b"x"),
        [],
        [fixture("cancel")],
        (fixture("cancel"),),
        {},
        {"version": 1},
        {"type": "cancel"},
        object(),
        {"version": 1, "type": "cancel", "targetId": {"a": [1, 2, {"b": float("nan")}]}},
    ],
    ids=lambda value: type(value).__name__,
)
def test_malformed_input_returns_an_error_and_never_raises(raw: Any) -> None:
    assert isinstance(parse_message(raw), ProtocolValidationError)


def test_hostile_and_cyclic_inputs_return_an_error_and_never_raise() -> None:
    # Built inside the test: pytest must not probe these objects during collection.
    for raw in (_Hostile(), _HostileDict(version=1, type="cancel"), _cyclic()):
        assert isinstance(parse_message(raw), ProtocolValidationError)


def test_json_text_is_not_decoded_by_the_parser() -> None:
    text = json.dumps(fixture("cancel"))
    assert failure(text).code == "VALIDATION_FAILED"


# ------------------------------------------------------------- classification


def test_missing_version_is_a_generic_failure() -> None:
    raw = {k: v for k, v in fixture("cancel").items() if k != "version"}
    error = failure(raw)
    assert error.code == "VALIDATION_FAILED"
    assert error.paths == ("version",)


HELLO_JSON = '{"version": %s, "type": "hello", "client": "kirosight-extension"}'


@pytest.mark.parametrize("spelling", ["1", "1.0", "1.00", "1e0", "1E0", "10e-1"])
def test_every_json_spelling_of_the_number_one_is_the_supported_version(spelling: str) -> None:
    # JSON.parse gives the number 1 for all of these; json.loads gives 1 or 1.0. Both must agree.
    decoded = json.loads(HELLO_JSON % spelling)
    parsed = parse_message(decoded)
    assert not isinstance(parsed, ProtocolValidationError), spelling
    assert parsed.version == 1
    assert type(parsed.version) is int  # normalized to the canonical integer
    dumped = dump_message(parsed)
    assert dumped["version"] == 1 and type(dumped["version"]) is int
    assert json.dumps(dumped).startswith('{"version": 1,')


@pytest.mark.parametrize("spelling", ['"1"', '"1.0"', "true", "false", "null", "0", "2", "-1", "1.5", "0.999", "2.0", "NaN", "Infinity", "-Infinity", "[1]", "{}"])
def test_non_one_json_values_are_unsupported_versions(spelling: str) -> None:
    decoded = json.loads(HELLO_JSON % spelling)  # Python's json also decodes NaN / Infinity
    assert failure(decoded).code == "UNSUPPORTED_VERSION", spelling


def test_float_one_reaches_normal_parsing_instead_of_being_classified_by_version() -> None:
    # 1.0 is no longer an UNSUPPORTED_VERSION case: a bad body is a generic schema failure.
    bad = {"version": 1.0, "type": "hello", "client": "not-the-literal"}
    assert failure(bad).code == "VALIDATION_FAILED"
    ok = parse_message({"version": 1.0, "type": "cancel", "targetId": "r1"})
    assert not isinstance(ok, ProtocolValidationError)
    assert type(ok.version) is int


def test_bool_is_never_the_protocol_version() -> None:
    # bool is a subclass of int in Python, so True == 1; it must still be rejected.
    assert failure({**fixture("cancel"), "version": True}).code == "UNSUPPORTED_VERSION"
    assert failure({**fixture("cancel"), "version": False}).code == "UNSUPPORTED_VERSION"


@pytest.mark.parametrize("version", [0, 2, -1, "1", 1.5, True, False, None, [1], {}])
def test_present_wrong_version_is_unsupported(version: Any) -> None:
    assert failure({**fixture("cancel"), "version": version}).code == "UNSUPPORTED_VERSION"


@pytest.mark.parametrize("message_type", ["run_command", "ping", "HELLO", "cancel ", "", "hello_ack2"])
def test_unknown_string_type(message_type: str) -> None:
    assert failure({**fixture("cancel"), "type": message_type}).code == "UNKNOWN_TYPE"


@pytest.mark.parametrize("message_type", [None, 5, [], {}, True])
def test_non_string_type_is_a_generic_failure(message_type: Any) -> None:
    assert failure({**fixture("cancel"), "type": message_type}).code == "VALIDATION_FAILED"
    assert failure({k: v for k, v in fixture("cancel").items() if k != "type"}).code == "VALIDATION_FAILED"


def test_version_is_checked_before_type() -> None:
    assert failure({"version": 2, "type": "nope"}).code == "UNSUPPORTED_VERSION"


# ------------------------------------------------------------- schema failures


def test_missing_required_field_per_message_type() -> None:
    required = {
        "hello": "client",
        "hello_ack": "capabilities",
        "agent_request": "context",
        "agent_response": "replyTo",
        "action_request": "reason",
        "action_result": "result",
        "record_start": "id",
        "record_stop": "id",
        "audio_clip": "base64",
        "transcription_result": "text",
        "speech_request": "text",
        "speech_audio": "mimeType",
        "cancel": "targetId",
        "error_message": "recoverable",
    }
    assert set(required) == set(BACKEND_MESSAGE_TYPES)
    for message_type, field in required.items():
        raw = {k: v for k, v in fixture(message_type).items() if k != field}
        error = failure(raw)
        assert error.code == "VALIDATION_FAILED", message_type
        assert field in error.paths, message_type


def test_wrong_field_types() -> None:
    cases = [
        {**fixture("cancel"), "targetId": 5},
        {**fixture("hello"), "client": "other"},
        {**fixture("agent_response"), "confirmationRequired": "false"},
        {**fixture("agent_response"), "speech": "x" * 601},
        {**fixture("hello_ack"), "supportedVersions": ["1"]},
    ]
    for raw in cases:
        assert failure(raw).code == "VALIDATION_FAILED"


def test_unexpected_top_level_field_is_rejected_without_naming_it() -> None:
    error = failure({**fixture("cancel"), "extra_property_name_xyz": "value"})
    assert error.code == "VALIDATION_FAILED"
    assert "extra_property_name_xyz" not in repr(error)
    assert "extra_property_name_xyz" not in " ".join(error.paths)


def test_invalid_error_code_and_malformed_pieces() -> None:
    assert failure({**fixture("error_message"), "code": "NOPE"}).code == "VALIDATION_FAILED"
    caps = {**fixture("hello_ack")["capabilities"], "mic": "granted"}
    assert failure({**fixture("hello_ack"), "capabilities": caps}).code == "VALIDATION_FAILED"
    assert failure({**fixture("audio_clip"), "base64": 5}).code == "VALIDATION_FAILED"
    context = fixture("agent_request")
    context["context"]["cursor"] = {"line": 0, "column": 1}
    assert failure(context).code == "VALIDATION_FAILED"
    absolute = fixture("agent_request")
    absolute["context"]["relativePath"] = "C:\\Users\\someone\\a.ts"
    assert failure(absolute).code == "VALIDATION_FAILED"


# ------------------------------------------------------------- safe content


def test_errors_never_echo_payload_content() -> None:
    secret = "sk-DISTINCTIVE-SECRET-VALUE-1234567890"
    raw = fixture("agent_request")
    raw["context"]["nearbyCode"]["text"] = 12345
    raw["context"]["workspace"][secret] = secret
    raw["utterance"]["text"] = secret * 200
    raw[secret] = secret
    errors = [
        parse_message(raw),
        parse_message({**fixture("cancel"), "targetId": secret + "x", secret: 1}),
        parse_message({**fixture("cancel"), "type": secret}),
        parse_message({**fixture("cancel"), "version": secret}),
        parse_message({**fixture("audio_clip"), "base64": [secret]}),
    ]
    for error in errors:
        assert isinstance(error, ProtocolValidationError)
        assert secret not in repr(error)
        assert "DISTINCTIVE" not in repr(error)
        assert len(error.paths) <= 5
        assert all(len(path) <= 100 for path in error.paths)


def test_error_object_is_immutable_and_distinct_from_the_wire_error_message() -> None:
    error = failure(None)
    with pytest.raises(AttributeError):
        error.code = "INTERNAL"  # type: ignore[misc]
    assert not hasattr(error, "type")
    assert not hasattr(error, "version")


def test_paths_are_schema_paths_without_the_discriminator() -> None:
    raw = fixture("agent_request")
    raw["context"]["cursor"] = {"line": 0, "column": 1}
    error = failure(raw)
    assert "context.cursor.line" in error.paths
    assert not any(path.startswith("agent_request") for path in error.paths)


# ------------------------------------------------------------- action envelope layering


@pytest.mark.parametrize("message_type", ["agent_response", "action_request"])
def test_parser_passes_unknown_and_dangerous_action_envelopes_through(message_type: str) -> None:
    for action in (
        {"type": "RUN_COMMAND", "command": "echo hi"},
        {"type": "GO_TO_SYMBOL", "name": "foo"},
        {"type": "UNKNOWN_ACTION_FROM_MODEL", "anything": "..."},
        {"type": "RUN_TESTS", "command": "should-not-run"},
    ):
        parsed = parse_message({**fixture(message_type), "action": action})
        assert not isinstance(parsed, ProtocolValidationError)
        assert dump_message(parsed)["action"] == action


@pytest.mark.parametrize("message_type", ["agent_response", "action_request"])
def test_parser_rejects_actions_without_a_string_type(message_type: str) -> None:
    for action in (None, "RUN_TESTS", [], {}, {"type": 5}, {"type": None}, {"kind": "RUN_TESTS"}):
        assert failure({**fixture(message_type), "action": action}).code == "VALIDATION_FAILED"
