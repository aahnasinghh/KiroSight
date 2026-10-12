"""Task 6.3 property tests for the loopback-only configuration boundary."""

from __future__ import annotations

import ipaddress
from pathlib import Path

import pytest
from hypothesis import given, settings, strategies as st

from app.config import ConfigError, is_loopback_host, load_config

MISSING_DOTENV = Path("does-not-exist-for-property-test.env")
IP_ADDRESSES = st.one_of(st.ip_addresses(v=4), st.ip_addresses(v=6))


def loopback_oracle(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Apply the approved policy independently of the production helper."""
    mapped = address.ipv4_mapped if isinstance(address, ipaddress.IPv6Address) else None
    return address.is_loopback or (mapped is not None and mapped.is_loopback)


def is_non_ip_host(value: str) -> bool:
    if value == "localhost":
        return False
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return True
    return False


@given(address=IP_ADDRESSES)
@settings(max_examples=100)
def test_generated_ip_addresses_match_independent_loopback_oracle(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> None:
    expected = loopback_oracle(address)
    assert is_loopback_host(str(address)) is expected


@given(address=IP_ADDRESSES)
@settings(max_examples=100)
def test_load_config_enforces_generated_ip_boundary(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> None:
    host = str(address)
    environment = {"KIROSIGHT_HOST": host, "KIROSIGHT_PORT": "8765"}

    if loopback_oracle(address):
        config = load_config(environment, MISSING_DOTENV)
        assert config.host == host
        assert config.port == 8765
    else:
        with pytest.raises(ConfigError, match="KIROSIGHT_HOST"):
            load_config(environment, MISSING_DOTENV)


@given(mapped_ipv4=st.ip_addresses(v=4))
@settings(max_examples=100)
def test_generated_ipv4_mapped_ipv6_addresses_use_mapped_loopback_policy(
    mapped_ipv4: ipaddress.IPv4Address,
) -> None:
    address = ipaddress.IPv6Address(f"::ffff:{mapped_ipv4}")
    expected = mapped_ipv4.is_loopback
    host = str(address)

    assert is_loopback_host(host) is expected
    environment = {"KIROSIGHT_HOST": host, "KIROSIGHT_PORT": "8765"}
    if expected:
        assert load_config(environment, MISSING_DOTENV).host == host
    else:
        with pytest.raises(ConfigError, match="KIROSIGHT_HOST"):
            load_config(environment, MISSING_DOTENV)


@given(host=st.text(min_size=1, max_size=100).filter(is_non_ip_host))
@settings(max_examples=100)
def test_generated_non_ip_hosts_are_not_loopback(host: str) -> None:
    assert is_loopback_host(host) is False

    # Blank-like strings are intentionally handled as an absent setting by the
    # configuration contract, so only nonblank generated hosts are loader inputs.
    if host.strip() != "":
        with pytest.raises(ConfigError, match="KIROSIGHT_HOST"):
            load_config(
                {"KIROSIGHT_HOST": host, "KIROSIGHT_PORT": "8765"},
                MISSING_DOTENV,
            )
