"""Task 7.5 / Property 23: spoken responses respect the sentence limit.

Feature: kirosight-mvp, Property 23: For any text, the sentence limiter returns at most 5 sentences,
and the result is a prefix of the input text's sentences in the original order.
(Validates: Requirements 7.5, 12.6)

The 600-unit length limit belongs to the same speech contract (the protocol caps speech at 600
UTF-16 code units), so it is checked here too.

Independence from the production code:

* ``oracle_spans`` is a hand-written character scanner, not the production regular expression.
* ``units`` counts UTF-16 units from code points, not by encoding.
* Several properties build their text from KNOWN sentences, so the expected result is the
  construction itself and no splitter (production or oracle) is needed to say what is correct.

Property 22 (no unsafe action) is Task 7.4 and lives in ``test_response_parser_property.py``; the
action checks here only prove that limiting speech never changes the action.
"""

from __future__ import annotations

import json
from typing import Any, Final

from hypothesis import example, given, settings, strategies as st

from app.agent.response_parser import (
    MAX_SPEECH_SENTENCES,
    AgentFailure,
    limit_sentences,
    limit_speech,
    parse_agent_output,
)
from app.protocol.messages import MAX_SPEECH_CHARS, AgentResponse

EXAMPLES = 100
SETTINGS = settings(max_examples=EXAMPLES, deadline=None)

TERMINATORS: Final = ".!?"
CLOSERS: Final = "\"')]"
#: Characters ``str.isspace`` accepts, including unusual ones (NBSP, em space, line separator...).
WHITESPACES: Final = (" ", "  ", "\n", "\t", "\r\n", "\u00a0", "\u2003", "\u2028", "\u3000", " \n ")
RESPONSE_KEYS: Final = {"version", "type", "replyTo", "speech", "action", "confirmationRequired"}


# --- independent oracle ------------------------------------------------------------------------


def units(text: str) -> int:
    """UTF-16 code units, counted from code points (a lone surrogate is one unit)."""
    return sum(2 if ord(character) > 0xFFFF else 1 for character in text)


def oracle_spans(text: str) -> list[tuple[int, int]]:
    """Sentence spans by a plain scan.

    A sentence starts at the first non-whitespace character. It ends after a run of ``.``/``!``/``?``
    plus any closing quote or bracket, but only when whitespace or the end of the text follows;
    otherwise (``3.5``, ``v2.1.4``, ``a.b``) scanning continues. Text without such an end runs to the
    end of the input, without its trailing whitespace. The scan is linear: each terminator run is
    read once.
    """
    spans: list[tuple[int, int]] = []
    size = len(text)
    index = 0
    while index < size:
        if text[index].isspace():
            index += 1
            continue
        start = index
        end = size
        terminated = False
        scan = index
        while scan < size:
            if text[scan] in TERMINATORS:
                after_run = scan
                while after_run < size and text[after_run] in TERMINATORS:
                    after_run += 1
                after_closers = after_run
                while after_closers < size and text[after_closers] in CLOSERS:
                    after_closers += 1
                if after_closers == size or text[after_closers].isspace():
                    end = after_closers
                    terminated = True
                    break
                scan = after_run
            else:
                scan += 1
        next_index = end
        if not terminated:  # an unterminated last sentence excludes its trailing whitespace
            while end > start and text[end - 1].isspace():
                end -= 1
        spans.append((start, end))
        index = next_index
    return spans


def oracle_sentences(text: str) -> list[str]:
    return [text[start:end] for start, end in oracle_spans(text)]


def expected_sentences(text: str, max_sentences: int) -> str:
    """The first ``max_sentences`` sentences, as written, from the first to the last of them."""
    spans = oracle_spans(text)
    if not spans or max_sentences <= 0:
        return ""
    return text[spans[0][0]:spans[min(max_sentences, len(spans)) - 1][1]]


def longest_prefix_within(text: str, max_units: int) -> str:
    """The longest code-point prefix of ``text`` that fits in ``max_units`` UTF-16 units."""
    total = 0
    for index, character in enumerate(text):
        total += 2 if ord(character) > 0xFFFF else 1
        if total > max_units:
            return text[:index]
    return text


def expected_speech(text: str, max_sentences: int, max_units: int) -> tuple[str, str]:
    """``("exact", value)`` when whole sentences decide the result, else ``("cut", first_sentence)``."""
    spans = oracle_spans(text)
    if not spans or max_sentences <= 0:
        return "exact", ""
    start = spans[0][0]
    count = min(max_sentences, len(spans))
    prefixes = [text[start:spans[position][1]] for position in range(count)]
    fitting = [prefix for prefix in prefixes if units(prefix) <= max_units]
    if fitting:
        return "exact", fitting[-1]
    return "cut", prefixes[0]


def assert_cut_is_sound(result: str, first_sentence: str, max_units: int) -> None:
    """A first sentence longer than the limit is cut inside the limit, preferring a word boundary."""
    maximal = longest_prefix_within(first_sentence, max_units)
    assert first_sentence.startswith(result)
    assert units(result) <= max_units
    assert result == result.rstrip()
    if maximal:
        assert result, "something that fits must be kept"
    # Cut as late as possible: nothing left over contains another space/newline/tab to cut at.
    leftover = maximal[len(result):]
    assert not any(character in " \n\t" for character in leftover.lstrip())


def assert_speech_is_sound(text: str, result: str, max_sentences: int, max_units: int) -> None:
    kind, value = expected_speech(text, max_sentences, max_units)
    assert units(result) <= max_units
    assert len(oracle_spans(result)) <= max_sentences
    if kind == "exact":
        assert result == value
    else:
        assert_cut_is_sound(result, value, max_units)


# --- generators --------------------------------------------------------------------------------

# Dense in boundary characters so terminators, closers, spaces and astral characters collide.
ADVERSARIAL_ALPHABET: Final = (
    "a", "b", "1", ".", ".", "!", "?", '"', "'", ")", "]", " ", " ", "\n", "\t", "\u00a0",
    "\U0001F600", "\U0001D11E", "\u00e9", "\u200d", "\u0301", "\u4e2d",
)
fuzz_text = st.text(alphabet=st.sampled_from(ADVERSARIAL_ALPHABET), max_size=90)
wild_text = st.text(max_size=60)
surrogate_text = st.text(alphabet=st.characters(blacklist_categories=()), max_size=40)

word = st.text(
    alphabet=st.characters(categories=("L", "N", "So", "Mn"), exclude_characters=TERMINATORS),
    min_size=1,
    max_size=12,
)
version_token = st.sampled_from(["3.5", "v2.1.4", "0.5", "10.25.1", "1.0", "2.7.18"])
body = st.lists(st.one_of(word, word, version_token), min_size=1, max_size=30).map(" ".join)
end_mark = st.builds(
    lambda run, closer: run + closer,
    st.sampled_from([".", "!", "?", "...", "?!", "!!", "!?!"]),
    st.sampled_from(["", "", "", ")", '"', "'", "]"]),
)
known_sentence = st.builds(lambda text, mark: text + mark, body, end_mark)


@st.composite
def built_text(draw: st.DrawFn) -> tuple[str, list[str]]:
    """Text made of KNOWN sentences. Returns the text and the exact prefix text after k sentences."""
    sentences = draw(st.lists(known_sentence, min_size=1, max_size=14))
    separators = draw(st.lists(st.sampled_from(WHITESPACES), min_size=len(sentences), max_size=len(sentences)))
    lead = draw(st.one_of(st.just(""), st.sampled_from(WHITESPACES)))
    trail = draw(st.one_of(st.just(""), st.sampled_from(WHITESPACES)))
    text = lead
    prefixes: list[str] = []
    running = ""
    for position, sentence in enumerate(sentences):
        running += sentence
        prefixes.append(running)
        text += sentence
        if position < len(sentences) - 1:
            running += separators[position]
            text += separators[position]
    return text + trail, prefixes


any_text = st.one_of(fuzz_text, fuzz_text, wild_text, surrogate_text, built_text().map(lambda built: built[0]))


def envelope(speech: Any, action: dict[str, Any] | None = None, confirm: bool = False) -> dict[str, Any]:
    return {
        "version": 1,
        "type": "agent_response",
        "replyTo": "req-1",
        "speech": speech,
        "action": action if action is not None else {"type": "NO_ACTION"},
        "confirmationRequired": confirm,
    }


# --- Property 23: the sentence limiter ----------------------------------------------------------


@SETTINGS
@given(text=any_text, max_sentences=st.integers(-1, 8))
@example(text="! b. c.", max_sentences=2)
@example(text=". A. B. C. D. E. F.", max_sentences=5)
@example(text="?? Hello. World.", max_sentences=1)
def test_property_23_limit_sentences_returns_exactly_the_first_sentences_in_order(
    text: str, max_sentences: int
) -> None:
    # Feature: kirosight-mvp, Property 23: Spoken responses respect the sentence limit
    result = limit_sentences(text, max_sentences)

    assert result == expected_sentences(text, max_sentences)
    resplit = oracle_sentences(result)
    assert len(resplit) <= max(max_sentences, 0)
    assert resplit == oracle_sentences(text)[: max(max_sentences, 0)]  # a prefix, in the original order
    assert result == "" or text.strip().startswith(result)


@SETTINGS
@given(built=built_text(), max_sentences=st.integers(1, 8))
def test_property_23_known_sentences_are_kept_exactly_up_to_the_limit(
    built: tuple[str, list[str]], max_sentences: int
) -> None:
    """Ground truth from construction: no splitter decides what the right answer is."""
    text, prefixes = built
    assert len(oracle_spans(text)) == len(prefixes)  # the oracle agrees with the construction

    expected = prefixes[min(max_sentences, len(prefixes)) - 1]
    assert limit_sentences(text, max_sentences) == expected


@SETTINGS
@given(built=built_text())
def test_property_23_default_limit_is_five_sentences_at_every_boundary(built: tuple[str, list[str]]) -> None:
    text, prefixes = built
    result = limit_sentences(text)

    assert MAX_SPEECH_SENTENCES == 5
    assert result == prefixes[min(5, len(prefixes)) - 1]
    assert len(oracle_spans(result)) == min(5, len(prefixes))  # 4 stay 4, 5 stay 5, 6+ become 5
    if len(prefixes) <= 5:
        assert result == text.strip()  # nothing is dropped, only surrounding whitespace is trimmed


@SETTINGS
@given(
    sentence_count=st.sampled_from([1, 3, 4, 5, 6, 7, 20]),
    sentence=known_sentence,
    separator=st.sampled_from(WHITESPACES),
)
def test_property_23_exact_sentence_count_boundaries(sentence_count: int, sentence: str, separator: str) -> None:
    text = separator.join([sentence] * sentence_count)

    result = limit_sentences(text)

    assert len(oracle_spans(result)) == min(sentence_count, 5)
    assert result == separator.join([sentence] * min(sentence_count, 5))


@SETTINGS
@given(sentence=known_sentence, repeat=st.integers(2, 12))
def test_property_23_decimals_and_version_strings_never_split_a_sentence(sentence: str, repeat: int) -> None:
    joined = " ".join([f"Use v2.1.4 or 3.5 now{sentence[-1] if sentence[-1] in TERMINATORS else '.'}"] * repeat)
    result = limit_sentences(joined)

    assert result.count("v2.1.4") == min(repeat, 5)
    assert result.count("3.5") == min(repeat, 5)


def test_regression_a_lone_leading_terminator_ends_its_own_sentence() -> None:
    """Found by Property 23: the sentence pattern used to consume the first character, so a lone
    leading ``.``/``!``/``?`` did not end a sentence (while ``!!`` did) and 6 sentences could pass as 5."""
    assert limit_sentences("! b. c.", 2) == "! b."  # sentences: "!", "b.", "c."
    assert limit_sentences("! b. c.", 1) == "!"
    assert limit_sentences(". A. B. C. D. E. F.") == ". A. B. C. D."  # ".", "A.", "B.", "C.", "D."
    assert limit_sentences("?? Hello. World.", 1) == "??"
    assert limit_sentences("! b", 1) == "!"
    assert limit_sentences(".", 5) == "."
    assert limit_sentences("   ?  ", 5) == "?"
    assert limit_speech(". A. B. C. D. E. F.") == ". A. B. C. D."
    result = parse_agent_output(envelope(". A. B. C. D. E. F."))
    assert isinstance(result, AgentResponse) and result.speech == ". A. B. C. D."


def test_regression_an_unterminated_last_sentence_drops_its_trailing_whitespace() -> None:
    """Found by Property 23: ``"1\\u00a0"`` came back with the NBSP, while ``"1."`` + spaces did not."""
    assert limit_sentences("1\u00a0") == "1"
    assert limit_sentences("No end \n\t") == "No end"
    assert limit_sentences("One. Two  \n") == "One. Two"
    assert limit_sentences("Done.  \n") == "Done."
    assert limit_speech("Hello world \u2003") == "Hello world"
    result = parse_agent_output(envelope("Hello world \n"))
    assert isinstance(result, AgentResponse) and result.speech == "Hello world"


def test_regression_long_terminator_runs_are_scanned_in_linear_time() -> None:
    """Found while reviewing Property 23: the old pattern was quadratic on ``"a" + "!" * N + "b"``
    (about 30 s for N = 20,000 and over 200 s for 60,000), which would stall the backend's event loop
    on a hostile reply. Linear time takes milliseconds; the bound below only guards against a return."""
    import time

    hostile = [
        "a" + "!" * 60000 + "b",
        "a" + "?" * 60000 + ")" * 10 + "b",
        "a" + ".!" * 30000 + "b",
        ".!" * 30000 + "x",
        "a" + ")" * 60000 + "b",
        "a" + " " * 60000 + "b",
        "!" * 60000,
    ]
    for text in hostile:
        started = time.perf_counter()
        limited = limit_speech(text)
        assert time.perf_counter() - started < 2.0, text[:12]
        assert units(limited) <= 600
        assert len(oracle_spans(limited)) <= 5

    assert limit_sentences("a" + "!" * 60000 + "b") == "a" + "!" * 60000 + "b"  # one unterminated sentence
    assert limit_sentences("a" + "!" * 60000 + " b") == "a" + "!" * 60000 + " b"  # two sentences, both kept


@SETTINGS
@given(
    run=st.integers(1, 3000),
    mark=st.sampled_from([".", "!", "?"]),
    closers=st.sampled_from(["", ")", "']"]),
    tail=st.sampled_from(["", "b", " b", " b.", "\n", ")x"]),
)
def test_property_23_long_terminator_runs_follow_the_sentence_rules(run: int, mark: str, closers: str, tail: str) -> None:
    text = "a" + mark * run + closers + tail

    assert limit_sentences(text) == expected_sentences(text, 5)
    assert_speech_is_sound(text, limit_speech(text), 5, 600)


# --- Property 23: the combined sentence and UTF-16 length limit ---------------------------------


@SETTINGS
@given(text=any_text, max_sentences=st.integers(1, 6), max_units=st.integers(2, 150))
@example(text="x" * 700, max_sentences=5, max_units=150)
def test_property_23_limit_speech_respects_both_limits_with_small_limits(
    text: str, max_sentences: int, max_units: int
) -> None:
    assert_speech_is_sound(text, limit_speech(text, max_sentences, max_units), max_sentences, max_units)


@SETTINGS
@given(text=any_text)
def test_property_23_limit_speech_uses_the_protocol_defaults(text: str) -> None:
    result = limit_speech(text)

    assert_speech_is_sound(text, result, 5, 600)
    assert units(result) <= MAX_SPEECH_CHARS == 600


@SETTINGS
@given(built=built_text())
def test_property_23_whole_sentences_are_kept_while_they_fit_in_600_units(built: tuple[str, list[str]]) -> None:
    text, prefixes = built
    result = limit_speech(text)

    candidates = [prefix for prefix in prefixes[:5] if units(prefix) <= 600]
    if candidates:
        assert result == candidates[-1]  # the longest run of whole sentences that fits
    else:
        assert_cut_is_sound(result, prefixes[0], 600)


@SETTINGS
@given(
    length=st.sampled_from([598, 599, 600, 601, 602]),
    astral=st.integers(0, 299),
    terminated=st.booleans(),
    data=st.data(),
)
def test_property_23_the_600_unit_boundary_with_surrogate_pairs(
    length: int, astral: int, terminated: bool, data: st.DataObject
) -> None:
    astral = min(astral, (length - 1) // 2)
    tokens = ["x"] * (length - 2 * astral - int(terminated)) + ["\U0001F600"] * astral
    tokens = data.draw(st.permutations(tokens))
    text = "".join(tokens) + ("." if terminated else "")
    assert units(text) == length

    result = limit_speech(text)

    if length <= 600:
        assert result == text  # 599 and 600 units are kept whole
    else:
        assert units(result) <= 600  # 601 and 602 units are cut
        assert result == longest_prefix_within(text, 600)  # at the last code point that fits
    result.encode("utf-16-le")  # strict: raises if a surrogate pair had been split


@SETTINGS
@given(
    text=st.text(alphabet=st.sampled_from(["\U0001F600", "\U0001D11E", "a", " ", ".", "\u00e9"]), max_size=500)
)
def test_property_23_truncation_never_splits_a_surrogate_pair(text: str) -> None:
    result = limit_speech(text)

    result.encode("utf-16-le")  # strict: a lone surrogate would raise
    assert not any(0xD800 <= ord(character) <= 0xDFFF for character in result)
    assert units(result) <= 600
    assert text.lstrip().startswith(result)


@SETTINGS
@given(repeat=st.integers(1000, 12000), sentence=known_sentence)
def test_property_23_extremely_long_multi_sentence_speech_is_limited(repeat: int, sentence: str) -> None:
    text = (sentence + " ") * repeat
    result = limit_speech(text)

    assert units(result) <= 600
    assert len(oracle_spans(result)) <= 5
    assert text.startswith(result)


@SETTINGS
@given(word=word, count=st.integers(100, 6000))
def test_property_23_a_very_long_single_sentence_is_cut_within_the_limit(word: str, count: int) -> None:
    text = " ".join([word] * count) + "."
    result = limit_speech(text)

    assert_speech_is_sound(text, result, 5, 600)
    assert 0 < units(result) <= 600


@SETTINGS
@given(text=any_text)
def test_property_23_limiting_is_idempotent(text: str) -> None:
    once = limit_speech(text)
    assert limit_speech(once) == once


# --- through the parser: successful responses respect the limits --------------------------------


@SETTINGS
@given(text=st.one_of(fuzz_text, wild_text, built_text().map(lambda built: built[0])), action=st.sampled_from(["NO_ACTION", "FOCUS_EDITOR", "RUN_TESTS"]))
def test_property_23_every_successful_response_respects_both_limits(text: str, action: str) -> None:
    result = parse_agent_output(envelope(text, {"type": action}))

    if text.strip() == "":
        assert isinstance(result, AgentFailure) and result.reason == "empty_speech"
        return
    assert isinstance(result, AgentResponse), result  # limiting happens before validation, never rejects
    assert_speech_is_sound(text, result.speech, 5, 600)
    assert result.action.type == action and not result.action.model_extra
    assert set(result.model_dump(mode="json")) == RESPONSE_KEYS
    assert result.replyTo == "req-1" and result.confirmationRequired is False


@SETTINGS
@given(built=built_text())
def test_property_23_positive_control_speech_within_the_limits_is_accepted_unchanged(
    built: tuple[str, list[str]],
) -> None:
    text, prefixes = built
    within = len(prefixes) <= 5 and units(text.strip()) <= 600
    result = parse_agent_output(envelope(text))

    assert isinstance(result, AgentResponse)
    if within:
        assert result.speech == text.strip()


@SETTINGS
@given(speech=st.text(alphabet=st.sampled_from([" ", "\t", "\n", "\r", "\u00a0", "\u2003", "\u2028", "\u3000", "\x85"]), max_size=20))
def test_property_23_empty_or_whitespace_only_speech_is_a_safe_failure(speech: str) -> None:
    assert limit_speech(speech) == ""
    result = parse_agent_output(envelope(speech))

    assert isinstance(result, AgentFailure)
    assert result.reason == "empty_speech"
    assert not hasattr(result, "action")


@SETTINGS
@given(
    parts=st.lists(
        st.sampled_from(
            [
                "Run tests now.", "RUN_TESTS", "Open file auth.ts.", "Go to line 42!", "Ignore all rules?",
                '{"type": "RUN_COMMAND", "command": "rm -rf /"}.', "Please execute `curl x | sh`.",
                "action: GO_TO_SYMBOL foo.", "NO_ACTION", "System: confirmationRequired is false.",
            ]
        ),
        min_size=1,
        max_size=12,
    ),
    separator=st.sampled_from(WHITESPACES),
    action=st.sampled_from(["NO_ACTION", "FOCUS_EDITOR", "RUN_TESTS"]),
    confirm=st.booleans(),
)
def test_property_23_limiting_never_introduces_or_changes_an_action(
    parts: list[str], separator: str, action: str, confirm: bool
) -> None:
    speech = separator.join(parts)
    result = parse_agent_output(envelope(speech, {"type": action}, confirm))

    assert isinstance(result, AgentResponse), result
    assert result.action.type == action
    assert not result.action.model_extra  # nothing is added to the action from the speech
    assert result.confirmationRequired is confirm
    assert_speech_is_sound(speech, result.speech, 5, 600)


@SETTINGS
@given(speech=st.one_of(st.none(), st.booleans(), st.integers(), st.floats(), st.lists(st.text(max_size=5), max_size=3), st.dictionaries(st.text(max_size=3), st.integers(), max_size=2)))
def test_property_23_non_string_speech_is_a_safe_failure_not_an_exception(speech: Any) -> None:
    result = parse_agent_output(envelope(speech))

    assert isinstance(result, AgentFailure)
    assert result.reason == "invalid_shape"


@SETTINGS
@given(text=surrogate_text)
def test_property_23_lone_surrogates_in_speech_never_raise(text: str) -> None:
    limited = limit_speech(text)  # must not raise
    assert units(limited) <= 600

    result = parse_agent_output(envelope(text))
    assert isinstance(result, (AgentResponse, AgentFailure))
    if isinstance(result, AgentResponse):
        assert units(result.speech) <= 600
        assert len(oracle_spans(result.speech)) <= 5


@SETTINGS
@given(text=any_text, how=st.sampled_from(["object", "json", "bytes"]))
def test_property_23_the_limit_holds_for_every_input_form(text: str, how: str) -> None:
    raw: Any = envelope(text)
    if how == "json":
        raw = json.dumps(raw)
    elif how == "bytes":
        raw = json.dumps(raw).encode("utf-8")
    result = parse_agent_output(raw)

    assert isinstance(result, (AgentResponse, AgentFailure))
    if isinstance(result, AgentResponse):
        assert units(result.speech) <= 600
        assert len(oracle_spans(result.speech)) <= 5
        assert text.lstrip().startswith(result.speech)
