"""Safe parsing of decoded backend-protocol messages (Requirement 11.3).

``parse_message`` takes an already JSON-decoded value (it is not a JSON decoder) and returns either
a parsed message or a :class:`ProtocolValidationError`. It never raises for malformed or hostile
input and never copies payload content into the error.

Classification mirrors ``extension/src/protocol/validators.ts``:

* not an object, missing version, or a missing / non-string type -> ``VALIDATION_FAILED``
* a present version other than exactly the integer 1              -> ``UNSUPPORTED_VERSION``
* a string type that is not one of the 14 message types           -> ``UNKNOWN_TYPE``
* any other schema violation                                      -> ``VALIDATION_FAILED``

No allow-list validation happens here: ``action`` objects only need a string ``type``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final, Literal

from pydantic import ValidationError

from app.protocol.messages import (
    BACKEND_MESSAGE_TYPES,
    PROTOCOL_MESSAGE_ADAPTER,
    ProtocolMessage,
    is_protocol_version,
)

__all__ = ["ProtocolValidationError", "parse_message"]

_MAX_REPORTED_PATHS: Final = 5
_MAX_PATH_CHARS: Final = 100
_MESSAGE_TYPES: Final = frozenset(BACKEND_MESSAGE_TYPES)


@dataclass(frozen=True)
class ProtocolValidationError:
    """A safe, internal parse failure. This is not the ``error_message`` wire model.

    ``paths`` are schema paths only: never payload values and never unknown property names.
    """

    code: Literal["VALIDATION_FAILED", "UNSUPPORTED_VERSION", "UNKNOWN_TYPE"]
    message: str
    paths: tuple[str, ...] = ()


def _summarize_paths(error: ValidationError) -> tuple[str, ...]:
    paths: list[str] = []
    for item in error.errors(include_url=False, include_context=False, include_input=False):
        location = list(item["loc"])
        if item["type"] == "extra_forbidden" and location:
            location.pop()  # the last segment would be the caller's (untrusted) property name
        if location and location[0] in _MESSAGE_TYPES:
            location.pop(0)  # discriminator tag added by Pydantic
        path = ".".join(str(segment) for segment in location)[:_MAX_PATH_CHARS] or "(message)"
        if path not in paths:
            paths.append(path)
        if len(paths) >= _MAX_REPORTED_PATHS:
            break
    return tuple(paths)


def _fail(
    code: Literal["VALIDATION_FAILED", "UNSUPPORTED_VERSION", "UNKNOWN_TYPE"],
    message: str,
    paths: tuple[str, ...] = (),
) -> ProtocolValidationError:
    return ProtocolValidationError(code=code, message=message, paths=paths)


def parse_message(raw: Any) -> ProtocolMessage | ProtocolValidationError:
    """Parse one decoded protocol message. Never raises."""
    try:
        if not isinstance(raw, dict):
            return _fail("VALIDATION_FAILED", "Message must be an object.")

        if "version" not in raw:
            return _fail("VALIDATION_FAILED", "Message is missing a version.", ("version",))
        version = raw["version"]
        # A JSON number equal to 1 (decoded as 1 or 1.0) matches the Zod literal(1); bool and "1" do not.
        if not is_protocol_version(version):
            return _fail("UNSUPPORTED_VERSION", "Unsupported protocol version.", ("version",))

        message_type = raw.get("type")
        if not isinstance(message_type, str):
            return _fail("VALIDATION_FAILED", "Message is missing a string type.", ("type",))
        if message_type not in _MESSAGE_TYPES:
            return _fail("UNKNOWN_TYPE", "Unknown message type.", ("type",))

        return PROTOCOL_MESSAGE_ADAPTER.validate_python(raw)
    except ValidationError as error:
        try:
            paths = _summarize_paths(error)
        except Exception:
            paths = ()
        return _fail("VALIDATION_FAILED", "Message does not match its schema.", paths)
    except Exception:
        return _fail("VALIDATION_FAILED", "Message could not be validated.")
