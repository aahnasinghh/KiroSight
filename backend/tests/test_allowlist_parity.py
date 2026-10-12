"""Task 6.7 parity checks against the canonical repository allow-list fixture."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.allowlist import ALLOWED_ACTIONS

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CANONICAL_FIXTURE = REPOSITORY_ROOT / "extension" / "src" / "protocol" / "fixtures" / "allowlist.json"
FORBIDDEN_ACTIONS = {"RUN_COMMAND", "GO_TO_SYMBOL"}


def load_fixture() -> list[dict[str, Any]]:
    with CANONICAL_FIXTURE.open(encoding="utf-8") as handle:
        document = json.load(handle)
    assert set(document) == {"actions"}
    return document["actions"]


def fixture_by_name() -> dict[str, dict[str, Any]]:
    entries = load_fixture()
    assert len(entries) == 8
    by_name = {entry["name"]: entry for entry in entries}
    assert len(by_name) == len(entries)
    return by_name


def test_python_registry_matches_canonical_fixture_names_and_risks() -> None:
    fixture = fixture_by_name()
    fixture_names = set(fixture)
    registry_names = set(ALLOWED_ACTIONS)

    assert fixture_names == registry_names
    assert len(registry_names) == 8
    assert not (fixture_names & FORBIDDEN_ACTIONS)
    assert not (registry_names & FORBIDDEN_ACTIONS)

    assert {
        name: entry["risk"] for name, entry in fixture.items()
    } == {name: spec.risk for name, spec in ALLOWED_ACTIONS.items()}
    assert fixture["RUN_TESTS"]["risk"] == "needs-confirmation"
    assert ALLOWED_ACTIONS["RUN_TESTS"].risk == "needs-confirmation"


def test_python_parameter_model_names_match_canonical_fixture() -> None:
    fixture = fixture_by_name()

    for name, entry in fixture.items():
        fixture_parameters = sorted(entry["parameters"])
        model_parameters = sorted(ALLOWED_ACTIONS[name].params_model.model_fields)
        assert model_parameters == fixture_parameters
