"""Deepgram Nova-2 speech-to-text (Task 8.4; Requirements 9.1, 9.3, 10.1, 17.1, 17.5).

``STTClient`` is the seam the WebSocket handler depends on. ``DeepgramSTTClient`` implements it with
``httpx`` against Deepgram's pre-recorded ``/v1/listen`` endpoint (complete-clip STT, design D9).

Safety and failure behavior:

* The credential comes only from ``DEEPGRAM_API_KEY`` in the environment, read when it is needed.
  If it is missing or blank no request is made and ``CREDENTIAL_MISSING`` names the variable.
* One attempt, never retried, with a hard 10 s limit over the whole request (Req 9.3). A timeout is
  ``TIMEOUT``; a network failure, an error status or an unusable response is ``STT_UNAVAILABLE``;
  a response with no words in it is ``STT_NO_SPEECH``. A transcript is returned only when Deepgram
  produced a non-empty one: nothing is ever invented, and there is no second STT provider.
* Redirects are not followed, so the credential is only ever sent to the configured endpoint.
* Response bodies are read with a size cap. Provider text, URLs, headers and audio are never copied
  into errors or logs; every error message here is a fixed sentence.
* The transcript is untrusted user text. It is handed back as data and nothing here acts on it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections.abc import Mapping
from typing import Final, Protocol

import httpx

from app.logging_utils import format_metadata, redact
from app.protocol.messages import MAX_UTTERANCE_CHARS, ErrorCode

__all__ = [
    "API_KEY_VARIABLE",
    "DEEPGRAM_LISTEN_URL",
    "DEFAULT_STT_MODEL",
    "MAX_RESPONSE_BYTES",
    "MAX_TRANSCRIPT_CHARS",
    "STT_MODEL_VARIABLE",
    "STT_TIMEOUT_SECONDS",
    "DeepgramSTTClient",
    "STTClient",
    "STTError",
]

logger = logging.getLogger("kirosight.backend.speech")

API_KEY_VARIABLE: Final = "DEEPGRAM_API_KEY"
STT_MODEL_VARIABLE: Final = "DEEPGRAM_STT_MODEL"
DEFAULT_STT_MODEL: Final = "nova-2"
DEEPGRAM_LISTEN_URL: Final = "https://api.deepgram.com/v1/listen"

#: Requirement 9.3: transcription must answer within 10 seconds.
STT_TIMEOUT_SECONDS: Final = 10.0

#: A transcript response is a small JSON document; anything bigger is not one.
MAX_RESPONSE_BYTES: Final = 256 * 1024

#: A transcript is routed as an utterance, so it may not exceed the utterance limit. It is rejected,
#: never truncated: a clipped command could mean something else.
MAX_TRANSCRIPT_CHARS: Final = MAX_UTTERANCE_CHARS

_MODEL_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}")
_BASE_MIME_PATTERN = re.compile(r"audio/[A-Za-z0-9.+-]{1,60}")


class STTError(Exception):
    """A speech-to-text failure. ``message`` is a fixed, safe sentence for the user."""

    def __init__(self, code: ErrorCode, message: str, *, recoverable: bool = True) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.message = message
        self.recoverable = recoverable


class STTClient(Protocol):
    """What the WebSocket handler needs from a speech-to-text provider."""

    def check_ready(self) -> None:
        """Raise :class:`STTError` (``CREDENTIAL_MISSING`` ...) if a call could not be made. No I/O."""
        ...

    async def transcribe(self, audio: bytes, mime_type: str) -> str:
        """Return the non-empty transcript of one complete recording, or raise :class:`STTError`."""
        ...


def _fail(category: str, error: STTError) -> STTError:
    """Log a fixed category (metadata only) and hand back the error to raise."""
    logger.warning("transcription failed %s", redact(format_metadata(category=category, code=error.code)))
    return error


class DeepgramSTTClient:
    """Deepgram Nova-2 over ``httpx``. Holds no credential: the key is read from the environment per call."""

    def __init__(
        self,
        *,
        environ: Mapping[str, str] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_seconds: float = STT_TIMEOUT_SECONDS,
        url: str = DEEPGRAM_LISTEN_URL,
    ) -> None:
        self._environ = environ
        self._transport = transport
        self._timeout = timeout_seconds
        self._url = url

    # --- configuration ---

    def _env(self, name: str) -> str:
        source = os.environ if self._environ is None else self._environ
        return (source.get(name) or "").strip()

    def _readiness_error(self) -> tuple[str, STTError] | None:
        """Why a call cannot be made, as (log category, error); None when it can. No I/O, no logging."""
        if self._env(API_KEY_VARIABLE) == "":
            return "credential_missing", STTError(
                "CREDENTIAL_MISSING",
                f"Speech recognition is not configured: {API_KEY_VARIABLE} is missing.",
                recoverable=False,
            )
        raw = self._env(STT_MODEL_VARIABLE)
        if raw != "" and _MODEL_PATTERN.fullmatch(raw) is None:
            # A malformed model name is a configuration problem. The value is never repeated.
            return "bad_model", STTError(
                "STT_UNAVAILABLE",
                f"Speech recognition is not configured: {STT_MODEL_VARIABLE} is not a valid model name.",
                recoverable=False,
            )
        return None

    def check_ready(self) -> None:
        problem = self._readiness_error()
        if problem is not None:
            raise _fail(*problem)

    @property
    def configured(self) -> bool:
        """True when a call could be made. Reports nothing about whether Deepgram would accept it."""
        return self._readiness_error() is None

    def _model(self) -> str:
        return self._env(STT_MODEL_VARIABLE) or DEFAULT_STT_MODEL

    # --- transcription ---

    async def transcribe(self, audio: bytes, mime_type: str) -> str:
        self.check_ready()  # no network call without a usable configuration
        api_key = self._env(API_KEY_VARIABLE)
        model = self._model()

        if len(audio) == 0:
            raise _fail("empty_audio", STTError("STT_NO_SPEECH", "No audio was received."))
        base_type = mime_type.split(";", 1)[0].strip().lower()
        if _BASE_MIME_PATTERN.fullmatch(base_type) is None:
            raise _fail(
                "bad_mime", STTError("STT_UNAVAILABLE", "Speech recognition cannot use that audio format.")
            )

        try:
            body = await asyncio.wait_for(
                self._request(audio, base_type, model, api_key), timeout=self._timeout
            )
        except (TimeoutError, httpx.TimeoutException):
            raise _fail("timeout", STTError("TIMEOUT", "Speech recognition did not answer in time.")) from None
        except STTError:
            raise
        except httpx.HTTPError:
            raise _fail(
                "network", STTError("STT_UNAVAILABLE", "Speech recognition could not be reached.")
            ) from None
        except Exception:
            raise _fail(
                "unexpected", STTError("STT_UNAVAILABLE", "Speech recognition failed unexpectedly.")
            ) from None
        return self._transcript(body)

    async def _request(self, audio: bytes, base_type: str, model: str, api_key: str) -> bytes:
        headers = {"Authorization": f"Token {api_key}", "Content-Type": base_type, "Accept": "application/json"}
        async with httpx.AsyncClient(
            transport=self._transport, timeout=self._timeout, follow_redirects=False
        ) as client:
            async with client.stream(
                "POST",
                self._url,
                params={"model": model, "smart_format": "true"},
                headers=headers,
                content=audio,
            ) as response:
                self._check_status(response.status_code)
                received = bytearray()
                async for part in response.aiter_bytes():
                    received.extend(part)
                    if len(received) > MAX_RESPONSE_BYTES:
                        raise _fail(
                            "response_too_large",
                            STTError("STT_UNAVAILABLE", "Speech recognition returned an unusable answer."),
                        )
                return bytes(received)

    @staticmethod
    def _check_status(status: int) -> None:
        if 200 <= status < 300:
            return
        if status in (401, 403):
            error = STTError(
                "STT_UNAVAILABLE", "Speech recognition rejected the configured credential.", recoverable=False
            )
        elif status in (408, 504):
            error = STTError("TIMEOUT", "Speech recognition did not answer in time.")
        elif status == 429:
            error = STTError("STT_UNAVAILABLE", "Speech recognition is busy. Try again in a moment.")
        elif status in (400, 413, 415, 422):
            error = STTError("STT_UNAVAILABLE", "Speech recognition could not process that audio.")
        else:
            error = STTError("STT_UNAVAILABLE", "Speech recognition is unavailable.")
        raise _fail(f"http_{status}", error)

    @staticmethod
    def _transcript(body: bytes) -> str:
        try:
            data = json.loads(body)
            transcript = data["results"]["channels"][0]["alternatives"][0]["transcript"]
        except (ValueError, RecursionError, KeyError, IndexError, TypeError):
            raise _fail(
                "malformed_response",
                STTError("STT_UNAVAILABLE", "Speech recognition returned an unusable answer."),
            ) from None
        if not isinstance(transcript, str):
            raise _fail(
                "malformed_response",
                STTError("STT_UNAVAILABLE", "Speech recognition returned an unusable answer."),
            )
        text = transcript.strip()
        if text == "":
            raise _fail("no_speech", STTError("STT_NO_SPEECH", "No speech was recognized."))
        if len(text) > MAX_TRANSCRIPT_CHARS:
            raise _fail(
                "transcript_too_long",
                STTError("STT_UNAVAILABLE", "Speech recognition returned an unusable answer."),
            )
        return text
