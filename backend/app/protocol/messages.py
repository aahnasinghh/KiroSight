"""Extension host <-> backend wire models (Requirements 11.1, 11.2, 11.3).

Mirrors ``extension/src/protocol/{constants,messages,validators}.ts`` exactly. Field names keep the
wire's camelCase spelling (``replyTo``, ``mimeType``...) so ``model_dump`` is the wire form.

Strictness matches the Zod schemas:

* every message and nested payload forbids unknown fields (``extra="forbid"``);
* booleans and strings are strict, so ``True`` and ``"1"`` never become numbers;
* integer fields (and the protocol ``version``) accept any finite, mathematically integral JSON
  number, so ``5`` and ``5.0`` are the same wire value as in JavaScript. They are normalized to
  ``int`` and keep their bounds. Nothing else is coerced, and loose action extras are untouched;
* optional fields may be absent but are NOT nullable (an explicit ``null`` is rejected), exactly
  like Zod's ``.optional()``;
* the one deliberate exception is :class:`ActionEnvelope`, which keeps unknown action fields.
  Allow-list checking is *not* done here; ``backend/app/allowlist.py`` and the extension's
  ``ActionValidator`` own that, and this module must never import them.

Use :func:`dump_message` to serialize a parsed message back to its wire dict.
"""

from __future__ import annotations

import math
import re
from typing import Annotated, Any, Final, Literal, get_args

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    TypeAdapter,
    model_validator,
)

__all__ = [
    "BACKEND_MESSAGE_TYPES",
    "ERROR_CODES",
    "PROTOCOL_MESSAGE_ADAPTER",
    "PROTOCOL_VERSION",
    "ActionEnvelope",
    "ActionRequest",
    "ActionResult",
    "ActionResultMessage",
    "AgentRequest",
    "AgentResponse",
    "AudioClip",
    "Cancel",
    "Capabilities",
    "ErrorCode",
    "ErrorMessage",
    "Hello",
    "HelloAck",
    "ProtocolMessage",
    "RecordStart",
    "RecordStop",
    "SpeechAudio",
    "SpeechRequest",
    "TestRunSummary",
    "TranscriptionResult",
    "UserUtterance",
    "WireContext",
    "dump_message",
]

PROTOCOL_VERSION: Final = 1

# Mirrors constants.ts.
MAX_UTTERANCE_CHARS: Final = 4000
MAX_SPEECH_CHARS: Final = 600
MAX_AMBIGUOUS_MATCHES: Final = 10
MAX_DIAGNOSTICS_SENT: Final = 25
MAX_DIAGNOSTIC_MESSAGE_CHARS: Final = 500
MAX_CONTEXT_EXCERPT_CHARS: Final = 6000
MAX_FAILING_TESTS: Final = 20
# Zod's .int() accepts safe integers only.
MAX_SAFE_INTEGER: Final = 2**53 - 1  # Number.MAX_SAFE_INTEGER
MIN_SAFE_INTEGER: Final = -MAX_SAFE_INTEGER  # Number.MIN_SAFE_INTEGER

ErrorCode = Literal[
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
]
ERROR_CODES: Final[tuple[str, ...]] = get_args(ErrorCode)

BACKEND_MESSAGE_TYPES: Final[tuple[str, ...]] = (
    "hello",
    "agent_request",
    "action_result",
    "record_start",
    "record_stop",
    "audio_clip",
    "speech_request",
    "cancel",
    "hello_ack",
    "agent_response",
    "action_request",
    "transcription_result",
    "speech_audio",
    "error_message",
)

# --- validation helpers ---

_ABSOLUTE_PATH = re.compile(r"^(?:[A-Za-z]:[\\/]|[\\]{2}|/)")


def _reject_null(value: Any) -> Any:
    """Optional fields may be absent but never null (Zod ``.optional()`` semantics)."""
    if value is None:
        raise ValueError("must not be null")
    return value


def is_protocol_version(value: Any) -> bool:
    """True only for a JSON number equal to 1: Python ``1`` or ``1.0``.

    JavaScript has a single number type, so ``JSON.parse("1.0")`` is the supported version 1 and
    the Python side must agree (``json.loads("1.0")`` is the float ``1.0``). ``type(...)`` is
    compared exactly so ``bool`` (a subclass of ``int``) never qualifies; strings, ``None``, NaN and
    infinities are not equal to 1.
    """
    return type(value) in (int, float) and value == PROTOCOL_VERSION


def _normalize_protocol_version(value: Any) -> Any:
    """Accept numeric 1 / 1.0 and normalize to the canonical integer 1 (version only)."""
    if is_protocol_version(value):
        return PROTOCOL_VERSION
    raise ValueError("unsupported protocol version")


def _must_be_true(value: bool) -> bool:
    if value is not True:
        raise ValueError("must be true")
    return value


def _must_be_false(value: bool) -> bool:
    if value is not False:
        raise ValueError("must be false")
    return value


def _not_absolute_path(value: str) -> str:
    if _ABSOLUTE_PATH.match(value):
        raise ValueError("must be a workspace-relative path")
    return value


def _max_utf16_units(limit: int) -> AfterValidator:
    """Length cap counted in UTF-16 code units, like JavaScript's ``string.length``."""

    def check(value: str) -> str:
        if len(value.encode("utf-16-le", "surrogatepass")) // 2 > limit:
            raise ValueError("too long")
        return value

    return AfterValidator(check)


_NoNull = BeforeValidator(_reject_null)

def _integral_number(value: Any) -> int:
    """JSON-level integer: a finite, mathematically integral number, normalized to ``int``.

    JSON has one number type, so ``5``, ``5.0`` and ``5e0`` are the same wire value and
    ``z.number().int()`` accepts all of them in TypeScript. Python decodes the last two as floats.
    Exact ``type()`` checks keep ``bool`` (a subclass of ``int``) and numeric strings out; NaN and
    infinities are not integral. Field bounds are applied afterwards by the field constraints.
    """
    if type(value) is int:
        candidate: int | float = value
    elif type(value) is float and math.isfinite(value) and value.is_integer():
        candidate = value
    else:
        raise ValueError("must be an integer")
    # Zod 4's .int() accepts safe integers only. Checked BEFORE converting, so a huge float such as
    # 1e300 or 2**53 + 1 is rejected here rather than relying on a later bound.
    if not MIN_SAFE_INTEGER <= candidate <= MAX_SAFE_INTEGER:
        raise ValueError("must be a safe integer")
    return int(candidate)


_IntegralNumber = BeforeValidator(_integral_number)

# Only schema-defined integer fields use these; loose ActionEnvelope extras are never normalized.
SafeInt = Annotated[StrictInt, Field(ge=MIN_SAFE_INTEGER, le=MAX_SAFE_INTEGER), _IntegralNumber]
NonNegativeInt = Annotated[StrictInt, Field(ge=0, le=MAX_SAFE_INTEGER), _IntegralNumber]
PositiveInt = Annotated[StrictInt, Field(ge=1, le=MAX_SAFE_INTEGER), _IntegralNumber]
RelativePath = Annotated[StrictStr, AfterValidator(_not_absolute_path)]
# The one deliberate numeric exception: the version is a JSON number equal to 1, normalized to 1.
ProtocolVersion = Annotated[StrictInt, BeforeValidator(_normalize_protocol_version)]


class _Strict(BaseModel):
    """Shared base: unknown fields are rejected, instances are immutable."""

    model_config = ConfigDict(extra="forbid", frozen=True)


# --- IDEContext wire payload (no activeFile, no absolute paths) ---


class Pos(_Strict):
    line: PositiveInt
    column: PositiveInt


class CodeExcerpt(_Strict):
    source: Literal["selection", "symbol", "cursor_window"]
    startLine: PositiveInt
    endLine: PositiveInt
    text: Annotated[StrictStr, _max_utf16_units(MAX_CONTEXT_EXCERPT_CHARS)]
    truncated: StrictBool


class EmptySelection(_Strict):
    isEmpty: Annotated[StrictBool, AfterValidator(_must_be_true)]


class RangeSelection(_Strict):
    isEmpty: Annotated[StrictBool, AfterValidator(_must_be_false)]
    start: Pos
    end: Pos


class CurrentSymbol(_Strict):
    name: StrictStr
    kind: StrictStr
    startLine: PositiveInt
    endLine: PositiveInt


class DiagnosticInfo(_Strict):
    severity: Literal["error", "warning", "information", "hint"]
    relativePath: RelativePath
    line: PositiveInt
    column: PositiveInt
    message: Annotated[StrictStr, _max_utf16_units(MAX_DIAGNOSTIC_MESSAGE_CHARS)]
    source: Annotated[StrictStr | None, _NoNull] = None
    code: Annotated[StrictStr | None, _NoNull] = None
    symbolName: StrictStr | None = None


class Workspace(_Strict):
    name: StrictStr | None
    rootCount: NonNegativeInt


class DiagnosticCounts(_Strict):
    error: NonNegativeInt
    warning: NonNegativeInt
    information: NonNegativeInt
    hint: NonNegativeInt


class WireContext(_Strict):
    workspace: Workspace
    relativePath: RelativePath | None
    languageId: StrictStr | None
    cursor: Pos | None
    selection: EmptySelection | RangeSelection | None
    nearbyCode: CodeExcerpt | None
    currentSymbol: CurrentSymbol | None
    symbolStatus: Literal["found", "none_enclosing", "provider_unavailable", "no_editor"]
    diagnostics: Annotated[list[DiagnosticInfo], Field(strict=True, max_length=MAX_DIAGNOSTICS_SENT)]
    diagnosticCounts: DiagnosticCounts


class UserUtterance(_Strict):
    text: Annotated[StrictStr, _max_utf16_units(MAX_UTTERANCE_CHARS)]
    source: Annotated[Literal["typed", "voice"] | None, _NoNull] = None


# --- test run summary (wire form) ---


class FailingTest(_Strict):
    name: StrictStr
    messageExcerpt: Annotated[StrictStr | None, _NoNull] = None


class TestRunSummary(_Strict):
    __test__ = False  # not a pytest class

    outcome: Literal[
        "passed",
        "failed",
        "completed_unparsed",
        "did_not_execute",
        "timed_out",
        "cancelled",
        "not_configured",
    ]
    command: StrictStr
    exitCode: SafeInt | None
    passed: NonNegativeInt | None
    failed: NonNegativeInt | None
    totalFailedNames: NonNegativeInt
    failingTests: Annotated[list[FailingTest], Field(strict=True, max_length=MAX_FAILING_TESTS)]
    outputTruncated: StrictBool
    durationMs: Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)]


# --- ActionResult (wire form) ---


class FileOpenedDetails(_Strict):
    kind: Literal["file_opened"]
    relativePath: RelativePath


class DiagnosticReachedDetails(_Strict):
    kind: Literal["diagnostic_reached"]
    relativePath: RelativePath
    line: PositiveInt
    severity: StrictStr
    message: StrictStr
    symbol: Annotated[StrictStr | None, _NoNull] = None
    wrapped: Annotated[StrictBool | None, _NoNull] = None


class LocationReachedDetails(_Strict):
    kind: Literal["location_reached"]
    relativePath: RelativePath
    line: PositiveInt


class AmbiguousFilesDetails(_Strict):
    kind: Literal["ambiguous_files"]
    matches: Annotated[list[RelativePath], Field(strict=True, max_length=MAX_AMBIGUOUS_MATCHES)]
    totalMatches: NonNegativeInt


class TestRunDetails(_Strict):
    __test__ = False  # not a pytest class

    kind: Literal["test_run"]
    summary: TestRunSummary


ActionResultDetails = Annotated[
    FileOpenedDetails
    | DiagnosticReachedDetails
    | LocationReachedDetails
    | AmbiguousFilesDetails
    | TestRunDetails,
    Field(discriminator="kind"),
]


class ActionResult(_Strict):
    """``actionType`` is a plain string: an unknown agent action still gets ``not_permitted``."""

    actionType: StrictStr
    status: Literal[
        "ok", "failed", "declined", "not_permitted", "needs_clarification", "not_configured"
    ]
    message: StrictStr
    details: Annotated[ActionResultDetails | None, _NoNull] = None


class ActionEnvelope(BaseModel):
    """Object with a string ``type``. Every other field is preserved untouched.

    This is deliberately NOT ``extra="forbid"``: strict allow-list and parameter checks belong to
    the allow-list / ActionValidator, never to the protocol layer.
    """

    model_config = ConfigDict(extra="allow", frozen=True)

    type: StrictStr


class Capabilities(_Strict):
    bedrock: StrictBool
    stt: StrictBool
    tts: StrictBool
    mic: Literal["available", "unavailable", "denied", "not_applicable"]


# --- messages ---


class _Message(_Strict):
    version: ProtocolVersion


class Hello(_Message):
    type: Literal["hello"]
    token: Annotated[StrictStr | None, _NoNull] = None
    client: Literal["kirosight-extension"]


class AgentRequest(_Message):
    type: Literal["agent_request"]
    id: StrictStr
    kind: Literal["utterance", "summarize_test_run"]
    utterance: Annotated[UserUtterance | None, _NoNull] = None
    context: WireContext
    testRun: Annotated[TestRunSummary | None, _NoNull] = None


class ActionResultMessage(_Message):
    type: Literal["action_result"]
    replyTo: StrictStr
    result: ActionResult


class RecordStart(_Message):
    type: Literal["record_start"]
    id: StrictStr


class RecordStop(_Message):
    type: Literal["record_stop"]
    id: StrictStr


class AudioClip(_Message):
    type: Literal["audio_clip"]
    id: StrictStr
    mimeType: StrictStr
    base64: StrictStr
    # A chunked recording: ordered frames sharing ``id``, ``seq`` from 0, ``final`` on the last.
    # The two fields travel together; a whole-recording frame carries neither.
    seq: Annotated[NonNegativeInt | None, _NoNull] = None
    final: Annotated[StrictBool | None, _NoNull] = None

    @model_validator(mode="after")
    def _seq_and_final_together(self) -> AudioClip:
        if (self.seq is None) != (self.final is None):
            raise ValueError("seq and final must be given together")
        return self


class SpeechRequest(_Message):
    type: Literal["speech_request"]
    id: StrictStr
    replyTo: Annotated[StrictStr | None, _NoNull] = None
    text: StrictStr


class Cancel(_Message):
    type: Literal["cancel"]
    targetId: StrictStr


class HelloAck(_Message):
    type: Literal["hello_ack"]
    supportedVersions: Annotated[list[SafeInt], Field(strict=True)]
    capabilities: Capabilities


class AgentResponse(_Message):
    type: Literal["agent_response"]
    replyTo: StrictStr
    speech: Annotated[StrictStr, _max_utf16_units(MAX_SPEECH_CHARS)]
    action: ActionEnvelope
    confirmationRequired: StrictBool


class ActionRequest(_Message):
    type: Literal["action_request"]
    id: StrictStr
    action: ActionEnvelope
    reason: StrictStr


class TranscriptionResult(_Message):
    type: Literal["transcription_result"]
    replyTo: StrictStr
    text: StrictStr


class SpeechAudio(_Message):
    type: Literal["speech_audio"]
    replyTo: StrictStr
    mimeType: StrictStr
    base64: StrictStr


class ErrorMessage(_Message):
    type: Literal["error_message"]
    replyTo: Annotated[StrictStr | None, _NoNull] = None
    code: ErrorCode
    message: StrictStr
    recoverable: StrictBool


ProtocolMessage = Annotated[
    Hello
    | AgentRequest
    | ActionResultMessage
    | RecordStart
    | RecordStop
    | AudioClip
    | SpeechRequest
    | Cancel
    | HelloAck
    | AgentResponse
    | ActionRequest
    | TranscriptionResult
    | SpeechAudio
    | ErrorMessage,
    Field(discriminator="type"),
]

#: Built once and reused for every parse.
PROTOCOL_MESSAGE_ADAPTER: Final = TypeAdapter(ProtocolMessage)


def dump_message(message: BaseModel) -> dict[str, Any]:
    """Serialize a parsed message to its wire dict.

    ``exclude_unset`` keeps absent optional fields absent while preserving explicit nulls and any
    extra action fields.
    """
    return message.model_dump(mode="json", exclude_unset=True)
