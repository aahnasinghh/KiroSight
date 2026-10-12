"""FastAPI app: ``GET /health`` and the ``/ws`` WebSocket (Requirements 11.3, 11.4, 17.5).

* Bound to loopback only: the entrypoint uses the host/port validated by ``app.config``.
* Any ``Origin`` header rejects the connection, before it is accepted.
* Inbound messages are capped at 2 MiB (``WS_MAX_SIZE_BYTES``), enforced by uvicorn and again here.
* Protocol parsing reuses ``app.protocol``; failures answer with a safe ``error_message`` and the
  connection stays open. Nothing from an invalid payload is echoed or logged.
* The backend only proposes data (a stub ``NO_ACTION``). It never executes anything.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.agent.stub_agent import AgentResponder, StubAgent
from app.config import load_config
from app.logging_utils import RedactingFilter, format_metadata, redact
from app.protocol.messages import (
    PROTOCOL_VERSION,
    ActionResultMessage,
    AgentRequest,
    Cancel,
    ErrorCode,
    ErrorMessage,
    Hello,
    HelloAck,
    dump_message,
)
from app.protocol.validators import ProtocolValidationError, parse_message
from app.session import DuplicateRequestError, Session

__all__ = ["WS_MAX_SIZE_BYTES", "app", "create_app", "run"]

#: Maximum inbound WebSocket message size: 2 MiB.
WS_MAX_SIZE_BYTES = 2 * 1024 * 1024

AUTH_TOKEN_VARIABLE = "KIROSIGHT_AUTH_TOKEN"

# WebSocket close codes (RFC 6455).
CLOSE_POLICY_VIOLATION = 1008
CLOSE_MESSAGE_TOO_BIG = 1009
CLOSE_INTERNAL_ERROR = 1011

logger = logging.getLogger("kirosight.backend")
logger.addFilter(RedactingFilter())  # defence in depth: pattern-based redaction on every record

# Generic, payload-free messages for each failure category.
_SAFE_MESSAGES: dict[str, str] = {
    "VALIDATION_FAILED": "The message was not valid.",
    "UNSUPPORTED_VERSION": "Unsupported protocol version.",
    "UNKNOWN_TYPE": "Unknown message type.",
}


def _error(code: ErrorCode, message: str, *, recoverable: bool = True, reply_to: str | None = None) -> ErrorMessage:
    fields: dict[str, Any] = {
        "version": PROTOCOL_VERSION,
        "type": "error_message",
        "code": code,
        "message": message,
        "recoverable": recoverable,
    }
    if reply_to is not None:
        fields["replyTo"] = reply_to
    return ErrorMessage(**fields)


def _configured_token(explicit: str | None) -> str | None:
    """The shared token, if any: an explicit value wins, otherwise ``KIROSIGHT_AUTH_TOKEN``."""
    token = explicit if explicit is not None else os.environ.get(AUTH_TOKEN_VARIABLE)
    return token if token and token.strip() else None


def _turn_text(request: AgentRequest) -> str:
    if request.utterance is not None:
        return request.utterance.text
    return "(test run summary)" if request.kind == "summarize_test_run" else "(no utterance)"


class Connection:
    """State and logic for one ``/ws`` connection."""

    def __init__(self, websocket: WebSocket, agent: AgentResponder, token: str | None) -> None:
        self._websocket = websocket
        self._agent = agent
        self._token = token
        self.session = Session()
        self._send_lock = asyncio.Lock()  # one writer at a time: agent tasks finish independently
        self._closed = False

    # --- logging: metadata only, always redacted ---

    def _log(self, event: str, **metadata: Any) -> None:
        secrets = [self._token] if self._token else None
        logger.info("%s %s", event, redact(format_metadata(**metadata), secrets))

    # --- outbound ---

    async def send(self, message: BaseModel) -> bool:
        payload = json.dumps(dump_message(message), separators=(",", ":"))
        async with self._send_lock:
            if self._closed:
                return False
            try:
                await self._websocket.send_text(payload)
            except Exception:
                self._closed = True
                return False
            return True

    async def _close(self, code: int) -> None:
        self._closed = True
        try:
            await self._websocket.close(code=code)
        except Exception:
            pass

    # --- main loop ---

    async def serve(self) -> None:
        self._log("connection opened")
        try:
            while True:
                event = await self._websocket.receive()
                if event["type"] == "websocket.disconnect":
                    break
                if not await self._on_event(event):
                    break
        except WebSocketDisconnect:
            pass
        except Exception as error:
            self._log("receive loop error", error=type(error).__name__)
            await self._close(CLOSE_INTERNAL_ERROR)
        finally:
            self._closed = True
            tasks = self.session.cancel_all()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            self._log("connection closed")

    async def _on_event(self, event: dict[str, Any]) -> bool:
        """Handle one received frame. Returns False when the connection should end."""
        text = event.get("text")
        data = event.get("bytes")
        if text is not None:
            # len(text) <= byte length, so an over-long string is certainly oversized; otherwise
            # encode (bounded by the cap) to measure the exact size.
            size = len(text) if len(text) > WS_MAX_SIZE_BYTES else len(text.encode("utf-8", "surrogatepass"))
        elif data is not None:
            size = len(data)
        else:
            return True

        if size > WS_MAX_SIZE_BYTES:
            self._log("message too large", size=size)
            await self._close(CLOSE_MESSAGE_TOO_BIG)
            return False

        if text is None:
            self._log("binary frame rejected", size=size)
            await self.send(_error("VALIDATION_FAILED", "Only text messages are supported."))
            return True

        try:
            decoded = json.loads(text)
        except (ValueError, RecursionError):
            self._log("invalid json", size=size)
            await self.send(_error("VALIDATION_FAILED", "The message was not valid JSON."))
            return True

        parsed = parse_message(decoded)
        if isinstance(parsed, ProtocolValidationError):
            self._log("invalid message", code=parsed.code, size=size)
            await self.send(_error(parsed.code, _SAFE_MESSAGES[parsed.code]))
            return True

        self._log("message received", type=parsed.type, size=size)
        return await self._dispatch(parsed)

    # --- dispatch ---

    async def _dispatch(self, message: Any) -> bool:
        if not self.session.handshake_complete:
            if isinstance(message, Hello):
                return await self._on_hello(message)
            await self.send(_error("VALIDATION_FAILED", "Send hello first."))
            return True

        if isinstance(message, AgentRequest):
            await self._on_agent_request(message)
        elif isinstance(message, Cancel):
            cancelled = self.session.cancel(message.targetId)
            self._log("cancel", id=message.targetId, found=cancelled)
        elif isinstance(message, ActionResultMessage):
            self._log("action result received", id=message.replyTo, status=message.result.status)
        elif isinstance(message, Hello):
            await self.send(_error("VALIDATION_FAILED", "Already connected."))
        else:
            # Valid protocol messages this milestone does not act on (audio, speech, backend-to-
            # extension types). Nothing is executed.
            await self.send(_error("VALIDATION_FAILED", "This message is not supported yet."))
        return True

    async def _on_hello(self, hello: Hello) -> bool:
        if self._token is not None:
            supplied = (hello.token or "").encode("utf-8")
            if hello.token is None or not hmac.compare_digest(supplied, self._token.encode("utf-8")):
                self._log("unauthorized hello")
                await self.send(_error("UNAUTHORIZED", "Unauthorized.", recoverable=False))
                await self._close(CLOSE_POLICY_VIOLATION)
                return False
        self.session.handshake_complete = True
        await self.send(
            HelloAck(
                version=PROTOCOL_VERSION,
                type="hello_ack",
                supportedVersions=[PROTOCOL_VERSION],
                capabilities=self.session.capabilities,
            )
        )
        return True

    async def _on_agent_request(self, request: AgentRequest) -> None:
        if self.session.is_in_flight(request.id):
            await self.send(_error("VALIDATION_FAILED", "That request id is already in flight."))
            return
        task = asyncio.create_task(self._run_agent(request))
        try:
            self.session.register(request.id, task)
        except DuplicateRequestError:  # lost a race; never replace a live task
            task.cancel()
            await self.send(_error("VALIDATION_FAILED", "That request id is already in flight."))
            return
        task.add_done_callback(lambda finished: self._task_finished(request.id, finished))
        self._log("agent task started", id=request.id)

    def _task_finished(self, request_id: str, task: asyncio.Task[None]) -> None:
        self.session.remove(request_id, task)
        if task.cancelled():
            self._log("agent task cancelled", id=request_id)
        else:
            task.exception()  # mark retrieved; failures were handled inside the task

    async def _run_agent(self, request: AgentRequest) -> None:
        try:
            response = await self._agent.respond(request)
            if await self.send(response):
                self.session.add_turn(_turn_text(request), response.speech)
                self._log("agent task completed", id=request.id)
        except asyncio.CancelledError:
            raise  # cancelled work sends nothing
        except Exception as error:
            self._log("agent task failed", id=request.id, error=type(error).__name__)
            await self.send(
                _error("INTERNAL", "The request could not be completed.", reply_to=request.id)
            )


def create_app(*, agent: AgentResponder | None = None, auth_token: str | None = None) -> FastAPI:
    """Build the app. ``agent`` and ``auth_token`` are injectable; defaults are production-safe."""
    responder: AgentResponder = agent if agent is not None else StubAgent()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        load_config()  # loads .env (process env wins) and refuses a non-loopback host
        yield

    application = FastAPI(title="KiroSight backend", lifespan=lifespan)

    @application.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        # Any Origin header (browsers always send one; the extension host does not) is refused
        # before the handshake is accepted. The value is never read or logged.
        if "origin" in websocket.headers:
            await websocket.close(code=CLOSE_POLICY_VIOLATION)
            return
        await websocket.accept()
        await Connection(websocket, responder, _configured_token(auth_token)).serve()

    return application


app = create_app()


def run() -> None:
    """Start uvicorn on the validated loopback host/port with the 2 MiB WebSocket limit."""
    import uvicorn

    config = load_config()
    uvicorn.run(app, host=config.host, port=config.port, ws_max_size=WS_MAX_SIZE_BYTES)


if __name__ == "__main__":
    run()
