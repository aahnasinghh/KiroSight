"""Task 6.2 deterministic configuration tests (no property tests; Task 6.3 owns those)."""

from pathlib import Path

import pytest

from app.config import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    Config,
    ConfigError,
    is_loopback_host,
    load_config,
)

MISSING_DOTENV = Path("does-not-exist.env")
FAKE_SECRET = "s3cr3t-DISTINCT-value-9f2a"


def load(env: dict[str, str]) -> Config:
    return load_config(env, MISSING_DOTENV)


def test_host_defaults_to_ipv4_loopback_and_port_to_8765() -> None:
    config = load({})
    assert config.host == DEFAULT_HOST == "127.0.0.1"
    assert config.port == DEFAULT_PORT == 8765
    assert load({"KIROSIGHT_HOST": "  ", "KIROSIGHT_PORT": ""}).host == "127.0.0.1"


@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.2", "::1", "localhost"])
def test_loopback_hosts_are_accepted(host: str) -> None:
    assert load({"KIROSIGHT_HOST": host}).host == host


@pytest.mark.parametrize(
    "host",
    [
        "0.0.0.0",
        "::",
        "192.168.1.20",
        "10.0.0.5",
        "172.16.0.1",
        "8.8.8.8",
        "example.com",
        "LOCALHOST.example",
        "127.0.0.1.evil.com",
        "[::1]",
        "::1%lo",
        "127.0.0.1 ",
    ],
)
def test_non_loopback_or_unapproved_hosts_are_rejected(host: str) -> None:
    with pytest.raises(ConfigError, match="KIROSIGHT_HOST"):
        load({"KIROSIGHT_HOST": host})
    assert not is_loopback_host(host)


def test_valid_ports_are_parsed() -> None:
    assert load({"KIROSIGHT_PORT": "1"}).port == 1
    assert load({"KIROSIGHT_PORT": "9000"}).port == 9000
    assert load({"KIROSIGHT_PORT": "65535"}).port == 65535


@pytest.mark.parametrize("port", ["0", "65536", "-1", "abc", "80.5", " 80", "80 ", "+80", "８０"])
def test_invalid_ports_are_rejected(port: str) -> None:
    with pytest.raises(ConfigError, match="KIROSIGHT_PORT"):
        load({"KIROSIGHT_PORT": port})


def test_process_environment_overrides_dotenv_and_dotenv_fills_gaps(tmp_path: Path) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text("KIROSIGHT_PORT=9000\nKIROSIGHT_HOST=::1\n", encoding="utf-8")

    config = load_config({"KIROSIGHT_PORT": "9100"}, dotenv)

    assert config.port == 9100
    assert config.host == "::1"


def test_dotenv_is_loaded_into_the_real_environment_without_overriding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text("KIROSIGHT_PORT=9000\n", encoding="utf-8")
    # Register the key with monkeypatch so anything load_dotenv sets is undone afterwards.
    monkeypatch.setenv("KIROSIGHT_PORT", "placeholder")
    monkeypatch.delenv("KIROSIGHT_PORT")
    monkeypatch.delenv("KIROSIGHT_HOST", raising=False)

    assert load_config(dotenv_path=dotenv).port == 9000

    monkeypatch.setenv("KIROSIGHT_PORT", "9100")
    assert load_config(dotenv_path=dotenv).port == 9100


def test_missing_credentials_are_reported_by_name() -> None:
    config = load({})
    assert config.missing_credentials("deepgram") == ("DEEPGRAM_API_KEY",)
    # Bedrock needs a Bedrock API key OR the access-key pair; the region and model ID have defaults.
    assert config.missing_credentials("bedrock") == (
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
    )


def test_present_credentials_are_omitted_and_blank_counts_as_missing() -> None:
    config = load(
        {
            "DEEPGRAM_API_KEY": FAKE_SECRET,
            "AWS_REGION": "us-east-1",
            "AWS_ACCESS_KEY_ID": FAKE_SECRET + "-id",
            "AWS_SECRET_ACCESS_KEY": "   ",
        }
    )
    assert config.missing_credentials("deepgram") == ()
    assert config.missing_credentials("bedrock") == ("AWS_SECRET_ACCESS_KEY",)


def test_optional_credentials_never_block_startup_or_appear_as_missing() -> None:
    config = load({})
    names = config.missing_credentials("bedrock") + config.missing_credentials("deepgram")
    assert "KIROSIGHT_AUTH_TOKEN" not in names
    assert "AWS_SESSION_TOKEN" not in names


def test_secret_values_never_appear_in_errors_reports_or_repr() -> None:
    env = {
        "DEEPGRAM_API_KEY": FAKE_SECRET,
        "AWS_SECRET_ACCESS_KEY": FAKE_SECRET,
        "KIROSIGHT_AUTH_TOKEN": FAKE_SECRET,
    }
    config = load(env)
    texts = [repr(config), str(config), repr(config.missing_credentials("bedrock"))]
    assert all(FAKE_SECRET not in text for text in texts)

    for bad in ({"KIROSIGHT_HOST": "0.0.0.0"}, {"KIROSIGHT_PORT": "nope"}):
        with pytest.raises(ConfigError) as caught:
            load({**env, **bad})
        assert FAKE_SECRET not in str(caught.value)
        assert FAKE_SECRET not in repr(caught.value)

    # A secret mistakenly placed in the host variable is not echoed back either.
    with pytest.raises(ConfigError) as caught:
        load({"KIROSIGHT_HOST": FAKE_SECRET})
    assert FAKE_SECRET not in str(caught.value)


def test_config_is_immutable_and_exposes_no_environment_mapping() -> None:
    config = load({"DEEPGRAM_API_KEY": FAKE_SECRET})
    with pytest.raises(AttributeError):
        config.host = "0.0.0.0"  # type: ignore[misc]
    assert sorted(vars(config)) == ["host", "port", "present_names"]
    assert FAKE_SECRET not in config.present_names
