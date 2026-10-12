"""Task 6.9: the shared protocol fixtures must parse with the Python models.

The same physical files are validated by ``extension/test/protocol/protocolFixtures.test.ts``.
They are hand-written contract samples and are never generated from either implementation.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.protocol.messages import BACKEND_MESSAGE_TYPES, dump_message
from app.protocol.validators import ProtocolValidationError, parse_message

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIRECTORY = REPOSITORY_ROOT / "extension" / "src" / "protocol" / "fixtures" / "messages"
EXPECTED_FILENAMES = sorted(f"{name}.json" for name in BACKEND_MESSAGE_TYPES)


def load(filename: str) -> dict[str, Any]:
    with (FIXTURE_DIRECTORY / filename).open(encoding="utf-8") as handle:
        return json.load(handle)


def test_fixture_directory_contains_exactly_the_fourteen_message_fixtures() -> None:
    assert FIXTURE_DIRECTORY.is_dir()
    assert len(EXPECTED_FILENAMES) == 14
    assert sorted(path.name for path in FIXTURE_DIRECTORY.iterdir()) == EXPECTED_FILENAMES


@pytest.mark.parametrize("filename", EXPECTED_FILENAMES)
def test_fixture_parses_as_its_message_type(filename: str) -> None:
    raw = load(filename)
    message_type = filename.removesuffix(".json")

    parsed = parse_message(raw)

    assert not isinstance(parsed, ProtocolValidationError), parsed
    assert parsed.type == message_type
    assert parsed.version == 1
    assert raw["type"] == message_type


@pytest.mark.parametrize("filename", EXPECTED_FILENAMES)
def test_fixture_round_trips_to_the_same_wire_form(filename: str) -> None:
    raw = load(filename)
    parsed = parse_message(raw)
    assert not isinstance(parsed, ProtocolValidationError)
    assert dump_message(parsed) == raw


@pytest.mark.parametrize("filename", EXPECTED_FILENAMES)
def test_fixtures_contain_nothing_secret_or_absolute(filename: str) -> None:
    text = (FIXTURE_DIRECTORY / filename).read_text(encoding="utf-8")
    for forbidden in ("AKIA", "eyJ", "sk-", "C:\\\\", "/home/", "/Users/", "activeFile"):
        assert forbidden not in text
