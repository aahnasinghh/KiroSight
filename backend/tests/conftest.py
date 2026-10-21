"""Shared test hygiene.

Tests that build the app without injecting an agent must always get the offline stub, whatever the
developer's shell contains. ``KIROSIGHT_LLM=bedrock`` in a developer's terminal would otherwise make
those tests try to reach Amazon Bedrock.
"""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _offline_llm_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KIROSIGHT_LLM", raising=False)


@pytest.fixture(autouse=True)
def _offline_speech_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Deepgram key in a developer's shell must never make a test report or use speech-to-text."""
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    monkeypatch.delenv("DEEPGRAM_STT_MODEL", raising=False)
    monkeypatch.delenv("DEEPGRAM_TTS_MODEL", raising=False)


@pytest.fixture(autouse=True)
def _no_real_microphone(monkeypatch: pytest.MonkeyPatch) -> None:
    """No test may touch a real microphone, whatever hardware the machine has.

    An app built without an injected ``recorder`` gets no audio input at all (so ``capabilities.mic``
    stays ``not_applicable``). Tests that exercise recording inject a fake device explicitly.
    """
    monkeypatch.setattr("app.main.default_audio_input", lambda: None)


#: Credential and configuration variables a developer's shell, Windows environment or ``backend/.env``
#: may hold. None of them may reach a test unless the test sets it itself (with ``monkeypatch``) or loads
#: a temporary dotenv file it created.
ISOLATED_VARIABLES = (
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "BEDROCK_MODEL_ID",
    "KIROSIGHT_AUTH_TOKEN",
    "KIROSIGHT_HOST",
    "KIROSIGHT_PORT",
)


@pytest.fixture(scope="session")
def _absent_dotenv_path(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A ``.env`` location inside an empty temporary directory. Nothing is ever written to it."""
    return tmp_path_factory.mktemp("no-real-dotenv") / ".env"


@pytest.fixture(autouse=True)
def _isolate_from_real_credentials(monkeypatch: pytest.MonkeyPatch, _absent_dotenv_path: Path) -> None:
    """Automated tests never see the developer's real credentials or the real ``backend/.env``.

    Test-only: production code is untouched. Two separate paths could leak a real key into a test that
    expects a service to be unavailable, and both are closed here:

    * ``load_config()`` with no ``dotenv_path`` (what the app's start-up and first connection call)
      reads ``app.config.DEFAULT_DOTENV_PATH``, looked up at call time. Pointing that one name at an
      absent file means the real ``backend/.env`` is never opened, and nothing from it is copied into
      ``os.environ``. A test that passes ``dotenv_path=`` explicitly is unaffected, so tests that load
      a temporary dotenv file work as before.
    * The variables in ``ISOLATED_VARIABLES`` are removed from the process environment for the test,
      and put back afterwards. A test that wants one sets it with ``monkeypatch.setenv``, after this runs.

    The Deepgram variables and ``KIROSIGHT_LLM`` are handled by the fixtures above.
    """
    monkeypatch.setattr("app.config.DEFAULT_DOTENV_PATH", _absent_dotenv_path)
    for name in ISOLATED_VARIABLES:
        monkeypatch.delenv(name, raising=False)