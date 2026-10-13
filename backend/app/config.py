"""Backend configuration: environment loading, loopback enforcement, credential reporting.

Only variable *names* are ever reported. Credential values are never stored on the
config object, never placed in errors, and the environment mapping is never exposed.
"""

from __future__ import annotations

import ipaddress
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from dotenv import dotenv_values, load_dotenv

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_DOTENV_PATH = Path(__file__).resolve().parents[1] / ".env"

HOST_VARIABLE = "KIROSIGHT_HOST"
PORT_VARIABLE = "KIROSIGHT_PORT"

Capability = Literal["bedrock", "deepgram"]

LLM_VARIABLE = "KIROSIGHT_LLM"
LlmChoice = Literal["stub", "bedrock"]
LLM_CHOICES: tuple[LlmChoice, ...] = ("stub", "bedrock")
DEFAULT_LLM: LlmChoice = "stub"

#: A Bedrock API key (read by the AWS SDK itself) is an alternative to the access-key pair.
BEDROCK_API_KEY_VARIABLE = "AWS_BEARER_TOKEN_BEDROCK"

# Credential variables each capability needs. Later milestones enable the capabilities;
# none of them is required to start the Milestone 6 stub backend. The Bedrock entry is the
# access-key pair; ``Config.missing_credentials`` also accepts ``AWS_BEARER_TOKEN_BEDROCK`` in its
# place. The region and model ID have defaults (us-east-1, amazon.nova-lite-v1:0), so they are not
# credentials and are never reported as missing.
REQUIRED_CREDENTIALS: Mapping[Capability, tuple[str, ...]] = {
    "bedrock": ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"),
    "deepgram": ("DEEPGRAM_API_KEY",),
}

# Optional: absence is never reported as missing. KIROSIGHT_AUTH_TOKEN enables the optional
# shared-token check; AWS_SESSION_TOKEN is only used with temporary AWS credentials.
OPTIONAL_CREDENTIALS: tuple[str, ...] = ("KIROSIGHT_AUTH_TOKEN", "AWS_SESSION_TOKEN")

_TRACKED_NAMES = (
    frozenset(name for names in REQUIRED_CREDENTIALS.values() for name in names)
    | frozenset(OPTIONAL_CREDENTIALS)
    | frozenset({BEDROCK_API_KEY_VARIABLE})
)

_PORT_PATTERN = re.compile(r"[0-9]+")


class ConfigError(Exception):
    """Raised when backend configuration is invalid. Messages never contain secret values."""


@dataclass(frozen=True)
class Config:
    """Immutable backend configuration. Holds no credential values."""

    host: str
    port: int
    # Names (never values) of tracked credential variables that have a non-blank value.
    present_names: frozenset[str] = field(default_factory=frozenset, repr=False)

    def missing_credentials(self, capability: Capability) -> tuple[str, ...]:
        """Return, by name only, the required credentials for ``capability`` that are unset.

        Bedrock accepts either ``AWS_BEARER_TOKEN_BEDROCK`` or the access-key pair, so it reports
        nothing when either is complete. With neither, all three names are listed; with half a
        pair, only the missing half. This matches ``BedrockLLMClient`` exactly.
        """
        required = REQUIRED_CREDENTIALS[capability]
        missing = tuple(name for name in required if name not in self.present_names)
        if capability != "bedrock":
            return missing
        if BEDROCK_API_KEY_VARIABLE in self.present_names or not missing:
            return ()
        if len(missing) == len(required):
            return (BEDROCK_API_KEY_VARIABLE, *missing)
        return missing


def is_loopback_host(host: str) -> bool:
    """Deterministic loopback check with no DNS lookup or network access."""
    if host == "localhost":
        return True
    if "%" in host:  # scoped IPv6 addresses are not an approved form
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped.is_loopback
    return address.is_loopback


def resolve_llm_choice(environ: Mapping[str, str] | None = None) -> LlmChoice:
    """Which LLM client the backend uses: ``stub`` (default, offline) or ``bedrock``.

    The choice is explicit. Nothing switches to the stub when Bedrock fails, and nothing switches to
    Bedrock because credentials happen to exist. An unknown value is a configuration error, and the
    message never repeats it.
    """
    source = os.environ if environ is None else environ
    raw = (source.get(LLM_VARIABLE) or "").strip().lower()
    if raw == "":
        return DEFAULT_LLM
    for choice in LLM_CHOICES:
        if raw == choice:
            return choice
    raise ConfigError(f"{LLM_VARIABLE} must be one of: {', '.join(LLM_CHOICES)}.")


def _resolve_host(source: Mapping[str, str]) -> str:
    raw = source.get(HOST_VARIABLE)
    if raw is None or raw.strip() == "":
        return DEFAULT_HOST
    if not is_loopback_host(raw):
        raise ConfigError(
            f"{HOST_VARIABLE} must be a loopback address (127.0.0.1, ::1 or localhost); "
            "non-loopback hosts are not permitted."
        )
    return raw


def _resolve_port(source: Mapping[str, str]) -> int:
    raw = source.get(PORT_VARIABLE)
    if raw is None or raw.strip() == "":
        return DEFAULT_PORT
    if _PORT_PATTERN.fullmatch(raw) is None:
        raise ConfigError(f"{PORT_VARIABLE} must be a whole number from 1 to 65535.")
    port = int(raw)
    if not 1 <= port <= 65535:
        raise ConfigError(f"{PORT_VARIABLE} must be a whole number from 1 to 65535.")
    return port


def load_config(
    environ: Mapping[str, str] | None = None,
    dotenv_path: str | Path | None = None,
) -> Config:
    """Load configuration.

    Process environment values are authoritative: ``.env`` only fills variables that are
    not already set. With ``environ=None`` the real process environment is used and the
    ``.env`` file is loaded into it (``override=False``) so later SDKs can read it. An
    explicit ``environ`` mapping is never mutated.
    """
    path = DEFAULT_DOTENV_PATH if dotenv_path is None else Path(dotenv_path)
    source: Mapping[str, str]
    if environ is None:
        load_dotenv(path, override=False)
        source = os.environ
    else:
        file_values = {key: value for key, value in dotenv_values(path).items() if value is not None}
        source = {**file_values, **environ}

    present = frozenset(
        name for name in _TRACKED_NAMES if (source.get(name) or "").strip() != ""
    )
    return Config(host=_resolve_host(source), port=_resolve_port(source), present_names=present)
