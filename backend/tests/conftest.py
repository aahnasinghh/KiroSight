"""Shared test hygiene.

Tests that build the app without injecting an agent must always get the offline stub, whatever the
developer's shell contains. ``KIROSIGHT_LLM=bedrock`` in a developer's terminal would otherwise make
those tests try to reach Amazon Bedrock.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _offline_llm_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KIROSIGHT_LLM", raising=False)


@pytest.fixture(autouse=True)
def _offline_speech_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Deepgram key in a developer's shell must never make a test report or use speech-to-text."""
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    monkeypatch.delenv("DEEPGRAM_STT_MODEL", raising=False)


@pytest.fixture(autouse=True)
def _no_real_microphone(monkeypatch: pytest.MonkeyPatch) -> None:
    """No test may touch a real microphone, whatever hardware the machine has.

    An app built without an injected ``recorder`` gets no audio input at all (so ``capabilities.mic``
    stays ``not_applicable``). Tests that exercise recording inject a fake device explicitly.
    """
    monkeypatch.setattr("app.main.default_audio_input", lambda: None)
