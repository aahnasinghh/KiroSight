"""Task 10.2: automated tests are independent of the developer's real credentials.

A key in ``backend/.env`` (or in the shell or Windows environment) must never decide the result of a test
that expects a service to be unavailable. The isolation lives in ``tests/conftest.py`` only; production
credential loading is not touched. These tests prove what the isolation does and what it deliberately
leaves alone:

* the real ``backend/.env`` is never opened and nothing from it reaches ``os.environ``;
* the credential and configuration variables are absent unless a test sets them itself;
* a test that sets a fake credential with ``monkeypatch`` still sees it;
* a test that passes a temporary dotenv file to ``load_config`` still has that file loaded.

Only fake values are used. The real ``.env`` is never read, copied or displayed here.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import config, main
from app.config import load_config

FIXTURES = Path(__file__).resolve().parents[2] / "extension" / "src" / "protocol" / "fixtures" / "messages"
FAKE_BEARER = "FAKE_BEARER_TOKEN_FOR_ISOLATION_TESTS"
FAKE_DEEPGRAM = "FAKE_DEEPGRAM_KEY_FOR_ISOLATION_TESTS"
REAL_DOTENV = Path(config.__file__).resolve().parents[1] / ".env"

ISOLATED = (
    "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "AWS_REGION", "AWS_DEFAULT_REGION", "BEDROCK_MODEL_ID", "KIROSIGHT_AUTH_TOKEN",
    "KIROSIGHT_HOST", "KIROSIGHT_PORT", "KIROSIGHT_LLM", "DEEPGRAM_API_KEY", "DEEPGRAM_STT_MODEL",
    "DEEPGRAM_TTS_MODEL",
)


def write_dotenv(directory: Path, text: str) -> Path:
    path = directory / "temporary.env"
    path.write_text(text, encoding="utf-8")
    return path


# --- the real .env and the real environment are out of reach -----------------------------------------


def test_the_default_dotenv_path_points_at_an_absent_file_not_the_real_one() -> None:
    assert config.DEFAULT_DOTENV_PATH.resolve() != REAL_DOTENV
    assert not config.DEFAULT_DOTENV_PATH.exists()
    assert REAL_DOTENV.parent.name == "backend"  # the path computed above really is backend/.env


@pytest.mark.parametrize("name", ISOLATED)
def test_no_credential_or_configuration_variable_is_present_unless_the_test_sets_it(name: str) -> None:
    assert name not in os.environ


def test_loading_the_default_configuration_reads_no_real_dotenv_and_changes_nothing() -> None:
    before = dict(os.environ)

    loaded = load_config()

    assert dict(os.environ) == before  # nothing from any .env was copied into the environment
    assert loaded.present_names == frozenset()
    assert loaded.missing_credentials("bedrock") == (
        "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    )
    assert loaded.missing_credentials("deepgram") == ("DEEPGRAM_API_KEY",)


def test_an_explicit_environment_with_the_default_dotenv_also_sees_no_real_file() -> None:
    assert load_config({}).present_names == frozenset()


def test_the_app_starts_and_reports_every_provider_unavailable_whatever_the_machine_holds() -> None:
    with TestClient(main.create_app()) as client:  # start-up runs load_config() and the LLM choice
        with client.websocket_connect("/ws") as ws:
            ws.send_text((FIXTURES / "hello.json").read_text(encoding="utf-8"))
            ack = ws.receive_json()

    assert ack["type"] == "hello_ack"
    assert ack["capabilities"]["bedrock"] is False
    assert ack["capabilities"]["stt"] is False
    assert ack["capabilities"]["tts"] is False
    for name in ISOLATED:
        assert name not in os.environ  # the app's own start-up loaded nothing either


# --- what the isolation deliberately leaves alone ------------------------------------------------------


def test_a_fake_credential_set_by_the_test_is_still_seen(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", FAKE_BEARER)
    monkeypatch.setenv("DEEPGRAM_API_KEY", FAKE_DEEPGRAM)

    loaded = load_config()

    assert loaded.missing_credentials("bedrock") == ()
    assert loaded.missing_credentials("deepgram") == ()


def test_a_temporary_dotenv_file_passed_explicitly_is_still_loaded_into_the_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dotenv = write_dotenv(tmp_path, f"AWS_BEARER_TOKEN_BEDROCK={FAKE_BEARER}\nKIROSIGHT_PORT=9123\n")
    # Registering the keys with monkeypatch makes the test undo anything load_dotenv sets.
    for name in ("AWS_BEARER_TOKEN_BEDROCK", "KIROSIGHT_PORT"):
        monkeypatch.setenv(name, "placeholder")
        monkeypatch.delenv(name)

    loaded = load_config(dotenv_path=dotenv)

    assert os.environ["AWS_BEARER_TOKEN_BEDROCK"] == FAKE_BEARER
    assert loaded.port == 9123
    assert loaded.missing_credentials("bedrock") == ()


def test_a_temporary_dotenv_file_is_also_read_when_an_environment_mapping_is_given(tmp_path: Path) -> None:
    dotenv = write_dotenv(tmp_path, f"DEEPGRAM_API_KEY={FAKE_DEEPGRAM}\n")

    loaded = load_config({"KIROSIGHT_PORT": "9001"}, dotenv_path=dotenv)

    assert loaded.missing_credentials("deepgram") == ()
    assert loaded.port == 9001
    assert "DEEPGRAM_API_KEY" not in os.environ  # a mapping is never written to the environment


def test_the_process_environment_still_wins_over_a_temporary_dotenv_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dotenv = write_dotenv(tmp_path, "KIROSIGHT_PORT=9000\n")
    monkeypatch.setenv("KIROSIGHT_PORT", "9100")

    assert load_config(dotenv_path=dotenv).port == 9100


# --- the isolation really is what stops a leak: a negative control -----------------------------------------


def test_without_the_isolation_a_dotenv_at_the_default_path_would_be_loaded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the default path pointed at a file with credentials they would be seen. This is what the
    autouse fixture prevents for the real ``backend/.env``, using a fake file in a temporary folder."""
    decoy = write_dotenv(tmp_path, f"AWS_BEARER_TOKEN_BEDROCK={FAKE_BEARER}\nDEEPGRAM_API_KEY={FAKE_DEEPGRAM}\n")
    monkeypatch.setattr(config, "DEFAULT_DOTENV_PATH", decoy)

    loaded = load_config({})

    assert loaded.missing_credentials("bedrock") == ()
    assert loaded.missing_credentials("deepgram") == ()


# --- production behavior is unchanged -------------------------------------------------------------------------


def test_production_still_loads_backend_dotenv_by_default() -> None:
    """The isolation patches a name at run time in tests only; the source still points at backend/.env."""
    source = Path(config.__file__).read_text(encoding="utf-8")

    assert 'DEFAULT_DOTENV_PATH = Path(__file__).resolve().parents[1] / ".env"' in source
    assert "path = DEFAULT_DOTENV_PATH if dotenv_path is None else Path(dotenv_path)" in source
    assert "load_dotenv(path, override=False)" in source


def test_the_isolation_lives_only_in_the_test_conftest() -> None:
    app_sources = [path for path in Path(config.__file__).parent.rglob("*.py")]
    assert app_sources
    for path in app_sources:
        text = path.read_text(encoding="utf-8")
        assert "_isolate_from_real_credentials" not in text
        assert "ISOLATED_VARIABLES" not in text