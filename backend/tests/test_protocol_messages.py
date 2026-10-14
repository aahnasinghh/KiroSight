"""Task 6.9 deterministic tests for the Python protocol models (no property tests; 6.10/6.11)."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.protocol import messages, validators
from app.protocol.validators import ProtocolValidationError, parse_message
from tests._protocol_integer_fields import (
    BASES,
    INTEGER_FIELDS,
    VALID_TEST_RUN,
    IntegerField,
    decode_with_spelling,
    get_at,
)
from app.protocol.messages import (
    BACKEND_MESSAGE_TYPES,
    ERROR_CODES,
    PROTOCOL_MESSAGE_ADAPTER,
    PROTOCOL_VERSION,
    ActionEnvelope,
    ActionRequest,
    ActionResultMessage,
    AgentRequest,
    AgentResponse,
    AudioClip,
    Cancel,
    ErrorMessage,
    Hello,
    HelloAck,
    RecordStart,
    RecordStop,
    SpeechAudio,
    SpeechRequest,
    TranscriptionResult,
    dump_message,
)

FIXTURES = (
    Path(__file__).resolve().parents[2] / "extension" / "src" / "protocol" / "fixtures" / "messages"
)

MODEL_FOR_TYPE = {
    "hello": Hello,
    "hello_ack": HelloAck,
    "agent_request": AgentRequest,
    "agent_response": AgentResponse,
    "action_request": ActionRequest,
    "action_result": ActionResultMessage,
    "record_start": RecordStart,
    "record_stop": RecordStop,
    "audio_clip": AudioClip,
    "transcription_result": TranscriptionResult,
    "speech_request": SpeechRequest,
    "speech_audio": SpeechAudio,
    "cancel": Cancel,
    "error_message": ErrorMessage,
}


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def parse(raw: dict[str, Any]) -> Any:
    return PROTOCOL_MESSAGE_ADAPTER.validate_python(raw)


def rejects(raw: Any) -> bool:
    try:
        PROTOCOL_MESSAGE_ADAPTER.validate_python(raw)
    except ValidationError:
        return True
    return False


# ------------------------------------------------------------- constants


def test_protocol_version_and_message_set() -> None:
    assert PROTOCOL_VERSION == 1
    assert len(BACKEND_MESSAGE_TYPES) == 14
    assert set(BACKEND_MESSAGE_TYPES) == set(MODEL_FOR_TYPE)
    for forbidden in ("run_command", "execute", "command", "ping", "pong", "ready", "log", "debug"):
        assert forbidden not in BACKEND_MESSAGE_TYPES


def test_error_code_set_is_exact() -> None:
    assert ERROR_CODES == (
        "VALIDATION_FAILED",
        "UNSUPPORTED_VERSION",
        "UNKNOWN_TYPE",
        "UNAUTHORIZED",
        "BEDROCK_UNAVAILABLE",
        "BEDROCK_INVALID_RESPONSE",
        "STT_UNAVAILABLE",
        "STT_NO_SPEECH",
        "TTS_UNAVAILABLE",
        "MIC_UNAVAILABLE",
        "MIC_DENIED",
        "CREDENTIAL_MISSING",
        "TIMEOUT",
        "CANCELLED",
        "INTERNAL",
    )
    assert len(ERROR_CODES) == 15


@pytest.mark.parametrize("code", ERROR_CODES)
def test_every_error_code_is_accepted(code: str) -> None:
    assert parse({**fixture("error_message"), "code": code}).code == code


@pytest.mark.parametrize("code", ["NOPE", "validation_failed", "", 5, None])
def test_unknown_error_codes_are_rejected(code: Any) -> None:
    assert rejects({**fixture("error_message"), "code": code})


def test_python_and_typescript_declare_the_same_error_codes_and_message_types() -> None:
    source = (
        Path(__file__).resolve().parents[2] / "extension" / "src" / "protocol" / "constants.ts"
    ).read_text(encoding="utf-8")
    for code in ERROR_CODES:
        assert f"'{code}'" in source
    for message_type in BACKEND_MESSAGE_TYPES:
        assert f"'{message_type}'" in source


# ------------------------------------------------------------- valid models


@pytest.mark.parametrize("message_type, model", MODEL_FOR_TYPE.items())
def test_fixture_parses_to_the_concrete_model(message_type: str, model: type) -> None:
    parsed = parse(fixture(message_type))
    assert type(parsed) is model
    assert parsed.type == message_type
    assert parsed.version == 1


def test_representative_nested_fields_survive() -> None:
    request = parse(fixture("agent_request"))
    assert request.utterance.text == "explain this error"
    assert request.utterance.source == "typed"
    assert request.context.workspace.rootCount == 1
    assert request.context.cursor.line == 3
    assert request.context.selection.isEmpty is False
    assert request.context.nearbyCode.source == "cursor_window"
    assert request.context.currentSymbol.name == "example"
    assert request.context.diagnostics[0].symbolName == "example"
    assert request.context.diagnosticCounts.error == 1

    ack = parse(fixture("hello_ack"))
    assert ack.supportedVersions == [1]
    assert ack.capabilities.mic == "not_applicable"

    result = parse(fixture("action_result"))
    assert result.result.actionType == "GO_TO_DIAGNOSTIC"
    assert result.result.details.wrapped is False


def test_wire_names_stay_camel_case() -> None:
    assert {"supportedVersions", "capabilities"} <= set(dump_message(parse(fixture("hello_ack"))))
    assert "confirmationRequired" in dump_message(parse(fixture("agent_response")))
    assert "mimeType" in dump_message(parse(fixture("audio_clip")))
    assert "replyTo" in dump_message(parse(fixture("speech_audio")))
    assert "targetId" in dump_message(parse(fixture("cancel")))
    assert "actionType" in dump_message(parse(fixture("action_result")))["result"]
    for snake in ("supported_versions", "confirmation_required", "mime_type", "reply_to", "target_id"):
        for name in BACKEND_MESSAGE_TYPES:
            assert snake not in dump_message(parse(fixture(name)))


def test_optional_fields_are_optional_but_not_nullable() -> None:
    assert parse({**fixture("hello"), "token": "t"}).token == "t"
    assert dump_message(parse(fixture("hello"))) == fixture("hello")
    speech = {k: v for k, v in fixture("speech_request").items() if k != "replyTo"}
    assert parse(speech).replyTo is None
    assert "replyTo" not in dump_message(parse(speech))
    for raw in (
        {**fixture("hello"), "token": None},
        {**fixture("speech_request"), "replyTo": None},
        {**fixture("error_message"), "replyTo": None},
        {**fixture("agent_request"), "utterance": None},
        {**fixture("agent_request"), "testRun": None},
    ):
        assert rejects(raw)


def test_summarize_test_run_request_with_a_test_run() -> None:
    raw = fixture("agent_request")
    raw["kind"] = "summarize_test_run"
    del raw["utterance"]
    raw["testRun"] = {
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
    parsed = parse(raw)
    assert parsed.testRun.failingTests[0].name == "sample test"
    assert dump_message(parsed)["testRun"]["exitCode"] == 1
    for bad in (
        {**raw["testRun"], "outcome": "unknown"},
        {**raw["testRun"], "extra": 1},
        {**raw["testRun"], "failingTests": [{"name": "n"}] * 21},
        {**raw["testRun"], "exitCode": True},
        {**raw["testRun"], "durationMs": -1},
        {**raw["testRun"], "passed": -1},
    ):
        assert rejects({**raw, "testRun": bad})


@pytest.mark.parametrize(
    "details",
    [
        {"kind": "file_opened", "relativePath": "src/a.ts"},
        {
            "kind": "diagnostic_reached",
            "relativePath": "src/a.ts",
            "line": 3,
            "severity": "error",
            "message": "m",
            "symbol": "s",
            "wrapped": True,
        },
        {"kind": "location_reached", "relativePath": "src/a.ts", "line": 3},
        {"kind": "ambiguous_files", "matches": ["a/x.ts", "b/x.ts"], "totalMatches": 2},
    ],
)
def test_action_result_details_variants(details: dict[str, Any]) -> None:
    raw = fixture("action_result")
    raw["result"]["details"] = details
    assert dump_message(parse(raw))["result"]["details"] == details


def test_action_result_statuses_and_action_type_is_a_free_string() -> None:
    for status in ("ok", "failed", "declined", "not_permitted", "needs_clarification", "not_configured"):
        raw = fixture("action_result")
        raw["result"] = {"actionType": "NOT_AN_ACTION", "status": status, "message": "x"}
        assert parse(raw).result.actionType == "NOT_AN_ACTION"
    raw = fixture("action_result")
    raw["result"] = {"actionType": "RUN_TESTS", "status": "later", "message": "x"}
    assert rejects(raw)


# ------------------------------------------------------------- strictness


@pytest.mark.parametrize("message_type", BACKEND_MESSAGE_TYPES)
def test_unexpected_top_level_fields_are_rejected(message_type: str) -> None:
    assert rejects({**fixture(message_type), "extra": 1})
    assert rejects({**fixture(message_type), "command": "rm -rf /"})


def test_unexpected_nested_fields_are_rejected() -> None:
    raw = fixture("agent_request")
    for path in (("context",), ("context", "workspace"), ("context", "cursor"), ("utterance",)):
        mutated = copy.deepcopy(raw)
        target = mutated
        for key in path:
            target = target[key]
        target["extra"] = 1
        assert rejects(mutated), path
    assert rejects({**fixture("hello_ack"), "capabilities": {**fixture("hello_ack")["capabilities"], "x": 1}})


@pytest.mark.parametrize("version", ["1", True, False, 0, 2, 1.5, None, [1]])
def test_wrong_version_values_are_rejected(version: Any) -> None:
    assert rejects({**fixture("cancel"), "version": version})
    assert rejects({k: v for k, v in fixture("cancel").items() if k != "version"})


def test_booleans_strings_and_fractions_do_not_become_integers() -> None:
    assert rejects({**fixture("hello_ack"), "supportedVersions": [True]})
    assert rejects({**fixture("hello_ack"), "supportedVersions": [1.5]})
    assert rejects({**fixture("hello_ack"), "supportedVersions": ["1"]})
    assert rejects({**fixture("hello_ack"), "supportedVersions": (1,)})
    raw = fixture("agent_request")
    for value in (True, "3", 3.5, 0, -1, 2**53, float("nan"), float("inf"), float("-inf"), 1e300):
        mutated = copy.deepcopy(raw)
        mutated["context"]["cursor"]["line"] = value
        assert rejects(mutated), value


def test_integral_floats_are_accepted_and_normalized_to_int() -> None:
    parsed = parse({**fixture("hello_ack"), "supportedVersions": [1.0, 2.0]})
    assert parsed.supportedVersions == [1, 2]
    assert all(type(item) is int for item in parsed.supportedVersions)
    assert dump_message(parsed)["supportedVersions"] == [1, 2]
    assert all(type(item) is int for item in dump_message(parsed)["supportedVersions"])


@pytest.mark.parametrize("field", INTEGER_FIELDS, ids=lambda field: field.label)
def test_every_integer_field_accepts_any_integral_json_number(field: IntegerField) -> None:
    for spelling in ("5", "5.0", "5.00", "5e0", "50e-1"):
        decoded = decode_with_spelling(field, spelling)  # real json.loads: 5 -> int, 5.0 -> float
        parsed = parse_message(decoded)
        assert not isinstance(parsed, ProtocolValidationError), (field.label, spelling)
        value = get_at(dump_message(parsed), field.path)
        assert value == 5 and type(value) is int, (field.label, spelling)
        again = parse_message(json.loads(json.dumps(dump_message(parsed))))
        assert dump_message(again) == dump_message(parsed)


@pytest.mark.parametrize("field", INTEGER_FIELDS, ids=lambda field: field.label)
def test_every_integer_field_rejects_non_integral_non_numeric_and_out_of_range(field: IntegerField) -> None:
    spellings = ["5.5", "0.999", "true", "false", '"5"', '"5.0"', "NaN", "Infinity", "-Infinity", "1e300", "9007199254740993"]
    if not field.nullable:
        spellings.append("null")
    if field.minimum is not None:
        spellings += [str(field.minimum - 1), f"{field.minimum - 1}.0", f"{field.minimum - 1}e0"]
    for spelling in spellings:
        decoded = decode_with_spelling(field, spelling)  # json.loads also decodes NaN / Infinity
        error = parse_message(decoded)
        assert isinstance(error, ProtocolValidationError), (field.label, spelling)
        assert error.code == "VALIDATION_FAILED", (field.label, spelling)


MAX_SAFE = 9007199254740991  # Number.MAX_SAFE_INTEGER


@pytest.mark.parametrize("field", INTEGER_FIELDS, ids=lambda field: field.label)
def test_every_integer_field_enforces_the_javascript_safe_integer_range(field: IntegerField) -> None:
    for spelling in (str(MAX_SAFE), f"{MAX_SAFE}.0"):
        parsed = parse_message(decode_with_spelling(field, spelling))
        assert not isinstance(parsed, ProtocolValidationError), (field.label, spelling)
        value = get_at(dump_message(parsed), field.path)
        assert value == MAX_SAFE and type(value) is int, (field.label, spelling)

    if field.minimum is None:  # negatives are allowed here, so the lower safe bound is observable
        for spelling in (str(-MAX_SAFE), f"-{MAX_SAFE}.0"):
            parsed = parse_message(decode_with_spelling(field, spelling))
            assert not isinstance(parsed, ProtocolValidationError), (field.label, spelling)
            assert get_at(dump_message(parsed), field.path) == -MAX_SAFE
        too_low = [str(-MAX_SAFE - 1), f"-{MAX_SAFE + 1}.0", "-1e20", "-1e300"]
    else:
        too_low = ["-1e20", "-1e300"]

    for spelling in [str(MAX_SAFE + 1), f"{MAX_SAFE + 1}.0", "1e20", "1e300", *too_low]:
        error = parse_message(decode_with_spelling(field, spelling))
        assert isinstance(error, ProtocolValidationError), (field.label, spelling)
        assert error.code == "VALIDATION_FAILED", (field.label, spelling)


def test_safe_range_applies_only_to_schema_integers_not_action_extras() -> None:
    action = {"type": "UNKNOWN_FUTURE_ACTION", "futureNumber": 1e300, "big": 2**60}
    dumped = dump_message(parse({**fixture("agent_response"), "action": action}))["action"]
    assert dumped == action
    assert dumped["futureNumber"] == 1e300


def test_nullable_integer_fields_still_accept_null() -> None:
    for field in INTEGER_FIELDS:
        if field.nullable:
            assert not isinstance(parse_message(decode_with_spelling(field, "null")), ProtocolValidationError)


def test_integer_field_table_covers_every_integer_bearing_model() -> None:
    bases = {field.base for field in INTEGER_FIELDS}
    assert bases == set(BASES)
    labels = {field.label for field in INTEGER_FIELDS}
    assert len(labels) == len(INTEGER_FIELDS)
    assert "agent_request:context.cursor.line" in labels
    assert "hello_ack:supportedVersions.0" in labels


def test_duration_ms_is_a_plain_number_not_an_integer_field() -> None:
    raw = fixture("agent_request")
    raw["kind"] = "summarize_test_run"
    raw["testRun"] = copy.deepcopy(VALID_TEST_RUN)
    raw["testRun"]["durationMs"] = 12.5
    assert not rejects(raw)
    assert parse(raw).testRun.durationMs == 12.5


def test_action_envelope_extras_are_not_normalized() -> None:
    action = {"type": "FUTURE_ACTION", "someFutureParameter": 5.0, "nested": {"n": 2.0}, "list": [3.0]}
    parsed = parse({**fixture("agent_response"), "action": action})
    dumped = dump_message(parsed)["action"]
    assert dumped == action
    assert type(dumped["someFutureParameter"]) is float
    assert type(dumped["nested"]["n"]) is float
    assert type(dumped["list"][0]) is float


def test_strings_and_booleans_are_not_coerced() -> None:
    assert rejects({**fixture("cancel"), "targetId": 5})
    assert rejects({**fixture("agent_response"), "confirmationRequired": "false"})
    assert rejects({**fixture("agent_response"), "confirmationRequired": 0})
    assert rejects({**fixture("error_message"), "recoverable": "yes"})
    assert rejects({**fixture("hello_ack"), "capabilities": {**fixture("hello_ack")["capabilities"], "stt": 1}})


def test_length_caps_use_javascript_string_lengths() -> None:
    assert parse({**fixture("agent_response"), "speech": "x" * 600})
    assert rejects({**fixture("agent_response"), "speech": "x" * 601})
    # 300 emoji are 600 UTF-16 units (allowed); 301 are 602 (rejected), as in JavaScript.
    assert parse({**fixture("agent_response"), "speech": "😀" * 300})
    assert rejects({**fixture("agent_response"), "speech": "😀" * 301})
    raw = fixture("agent_request")
    raw["utterance"]["text"] = "x" * 4001
    assert rejects(raw)


def test_chunked_audio_frames_accept_seq_and_final_together() -> None:
    base = fixture("audio_clip")
    for seq, final, b64 in ((0, False, "AAEC"), (7, True, "AAEC"), (3, True, ""), (0, True, "AAEC")):
        message = parse({**base, "seq": seq, "final": final, "base64": b64})
        assert isinstance(message, AudioClip)
        assert (message.seq, message.final, message.base64) == (seq, final, b64)
        assert dump_message(message)["seq"] == seq
    # A whole-recording frame carries neither field and dumps without them.
    whole = parse(base)
    assert isinstance(whole, AudioClip)
    assert (whole.seq, whole.final) == (None, None)
    assert "seq" not in dump_message(whole) and "final" not in dump_message(whole)


def test_malformed_chunked_audio_frames_are_rejected() -> None:
    base = fixture("audio_clip")
    for bad in (
        {**base, "seq": -1, "final": False},
        {**base, "seq": 1.5, "final": False},
        {**base, "seq": "0", "final": False},
        {**base, "seq": 0, "final": "yes"},
        {**base, "seq": 0, "final": 1},
        {**base, "seq": None, "final": False},
        {**base, "seq": 0, "final": None},
        {**base, "seq": 0, "final": False, "extra": 1},
    ):
        assert rejects(bad)


def test_capabilities_and_audio_shapes() -> None:
    caps = fixture("hello_ack")["capabilities"]
    for mic in ("available", "unavailable", "denied", "not_applicable"):
        assert parse({**fixture("hello_ack"), "capabilities": {**caps, "mic": mic}})
    for bad in ({**caps, "mic": "granted"}, {k: v for k, v in caps.items() if k != "mic"}, None, []):
        assert rejects({**fixture("hello_ack"), "capabilities": bad})
    for bad in (
        {**fixture("audio_clip"), "base64": 5},
        {**fixture("audio_clip"), "seq": 0},
        {**fixture("audio_clip"), "final": True},
        {k: v for k, v in fixture("audio_clip").items() if k != "mimeType"},
        {k: v for k, v in fixture("speech_audio").items() if k != "replyTo"},
    ):
        assert rejects(bad)


# ------------------------------------------------------------- IDEContext


def with_context(**changes: Any) -> dict[str, Any]:
    raw = fixture("agent_request")
    raw["context"].update(changes)
    return raw


def test_no_editor_and_empty_selection_contexts_are_valid() -> None:
    no_editor = {
        "workspace": {"name": None, "rootCount": 0},
        "relativePath": None,
        "languageId": None,
        "cursor": None,
        "selection": None,
        "nearbyCode": None,
        "currentSymbol": None,
        "symbolStatus": "no_editor",
        "diagnostics": [],
        "diagnosticCounts": {"error": 0, "warning": 0, "information": 0, "hint": 0},
    }
    raw = {**fixture("agent_request"), "context": no_editor}
    assert dump_message(parse(raw))["context"] == no_editor
    assert parse(with_context(selection={"isEmpty": True}))


@pytest.mark.parametrize(
    "path", ["/home/user/a.ts", "C:\\work\\a.ts", "c:/work/a.ts", "\\\\server\\share\\a.ts"]
)
def test_absolute_paths_are_rejected_everywhere(path: str) -> None:
    assert rejects(with_context(relativePath=path))
    raw = fixture("agent_request")
    raw["context"]["diagnostics"][0]["relativePath"] = path
    assert rejects(raw)
    result = fixture("action_result")
    result["result"]["details"]["relativePath"] = path
    assert rejects(result)
    ambiguous = fixture("action_result")
    ambiguous["result"]["details"] = {"kind": "ambiguous_files", "matches": [path], "totalMatches": 1}
    assert rejects(ambiguous)


def test_active_file_and_absolute_path_fields_are_not_part_of_the_wire_model() -> None:
    for name in ("activeFile", "fsPath", "absolutePath", "workspaceRootPath"):
        assert rejects(with_context(**{name: "x"}))
    assert "activeFile" not in messages.WireContext.model_fields


@pytest.mark.parametrize(
    "changes",
    [
        {"cursor": {"line": 0, "column": 1}},
        {"cursor": {"line": 1}},
        {"selection": {"isEmpty": False}},
        {"selection": {"isEmpty": True, "start": {"line": 1, "column": 1}}},
        {"symbolStatus": "unknown"},
        {"workspace": {"name": "x"}},
        {"diagnosticCounts": {"error": -1, "warning": 0, "information": 0, "hint": 0}},
        {"diagnosticCounts": {"error": 0, "warning": 0, "information": 0}},
        {"nearbyCode": {"source": "file", "startLine": 1, "endLine": 1, "text": "", "truncated": False}},
        {"nearbyCode": {"source": "symbol", "startLine": 1, "endLine": 1, "text": "x" * 6001, "truncated": False}},
        {"currentSymbol": {"name": "f"}},
        {"relativePath": 5},
        {"languageId": 5},
    ],
)
def test_malformed_contexts_are_rejected(changes: dict[str, Any]) -> None:
    assert rejects(with_context(**changes))


def test_diagnostic_bounds() -> None:
    raw = fixture("agent_request")
    good = raw["context"]["diagnostics"][0]
    raw["context"]["diagnostics"] = [good] * 25
    assert parse(raw)
    raw["context"]["diagnostics"] = [good] * 26
    assert rejects(raw)
    raw["context"]["diagnostics"] = [{**good, "message": "x" * 501}]
    assert rejects(raw)
    raw["context"]["diagnostics"] = [{**good, "severity": "fatal"}]
    assert rejects(raw)
    raw["context"]["diagnostics"] = [{**good, "source": None}]
    assert rejects(raw)
    raw["context"]["diagnostics"] = [{**good, "symbolName": None}]
    assert parse(raw)


# ------------------------------------------------------------- action envelope


@pytest.mark.parametrize("message_type, action_field", [("agent_response", "action"), ("action_request", "action")])
def test_action_envelope_preserves_unknown_names_and_extra_fields(message_type: str, action_field: str) -> None:
    for action in (
        {"type": "RUN_COMMAND", "command": "echo hi"},
        {"type": "GO_TO_SYMBOL", "name": "foo"},
        {"type": "UNKNOWN_ACTION_FROM_MODEL", "anything": "..."},
        {"type": "GO_TO_LINE", "line": 42},
        {"type": "RUN_TESTS", "command": "should-not-run"},
        {"type": "GO_TO_DIAGNOSTIC", "index": 2, "severity": "warning"},
        {"type": "OPEN_FILE", "path": "src/a.ts"},
    ):
        parsed = parse({**fixture(message_type), action_field: action})
        assert isinstance(parsed.action, ActionEnvelope)
        assert parsed.action.type == action["type"]
        assert dump_message(parsed)[action_field] == action


def test_run_tests_command_extra_survives_envelope_parsing_without_execution() -> None:
    parsed = parse({**fixture("agent_response"), "action": {"type": "RUN_TESTS", "command": "should-not-run"}})
    assert parsed.action.model_extra == {"command": "should-not-run"}
    assert dump_message(parsed)["action"] == {"type": "RUN_TESTS", "command": "should-not-run"}


@pytest.mark.parametrize("action", [None, "RUN_TESTS", 5, [], {}, {"type": 5}, {"type": None}, {"kind": "RUN_TESTS"}])
def test_action_without_a_string_type_is_rejected(action: Any) -> None:
    assert rejects({**fixture("agent_response"), "action": action})
    assert rejects({**fixture("action_request"), "action": action})


def test_protocol_models_do_not_depend_on_the_allow_list() -> None:
    for module in (messages, validators):
        source = Path(module.__file__).read_text(encoding="utf-8")
        assert "import allowlist" not in source
        assert "app.allowlist" not in source
        assert "ALLOWED_ACTIONS" not in source


def test_parsed_messages_are_immutable() -> None:
    parsed = parse(fixture("cancel"))
    with pytest.raises(ValidationError):
        parsed.targetId = "other"
