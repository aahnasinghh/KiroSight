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
from collections import OrderedDict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.agent.agent_service import AgentSelection, select_agent
from app.agent.stub_agent import AgentResponder
from app.config import ConfigError, load_config, resolve_llm_choice
from app.logging_utils import RedactingFilter, format_metadata, redact
from app.protocol.messages import (
    PROTOCOL_VERSION,
    ActionResultMessage,
    AgentRequest,
    AgentResponse,
    AudioClip,
    Cancel,
    Capabilities,
    ErrorCode,
    ErrorMessage,
    Hello,
    HelloAck,
    RecordStart,
    RecordStop,
    TranscriptionResult,
    dump_message,
)
from app.protocol.validators import ProtocolValidationError, parse_message
from app.session import STUB_CAPABILITIES, DuplicateRequestError, Session
from app.speech.deepgram_service import DeepgramSTTClient, STTClient, STTError
from app.speech.local_recorder import (
    WAV_MIME_TYPE,
    LocalRecorder,
    MicrophoneError,
    RecordingNotActive,
    RecordingSession,
    default_audio_input,
)
from app.speech.recording import AudioRejected, CompletedRecording, RecordingAssembler

__all__ = ["MAX_CONCURRENT_TRANSCRIPTIONS", "WS_MAX_SIZE_BYTES", "app", "create_app", "run"]

#: Finished recording ids remembered per connection, so a repeated ``record_stop`` can be ignored.
FINISHED_RECORDING_MEMORY = 64

NO_RECORDER_MESSAGE = "This backend cannot record from a microphone."
NO_AUDIO_MESSAGE = "No audio was recorded."

#: Maximum inbound WebSocket message size: 2 MiB.
WS_MAX_SIZE_BYTES = 2 * 1024 * 1024

#: Transcriptions running at once on one connection. One capture is live at a time, so this is generous.
MAX_CONCURRENT_TRANSCRIPTIONS = 2

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

    def __init__(
        self,
        websocket: WebSocket,
        agent: AgentResponder,
        token: str | None,
        capabilities: Capabilities = STUB_CAPABILITIES,
        stt: STTClient | None = None,
        recorder: LocalRecorder | None = None,
    ) -> None:
        self._websocket = websocket
        self._agent = agent
        self._token = token
        self._stt: STTClient = stt if stt is not None else DeepgramSTTClient()
        self._recorder = recorder
        self._recordings = RecordingAssembler()
        self._transcribing: set[str] = set()
        # The one live microphone recording this connection owns, if any (Task 8.5).
        self._live: tuple[str, RecordingSession] | None = None
        self._cap_task: asyncio.Task[None] | None = None
        self._finished_recordings: OrderedDict[str, None] = OrderedDict()
        self.session = Session(capabilities)
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
            self._recordings.clear()  # partial recordings never outlive their connection
            await self._abort_recording()  # and neither does an open microphone
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
        elif isinstance(message, AudioClip):
            await self._on_audio_clip(message)
        elif isinstance(message, RecordStart):
            await self._on_record_start(message)
        elif isinstance(message, RecordStop):
            await self._on_record_stop(message)
        elif isinstance(message, Cancel):
            # The id may name an agent request, a transcription in progress, a partly received
            # recording, or a live microphone recording. Each is cancelled if it exists; none of
            # them sends a reply.
            task_cancelled = self.session.cancel(message.targetId)
            recording_discarded = self._recordings.cancel(message.targetId)
            mic_discarded = await self._cancel_live(message.targetId)
            self._log(
                "cancel",
                id=message.targetId,
                found=task_cancelled or recording_discarded or mic_discarded,
            )
        elif isinstance(message, ActionResultMessage):
            self._log("action result received", id=message.replyTo, status=message.result.status)
        elif isinstance(message, Hello):
            await self.send(_error("VALIDATION_FAILED", "Already connected."))
        else:
            # Valid protocol messages this milestone does not act on (speech requests, backend-to-
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
            # The agent service uses the session's recent turns as context; simpler responders
            # (the Milestone 6 stub, test doubles) take only the request.
            with_history = getattr(self._agent, "respond_with_history", None)
            if with_history is not None:
                response = await with_history(request, self.session.history)
            else:
                response = await self._agent.respond(request)
            if await self.send(response):
                if isinstance(response, AgentResponse):
                    self.session.add_turn(_turn_text(request), response.speech)
                    self._log("agent task completed", id=request.id)
                else:  # an ErrorMessage: nothing is added to the history
                    self._log("agent task answered with an error", id=request.id, code=response.code)
        except asyncio.CancelledError:
            raise  # cancelled work sends nothing
        except Exception as error:
            self._log("agent task failed", id=request.id, error=type(error).__name__)
            await self.send(
                _error("INTERNAL", "The request could not be completed.", reply_to=request.id)
            )


    # --- audio: complete recordings are transcribed, text goes back as data (Task 8.4) ---

    async def _on_audio_clip(self, clip: AudioClip) -> None:
        """Take one ``audio_clip`` frame (a whole clip, or one chunk of a recording).

        Only a complete recording is transcribed. The transcript is returned to the extension as a
        ``transcription_result`` and nothing here acts on it: the extension feeds it to its own input
        pipeline like typed text, so the allow-list and confirmations still apply.
        """
        starts_recording = clip.seq is None or clip.seq == 0
        if starts_recording:
            try:
                self._stt.check_ready()  # no audio is collected, and no call made, without credentials
            except STTError as error:
                self._recordings.mark_failed(clip.id)  # later frames of this recording stay quiet
                self._log("audio refused", id=clip.id, code=error.code)
                await self.send(_error(error.code, error.message, recoverable=error.recoverable, reply_to=clip.id))
                return

        try:
            completed = self._recordings.accept(clip)
        except AudioRejected as rejected:
            self._log("audio frame rejected", id=clip.id, code=rejected.code, silent=rejected.silent)
            if not rejected.silent:
                await self.send(_error(rejected.code, rejected.message, reply_to=clip.id))
            return
        if completed is None:
            return
        self._log("recording complete", id=completed.id, size=len(completed.audio))
        await self._start_transcription(completed)

    # --- backend-local microphone recording (Task 8.5) ---
    #
    # The microphone opens only for a ``record_start`` the user caused, closes on ``record_stop``,
    # ``cancel``, the recording cap or disconnect, and the clip goes through the same transcription
    # path as an ``audio_clip``. Success of a start is silent (there is no acknowledgement message);
    # a failure is an ``error_message`` with ``replyTo`` set to the recording id.

    def _remember_finished(self, recording_id: str) -> None:
        self._finished_recordings[recording_id] = None
        self._finished_recordings.move_to_end(recording_id)
        while len(self._finished_recordings) > FINISHED_RECORDING_MEMORY:
            self._finished_recordings.popitem(last=False)

    async def _on_record_start(self, message: RecordStart) -> None:
        recording_id = message.id
        if self._recorder is None:
            await self.send(_error("MIC_UNAVAILABLE", NO_RECORDER_MESSAGE, recoverable=False, reply_to=recording_id))
            return
        if self._live is not None:
            self._log("record start refused", id=recording_id, reason="already_recording")
            await self.send(_error("VALIDATION_FAILED", "A recording is already in progress.", reply_to=recording_id))
            return
        if (
            recording_id == ""
            or len(recording_id) > 128
            or recording_id in self._finished_recordings
            or self.session.is_in_flight(recording_id)
        ):
            await self.send(_error("VALIDATION_FAILED", "That recording id cannot be used.", reply_to=recording_id))
            return
        try:
            self._stt.check_ready()  # never record audio that could not be transcribed
        except STTError as error:
            self._remember_finished(recording_id)
            self._log("record start refused", id=recording_id, code=error.code)
            await self.send(_error(error.code, error.message, recoverable=error.recoverable, reply_to=recording_id))
            return
        try:
            session = await self._open_microphone(self._recorder)  # re-checks the microphone every time
        except MicrophoneError as error:
            self._remember_finished(recording_id)
            self._log("record start failed", id=recording_id, code=error.code)
            await self.send(_error(error.code, error.message, reply_to=recording_id))
            return
        except Exception as error:
            self._remember_finished(recording_id)
            self._log("record start crashed", id=recording_id, error=type(error).__name__)
            await self.send(_error("INTERNAL", "The recording could not be started.", reply_to=recording_id))
            return
        self._live = (recording_id, session)
        self._cap_task = asyncio.create_task(self._stop_at_cap(recording_id, self._recorder.max_seconds))
        self._log("recording started", id=recording_id)

    @staticmethod
    async def _open_microphone(recorder: LocalRecorder) -> RecordingSession:
        """Open the microphone off the event loop, never leaving it open if this task is cancelled."""
        opening = asyncio.ensure_future(asyncio.to_thread(recorder.start))
        try:
            return await asyncio.shield(opening)
        except asyncio.CancelledError:
            def release(finished: asyncio.Future[RecordingSession]) -> None:
                if not finished.cancelled() and finished.exception() is None:
                    finished.result().cancel()  # nobody owns it any more: close it

            opening.add_done_callback(release)
            raise

    async def _on_record_stop(self, message: RecordStop) -> None:
        if self._live is not None and self._live[0] == message.id:
            await self._finish_live(message.id)
        elif message.id in self._finished_recordings:
            self._log("repeated record stop ignored", id=message.id)  # already stopped, capped or cancelled
        else:
            await self.send(_error("VALIDATION_FAILED", "No recording with that id is in progress.", reply_to=message.id))

    async def _stop_at_cap(self, recording_id: str, seconds: float) -> None:
        """The backend's own 60 s limit (the extension enforces the same one): stop and transcribe."""
        await asyncio.sleep(seconds)
        if self._live is not None and self._live[0] == recording_id:
            self._log("recording cap reached", id=recording_id)
            await self._finish_live(recording_id)

    def _detach_live(self, recording_id: str) -> RecordingSession | None:
        """Take ownership of the live recording (synchronously, so it can only be finished once)."""
        if self._live is None or self._live[0] != recording_id:
            return None
        session = self._live[1]
        self._live = None
        self._remember_finished(recording_id)
        cap, self._cap_task = self._cap_task, None
        if cap is not None and cap is not asyncio.current_task():
            cap.cancel()
        return session

    async def _finish_live(self, recording_id: str) -> None:
        session = self._detach_live(recording_id)
        if session is None:
            return
        try:
            recording = await asyncio.to_thread(session.stop)  # closes the microphone first
        except MicrophoneError as error:
            self._log("recording failed", id=recording_id, code=error.code)
            await self.send(_error(error.code, error.message, reply_to=recording_id))
            return
        except RecordingNotActive:
            return
        except Exception as error:
            self._log("recording crashed", id=recording_id, error=type(error).__name__)
            await self.send(_error("INTERNAL", "The recording could not be completed.", reply_to=recording_id))
            return
        self._log(
            "recording stopped", id=recording_id, size=recording.pcm_bytes, truncated=recording.truncated
        )
        if recording.pcm_bytes == 0:
            await self.send(_error("STT_NO_SPEECH", NO_AUDIO_MESSAGE, reply_to=recording_id))
            return
        await self._start_transcription(
            CompletedRecording(id=recording_id, mime_type=WAV_MIME_TYPE, audio=recording.wav)
        )

    async def _cancel_live(self, recording_id: str) -> bool:
        """Discard the live recording if ``recording_id`` is it. Sends no reply."""
        session = self._detach_live(recording_id)
        if session is None:
            return False
        await asyncio.to_thread(session.cancel)
        self._log("recording cancelled", id=recording_id)
        return True

    async def _abort_recording(self) -> None:
        """Disconnect cleanup: close the microphone and drop the audio.

        Done directly rather than in a worker thread: this runs while the connection is being torn
        down (possibly while this task is being cancelled), and the device must be released for
        certain. Closing a stream takes milliseconds.
        """
        if self._live is None:
            return
        recording_id = self._live[0]
        session = self._detach_live(recording_id)
        if session is None:
            return
        try:
            session.cancel()
        except Exception as error:  # noqa: BLE001 - cleanup must not raise out of serve()
            self._log("recording cleanup failed", id=recording_id, error=type(error).__name__)
        self._log("recording cancelled", id=recording_id)

    async def _start_transcription(self, recording: CompletedRecording) -> None:
        if len(self._transcribing) >= MAX_CONCURRENT_TRANSCRIPTIONS:
            await self.send(
                _error("STT_UNAVAILABLE", "Speech recognition is busy. Try again in a moment.", reply_to=recording.id)
            )
            return
        task = asyncio.create_task(self._run_transcription(recording))
        try:
            self.session.register(recording.id, task)
        except DuplicateRequestError:  # the id belongs to a request still in flight
            task.cancel()
            await self.send(_error("VALIDATION_FAILED", "That id is already in flight.", reply_to=recording.id))
            return
        self._transcribing.add(recording.id)
        task.add_done_callback(lambda finished: self._task_finished(recording.id, finished))

    async def _run_transcription(self, recording: CompletedRecording) -> None:
        try:
            text = await self._stt.transcribe(recording.audio, recording.mime_type)
            result = TranscriptionResult(
                version=PROTOCOL_VERSION, type="transcription_result", replyTo=recording.id, text=text
            )
            if await self.send(result):
                self._log("transcription completed", id=recording.id, chars=len(text))
        except asyncio.CancelledError:
            raise  # cancelled work sends nothing
        except STTError as error:
            self._log("transcription failed", id=recording.id, code=error.code)
            await self.send(_error(error.code, error.message, recoverable=error.recoverable, reply_to=recording.id))
        except Exception as error:
            self._log("transcription crashed", id=recording.id, error=type(error).__name__)
            await self.send(_error("INTERNAL", "The recording could not be processed.", reply_to=recording.id))
        finally:
            self._transcribing.discard(recording.id)


def create_app(
    *,
    agent: AgentResponder | None = None,
    auth_token: str | None = None,
    capabilities: Capabilities | None = None,
    stt: STTClient | None = None,
    recorder: LocalRecorder | None = None,
) -> FastAPI:
    """Build the app. ``agent``, ``capabilities``, ``auth_token``, ``stt`` and ``recorder`` are injectable.

    Without an injected ``recorder`` the backend can record from the default microphone (through
    ``default_audio_input``). The microphone is never opened at startup or by a handshake: only a
    ``record_start`` message does that, and ``hello_ack.capabilities.mic`` is read without capturing.

    Without an injected ``agent`` the client is chosen by ``KIROSIGHT_LLM`` (``stub``, the default,
    or ``bedrock``) the first time a connection needs it, which is after startup has loaded ``.env``.
    Without an injected ``stt`` speech-to-text is Deepgram Nova-2, configured from the environment.
    ``hello_ack`` reports the capabilities of whichever agent is in use, with ``stt`` true only when
    the speech client has what it needs to make a call (it does not prove Deepgram will accept it).
    """
    chosen: list[AgentSelection] = []
    speech: STTClient = stt if stt is not None else DeepgramSTTClient()
    device = None if recorder is not None else default_audio_input()
    mic: LocalRecorder | None = recorder if recorder is not None else (LocalRecorder(device) if device else None)

    def current() -> tuple[AgentResponder, Capabilities]:
        if agent is not None:
            base = capabilities if capabilities is not None else STUB_CAPABILITIES
        else:
            if not chosen:
                chosen.append(select_agent(resolve_llm_choice(), load_config()))
            base = chosen[0].capabilities
        ready = getattr(speech, "configured", None)
        if ready is None:
            try:
                speech.check_ready()
                ready = True
            except STTError:
                ready = False
        return (agent if agent is not None else chosen[0].agent), base.model_copy(update={"stt": bool(ready)})

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        load_config()  # loads .env (process env wins) and refuses a non-loopback host
        resolve_llm_choice()  # fail at startup, not on the first connection, for an unknown value
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
        try:
            responder, reported = current()
        except ConfigError:
            logger.error("agent configuration is invalid")
            await websocket.close(code=CLOSE_INTERNAL_ERROR)
            return
        if mic is not None:
            # Read the default microphone's state without capturing anything.
            reported = reported.model_copy(update={"mic": await asyncio.to_thread(mic.status)})
        await websocket.accept()
        await Connection(websocket, responder, _configured_token(auth_token), reported, speech, mic).serve()

    return application


app = create_app()


def run() -> None:
    """Start uvicorn on the validated loopback host/port with the 2 MiB WebSocket limit."""
    import uvicorn

    config = load_config()
    uvicorn.run(app, host=config.host, port=config.port, ws_max_size=WS_MAX_SIZE_BYTES)


if __name__ == "__main__":
    run()
