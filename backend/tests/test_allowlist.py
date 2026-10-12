"""Task 6.6 deterministic tests for the backend allow-list registry.

The shared JSON parity fixture and the Python/TypeScript parity tests belong to Task 6.7.
"""

from __future__ import annotations

import dataclasses
from typing import Any

import pytest
from pydantic import ValidationError

from app import allowlist
from app.allowlist import (
    ALLOWED_ACTIONS,
    MAX_ACTION_PATH_CHARS,
    MAX_SAFE_INTEGER,
    ActionSpec,
    FocusEditorParams,
    GoToDiagnosticParams,
    GoToLineParams,
    NextDiagnosticParams,
    NoActionParams,
    OpenFileParams,
    PreviousDiagnosticParams,
    RunTestsParams,
)

EXPECTED_RISKS = {
    "NO_ACTION": "safe",
    "GO_TO_DIAGNOSTIC": "safe",
    "NEXT_DIAGNOSTIC": "safe",
    "PREVIOUS_DIAGNOSTIC": "safe",
    "OPEN_FILE": "safe",
    "GO_TO_LINE": "safe",
    "FOCUS_EDITOR": "safe",
    "RUN_TESTS": "needs-confirmation",
}

EXPECTED_MODELS = {
    "NO_ACTION": NoActionParams,
    "GO_TO_DIAGNOSTIC": GoToDiagnosticParams,
    "NEXT_DIAGNOSTIC": NextDiagnosticParams,
    "PREVIOUS_DIAGNOSTIC": PreviousDiagnosticParams,
    "OPEN_FILE": OpenFileParams,
    "GO_TO_LINE": GoToLineParams,
    "FOCUS_EDITOR": FocusEditorParams,
    "RUN_TESTS": RunTestsParams,
}

NO_PARAM_ACTIONS = ["NO_ACTION", "FOCUS_EDITOR", "RUN_TESTS"]
FORBIDDEN_FIELD_NAMES = {"command", "cmd", "shell", "executable", "args", "script", "exec"}


# ------------------------------------------------------------------ registry


def test_registry_has_exactly_the_eight_mvp_actions() -> None:
    assert len(ALLOWED_ACTIONS) == 8
    assert set(ALLOWED_ACTIONS) == set(EXPECTED_RISKS)


@pytest.mark.parametrize("name", ["RUN_COMMAND", "GO_TO_SYMBOL"])
def test_forbidden_actions_are_absent(name: str) -> None:
    assert name not in ALLOWED_ACTIONS
    assert ALLOWED_ACTIONS.get(name) is None


@pytest.mark.parametrize(
    "name",
    [
        "EDIT_FILE", "APPLY_FIX", "WRITE_FILE", "EXECUTE_COMMAND", "TERMINAL", "SHELL",
        "run_tests", "Run_Tests", "go_to_line", "RUN_TESTS ", "", "unknown",
    ],
)
def test_unknown_or_near_miss_names_fail_closed(name: str) -> None:
    assert name not in ALLOWED_ACTIONS
    with pytest.raises(KeyError):
        ALLOWED_ACTIONS[name]


@pytest.mark.parametrize("name, risk", EXPECTED_RISKS.items())
def test_each_action_has_the_approved_risk_class(name: str, risk: str) -> None:
    assert ALLOWED_ACTIONS[name].risk == risk


def test_run_tests_is_the_only_needs_confirmation_action() -> None:
    confirming = {n for n, s in ALLOWED_ACTIONS.items() if s.risk == "needs-confirmation"}
    assert confirming == {"RUN_TESTS"}


@pytest.mark.parametrize("name, model", EXPECTED_MODELS.items())
def test_each_entry_references_its_parameter_model(name: str, model: type) -> None:
    assert ALLOWED_ACTIONS[name].params_model is model


def test_action_spec_is_frozen_and_risk_cannot_be_overridden() -> None:
    spec = ALLOWED_ACTIONS["RUN_TESTS"]
    with pytest.raises(dataclasses.FrozenInstanceError):
        spec.risk = "safe"  # type: ignore[misc]
    assert ALLOWED_ACTIONS["RUN_TESTS"].risk == "needs-confirmation"
    assert {f.name for f in dataclasses.fields(ActionSpec)} == {"risk", "params_model"}


def test_registry_holds_only_data_no_callables_or_command_strings() -> None:
    for spec in ALLOWED_ACTIONS.values():
        values = [getattr(spec, f.name) for f in dataclasses.fields(spec)]
        assert not any(callable(v) and not isinstance(v, type) for v in values)
        strings = [v for v in values if isinstance(v, str)]
        assert set(strings) <= {"safe", "needs-confirmation"}


def test_module_imports_nothing_that_can_execute_or_touch_the_ide() -> None:
    source = open(allowlist.__file__, encoding="utf-8").read()
    for forbidden in ("subprocess", "os.system", "import os", "shutil", "socket", "vscode"):
        assert forbidden not in source


# --------------------------------------------------------- parameter models


@pytest.mark.parametrize("name, model", EXPECTED_MODELS.items())
def test_every_parameter_model_forbids_extra_fields(name: str, model: Any) -> None:
    assert model.model_config.get("extra") == "forbid"


@pytest.mark.parametrize("name, model", EXPECTED_MODELS.items())
def test_no_parameter_model_has_a_generic_command_field(name: str, model: Any) -> None:
    assert not (set(model.model_fields) & FORBIDDEN_FIELD_NAMES)


@pytest.mark.parametrize("name", NO_PARAM_ACTIONS)
def test_no_param_models_accept_empty_and_reject_extras(name: str) -> None:
    spec = ALLOWED_ACTIONS[name]
    assert spec.params_model.model_fields == {}
    spec.validate_params({})
    with pytest.raises(ValidationError):
        spec.validate_params({"anything": "unexpected"})


@pytest.mark.parametrize(
    "extra",
    [
        {"command": "pytest"},
        {"cmd": "rm -rf /"},
        {"shell": "bash"},
        {"executable": "/bin/sh"},
        {"args": ["-x"]},
        {"testCommand": "npm test"},
    ],
)
def test_run_tests_rejects_any_command_like_argument(extra: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ALLOWED_ACTIONS["RUN_TESTS"].validate_params(extra)


# GO_TO_DIAGNOSTIC


def test_go_to_diagnostic_valid_parameters() -> None:
    spec = ALLOWED_ACTIONS["GO_TO_DIAGNOSTIC"]
    assert spec.validate_params({"index": 0}).index == 0  # type: ignore[attr-defined]
    parsed = spec.validate_params({"index": 4, "severity": "warning"})
    assert (parsed.index, parsed.severity) == (4, "warning")  # type: ignore[attr-defined]
    assert spec.validate_params({"index": MAX_SAFE_INTEGER})


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"severity": "error"},
        {"index": -1},
        {"index": MAX_SAFE_INTEGER + 1},
        {"index": "1"},
        {"index": 1.5},
        {"index": 1.0},
        {"index": True},
        {"index": None},
        {"index": 0, "severity": "info"},
        {"index": 0, "severity": "ERROR"},
        {"index": 0, "extra": 1},
    ],
)
def test_go_to_diagnostic_invalid_parameters(params: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ALLOWED_ACTIONS["GO_TO_DIAGNOSTIC"].validate_params(params)


# NEXT / PREVIOUS


@pytest.mark.parametrize("name", ["NEXT_DIAGNOSTIC", "PREVIOUS_DIAGNOSTIC"])
def test_next_and_previous_diagnostic_parameters(name: str) -> None:
    spec = ALLOWED_ACTIONS[name]
    assert spec.validate_params({}).severity is None  # type: ignore[attr-defined]
    for severity in ("error", "warning", "any"):
        assert spec.validate_params({"severity": severity}).severity == severity  # type: ignore[attr-defined]
    for bad in ({"severity": "info"}, {"severity": 1}, {"index": 0}, {"severity": "error", "x": 1}):
        with pytest.raises(ValidationError):
            spec.validate_params(bad)


# OPEN_FILE


def test_open_file_valid_parameters_pass_through_unchanged() -> None:
    spec = ALLOWED_ACTIONS["OPEN_FILE"]
    assert spec.validate_params({"path": "auth.ts"}).path == "auth.ts"  # type: ignore[attr-defined]
    nested = "src/utils/ß file.ts"
    assert spec.validate_params({"path": nested}).path == nested  # type: ignore[attr-defined]
    assert spec.validate_params({"path": "a" * MAX_ACTION_PATH_CHARS})


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"path": ""},
        {"path": "a" * (MAX_ACTION_PATH_CHARS + 1)},
        {"path": "bad\x00name"},
        {"path": 5},
        {"path": None},
        {"path": ["a.ts"]},
        {"path": "a.ts", "line": 3},
        {"name": "a.ts"},
    ],
)
def test_open_file_invalid_parameters(params: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ALLOWED_ACTIONS["OPEN_FILE"].validate_params(params)


# GO_TO_LINE


def test_go_to_line_valid_parameters() -> None:
    spec = ALLOWED_ACTIONS["GO_TO_LINE"]
    assert spec.validate_params({"line": 1}).line == 1  # type: ignore[attr-defined]
    assert spec.validate_params({"line": 42}).line == 42  # type: ignore[attr-defined]
    assert spec.validate_params({"line": MAX_SAFE_INTEGER})


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"line": 0},
        {"line": -3},
        {"line": MAX_SAFE_INTEGER + 1},
        {"line": "10"},
        {"line": 2.5},
        {"line": True},
        {"line": None},
        {"line": 3, "column": 1},
    ],
)
def test_go_to_line_invalid_parameters(params: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ALLOWED_ACTIONS["GO_TO_LINE"].validate_params(params)


def test_parameter_models_are_immutable_after_validation() -> None:
    parsed = ALLOWED_ACTIONS["GO_TO_LINE"].validate_params({"line": 7})
    with pytest.raises(ValidationError):
        parsed.line = 8  # type: ignore[attr-defined]
