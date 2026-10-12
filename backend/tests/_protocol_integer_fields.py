"""Shared table of every schema-defined INTEGER field in the backend protocol.

Mirrors each ``z.number().int()`` in ``extension/src/protocol/validators.ts``. JSON has one number
type, so ``5``, ``5.0`` and ``5e0`` are the same wire value: JavaScript decodes them all to 5, and
the Python side must accept all of them and normalize to the integer 5. Fields that TypeScript does
not require to be integers (``durationMs``) and loose ``ActionEnvelope`` extras are NOT listed.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any, NamedTuple

FIXTURES = (
    Path(__file__).resolve().parents[2] / "extension" / "src" / "protocol" / "fixtures" / "messages"
)
SENTINEL = "__INT__"
Message = dict[str, Any]

VALID_TEST_RUN: Message = {
    "outcome": "failed",
    "command": "npm test",
    "exitCode": 1,
    "passed": 3,
    "failed": 1,
    "totalFailedNames": 1,
    "failingTests": [{"name": "sample test"}],
    "outputTruncated": False,
    "durationMs": 1200,
}


def fixture(name: str) -> Message:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def _agent_request_test_run() -> Message:
    message = fixture("agent_request")
    message["kind"] = "summarize_test_run"
    message["testRun"] = copy.deepcopy(VALID_TEST_RUN)
    return message


def _action_result_with(details: Message) -> Callable[[], Message]:
    def build() -> Message:
        message = fixture("action_result")
        message["result"]["details"] = copy.deepcopy(details)
        return message

    return build


BASES: dict[str, Callable[[], Message]] = {
    "hello_ack": lambda: fixture("hello_ack"),
    "agent_request": lambda: fixture("agent_request"),
    "agent_request_test_run": _agent_request_test_run,
    "action_result_diagnostic": lambda: fixture("action_result"),
    "action_result_location": _action_result_with(
        {"kind": "location_reached", "relativePath": "src/a.ts", "line": 3}
    ),
    "action_result_ambiguous": _action_result_with(
        {"kind": "ambiguous_files", "matches": ["a/x.ts", "b/x.ts"], "totalMatches": 2}
    ),
    "action_result_test_run": _action_result_with({"kind": "test_run", "summary": VALID_TEST_RUN}),
}


class IntegerField(NamedTuple):
    base: str
    path: tuple[str | int, ...]
    minimum: int | None  # None = no lower bound in the schema
    nullable: bool = False

    @property
    def label(self) -> str:
        return f"{self.base}:" + ".".join(str(part) for part in self.path)


def _fields() -> list[IntegerField]:
    ctx = ("context",)
    fields = [
        IntegerField("hello_ack", ("supportedVersions", 0), None),
        IntegerField("agent_request", (*ctx, "workspace", "rootCount"), 0),
        IntegerField("agent_request", (*ctx, "cursor", "line"), 1),
        IntegerField("agent_request", (*ctx, "cursor", "column"), 1),
        IntegerField("agent_request", (*ctx, "nearbyCode", "startLine"), 1),
        IntegerField("agent_request", (*ctx, "nearbyCode", "endLine"), 1),
        IntegerField("agent_request", (*ctx, "currentSymbol", "startLine"), 1),
        IntegerField("agent_request", (*ctx, "currentSymbol", "endLine"), 1),
        IntegerField("agent_request", (*ctx, "diagnostics", 0, "line"), 1),
        IntegerField("agent_request", (*ctx, "diagnostics", 0, "column"), 1),
    ]
    for edge in ("start", "end"):
        for axis in ("line", "column"):
            fields.append(IntegerField("agent_request", (*ctx, "selection", edge, axis), 1))
    for severity in ("error", "warning", "information", "hint"):
        fields.append(IntegerField("agent_request", (*ctx, "diagnosticCounts", severity), 0))
    fields += [
        IntegerField("agent_request_test_run", ("testRun", "exitCode"), None, nullable=True),
        IntegerField("agent_request_test_run", ("testRun", "passed"), 0, nullable=True),
        IntegerField("agent_request_test_run", ("testRun", "failed"), 0, nullable=True),
        IntegerField("agent_request_test_run", ("testRun", "totalFailedNames"), 0),
        IntegerField("action_result_diagnostic", ("result", "details", "line"), 1),
        IntegerField("action_result_location", ("result", "details", "line"), 1),
        IntegerField("action_result_ambiguous", ("result", "details", "totalMatches"), 0),
        IntegerField("action_result_test_run", ("result", "details", "summary", "exitCode"), None, nullable=True),
        IntegerField("action_result_test_run", ("result", "details", "summary", "passed"), 0, nullable=True),
        IntegerField("action_result_test_run", ("result", "details", "summary", "failed"), 0, nullable=True),
        IntegerField("action_result_test_run", ("result", "details", "summary", "totalFailedNames"), 0),
    ]  # fmt: skip
    # Covers every model that holds an integer: HelloAck, Workspace, Pos (cursor and selection),
    # CodeExcerpt, CurrentSymbol, DiagnosticInfo, DiagnosticCounts, TestRunSummary and the details.
    return fields


INTEGER_FIELDS = _fields()


def get_at(message: Any, path: tuple[str | int, ...]) -> Any:
    for part in path:
        message = message[part]
    return message


def set_at(message: Any, path: tuple[str | int, ...], value: Any) -> None:
    get_at(message, path[:-1])[path[-1]] = value


def decode_with_spelling(field: IntegerField, spelling: str) -> Message:
    """Build the base, put a placeholder at the field, substitute the JSON spelling, json.loads."""
    base = BASES[field.base]()
    set_at(base, field.path, SENTINEL)
    return json.loads(json.dumps(base).replace(f'"{SENTINEL}"', spelling))
