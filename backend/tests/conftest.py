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
