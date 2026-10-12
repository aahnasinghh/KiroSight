"""Backend allow-list registry: the only actions the agent may propose (Requirements 5.1, 5.6, 5.8).

This module defines typed action DATA only. The backend never executes anything; the extension
host is the sole executor and re-validates every action with its own registry
(``extension/src/actions/allowlist.ts`` and ``actionValidator.ts``), which this file mirrors.

Rules:

* Exactly eight actions. There is no ``RUN_COMMAND`` and no ``GO_TO_SYMBOL``.
* Risk comes from the registry, never from model output. ``RUN_TESTS`` is ``needs-confirmation``.
* Each parameter model forbids unknown fields. No model has a command/shell/executable field,
  and ``RUN_TESTS`` takes no parameters: the test command comes from trusted extension settings.
* The registry holds no callables and no command strings.

The action ``type`` is the registry key, so parameter models describe only the other fields.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, field_validator

__all__ = [
    "ALLOWED_ACTIONS",
    "ActionSpec",
    "FocusEditorParams",
    "GoToDiagnosticParams",
    "GoToLineParams",
    "NextDiagnosticParams",
    "NoActionParams",
    "OpenFileParams",
    "PreviousDiagnosticParams",
    "Risk",
    "RunTestsParams",
    "Severity",
]

Risk = Literal["safe", "needs-confirmation"]
Severity = Literal["error", "warning", "any"]

# Mirrors Number.MAX_SAFE_INTEGER used by the extension validator.
MAX_SAFE_INTEGER = 2**53 - 1
# Mirrors MAX_ACTION_PATH_CHARS in extension/src/actions/actionValidator.ts.
MAX_ACTION_PATH_CHARS = 256


class _ActionParams(BaseModel):
    """Base for all parameter models: unknown fields are rejected, never dropped."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class NoActionParams(_ActionParams):
    """NO_ACTION takes no parameters."""


class GoToDiagnosticParams(_ActionParams):
    """``index`` is a 0-based position in navigation order; ``severity`` is optional."""

    index: Annotated[StrictInt, Field(ge=0, le=MAX_SAFE_INTEGER)]
    severity: Severity | None = None


class NextDiagnosticParams(_ActionParams):
    severity: Severity | None = None


class PreviousDiagnosticParams(_ActionParams):
    severity: Severity | None = None


class OpenFileParams(_ActionParams):
    """``path`` is a file name or workspace-relative path, passed through unchanged."""

    path: Annotated[StrictStr, Field(min_length=1, max_length=MAX_ACTION_PATH_CHARS)]

    @field_validator("path")
    @classmethod
    def _no_nul(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("path must not contain NUL characters")
        return value


class GoToLineParams(_ActionParams):
    """``line`` is 1-indexed."""

    line: Annotated[StrictInt, Field(ge=1, le=MAX_SAFE_INTEGER)]


class FocusEditorParams(_ActionParams):
    """FOCUS_EDITOR takes no parameters."""


class RunTestsParams(_ActionParams):
    """RUN_TESTS takes no parameters, ever. The test command is trusted extension configuration."""


@dataclass(frozen=True)
class ActionSpec:
    """Immutable registry entry: a risk class and the strict parameter model. Data only."""

    risk: Risk
    params_model: type[_ActionParams]

    def validate_params(self, params: Mapping[str, Any]) -> _ActionParams:
        """Validate the non-``type`` fields of an action. Raises ``pydantic.ValidationError``."""
        return self.params_model.model_validate(params)


ALLOWED_ACTIONS: dict[str, ActionSpec] = {
    "NO_ACTION": ActionSpec(risk="safe", params_model=NoActionParams),
    "GO_TO_DIAGNOSTIC": ActionSpec(risk="safe", params_model=GoToDiagnosticParams),
    "NEXT_DIAGNOSTIC": ActionSpec(risk="safe", params_model=NextDiagnosticParams),
    "PREVIOUS_DIAGNOSTIC": ActionSpec(risk="safe", params_model=PreviousDiagnosticParams),
    "OPEN_FILE": ActionSpec(risk="safe", params_model=OpenFileParams),
    "GO_TO_LINE": ActionSpec(risk="safe", params_model=GoToLineParams),
    "FOCUS_EDITOR": ActionSpec(risk="safe", params_model=FocusEditorParams),
    "RUN_TESTS": ActionSpec(risk="needs-confirmation", params_model=RunTestsParams),
}
