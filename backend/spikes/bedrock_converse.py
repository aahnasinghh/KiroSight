"""Spike E (Task 7.1): minimal Amazon Bedrock Converse request with a forced ``respond`` tool.

THROWAWAY EXPERIMENT. This is not the production Bedrock client, not an ``LLMClient`` and not an
``AgentService``; those belong to Tasks 7.2 onwards. Nothing under ``backend/app`` imports this file.

Default run is a SAFE OFFLINE DRY RUN. It makes no network request and does not even import boto3:

    python spikes/bedrock_converse.py

The dry run builds the Converse request, checks that exactly one ``respond`` tool is defined and
forced, and exercises the pure response extraction and strict Pydantic validation with synthetic
Converse responses (one valid, several deliberately invalid).

A single live request is only possible with the explicit ``--live`` flag. It uses the AWS SDK
default credential chain (including a Bedrock API key in ``AWS_BEARER_TOKEN_BEDROCK``). No
credential is read, stored or printed by this file, and only a safe error category is reported.
It has not been run: the AWS account's Nova Lite inference quotas are currently zero.

Region defaults to us-east-1; the model defaults to ``amazon.nova-lite-v1:0`` and may be overridden
with ``BEDROCK_MODEL_ID``.
"""

from __future__ import annotations

import copy
import os
import sys
from pathlib import Path
from typing import Any

# Run as ``python spikes/bedrock_converse.py`` from backend/: make ``app`` importable.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictStr, ValidationError, field_validator

from app.allowlist import ALLOWED_ACTIONS
from app.protocol.messages import MAX_SPEECH_CHARS, PROTOCOL_VERSION, AgentResponse

DEFAULT_REGION = "us-east-1"
DEFAULT_MODEL_ID = "amazon.nova-lite-v1:0"
TOOL_NAME = "respond"

SYNTHETIC_PROMPT = (
    "Explain that the current file has one error. Respond only through the respond tool."
)
SYSTEM_PROMPT = (
    "You are a spike test for KiroSight. Always answer by calling the respond tool. "
    "Use the NO_ACTION action and set confirmationRequired to false."
)


# --- strict model of what the model is allowed to author -------------------------------------


class SpikeError(Exception):
    """A safe, credential-free reason why the spike could not produce a valid response."""


class SpikeToolInput(BaseModel):
    """The ``respond`` tool input. Unknown fields are rejected, never dropped.

    ``version``, ``type`` and ``replyTo`` are transport fields the backend supplies, so the model
    does not author them. :func:`to_agent_response` adds them and validates the result against the
    real protocol ``AgentResponse`` as well.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    speech: StrictStr = Field(min_length=1, max_length=MAX_SPEECH_CHARS)
    action: dict[str, Any]
    confirmationRequired: StrictBool

    @field_validator("action")
    @classmethod
    def _action_is_allow_listed(cls, value: dict[str, Any]) -> dict[str, Any]:
        action_type = value.get("type")
        if not isinstance(action_type, str):
            raise ValueError("action.type must be a string")
        spec = ALLOWED_ACTIONS.get(action_type)
        if spec is None:
            raise ValueError("action is not in the allow-list")
        try:
            # ``type`` is the registry key; every other field must satisfy the strict parameters.
            spec.validate_params({key: item for key, item in value.items() if key != "type"})
        except ValidationError as error:
            raise ValueError("action parameters are invalid") from error
        return value


def to_agent_response(tool_input: SpikeToolInput, reply_to: str) -> AgentResponse:
    """Wrap validated tool input in the real protocol envelope (strict, extra="forbid")."""
    return AgentResponse.model_validate(
        {
            "version": PROTOCOL_VERSION,
            "type": "agent_response",
            "replyTo": reply_to,
            **tool_input.model_dump(),
        }
    )


# --- request construction ---------------------------------------------------------------------

_SEVERITY = {"type": "string", "enum": ["error", "warning", "any"]}

#: Hand-written JSON Schema for the tool input. Flat on purpose: no $ref, no oneOf.
RESPOND_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "speech": {"type": "string", "minLength": 1, "maxLength": MAX_SPEECH_CHARS},
        "action": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": sorted(ALLOWED_ACTIONS)},
                "index": {"type": "integer", "minimum": 0},
                "severity": _SEVERITY,
                "path": {"type": "string", "minLength": 1},
                "line": {"type": "integer", "minimum": 1},
            },
            "required": ["type"],
            "additionalProperties": False,
        },
        "confirmationRequired": {"type": "boolean"},
    },
    "required": ["speech", "action", "confirmationRequired"],
    "additionalProperties": False,
}


def build_converse_request(model_id: str) -> dict[str, Any]:
    """The minimal Converse request: one tool, forced via ``toolChoice``. No IDE context."""
    return {
        "modelId": model_id,
        "system": [{"text": SYSTEM_PROMPT}],
        "messages": [{"role": "user", "content": [{"text": SYNTHETIC_PROMPT}]}],
        "inferenceConfig": {"maxTokens": 512, "temperature": 0},
        "toolConfig": {
            "tools": [
                {
                    "toolSpec": {
                        "name": TOOL_NAME,
                        "description": "Return the KiroSight answer and the single action to take.",
                        "inputSchema": {"json": RESPOND_INPUT_SCHEMA},
                    }
                }
            ],
            "toolChoice": {"tool": {"name": TOOL_NAME}},
        },
    }


# --- pure response extraction -----------------------------------------------------------------


def extract_respond_input(response: Any) -> dict[str, Any]:
    """Find the single ``toolUse`` block named ``respond`` and return its raw input.

    Ordinary text output is never treated as success, the first block is not assumed to be the
    tool, and a missing, wrongly named, duplicated or non-object tool input fails safely.
    """
    try:
        content = response["output"]["message"]["content"]
    except (KeyError, TypeError) as error:
        raise SpikeError("response has no output message content") from error
    if not isinstance(content, list):
        raise SpikeError("response content is not a list")

    tool_uses = [
        block["toolUse"]
        for block in content
        if isinstance(block, dict) and isinstance(block.get("toolUse"), dict)
    ]
    if not tool_uses:
        raise SpikeError("no toolUse block was returned")
    respond_uses = [use for use in tool_uses if use.get("name") == TOOL_NAME]
    if not respond_uses:
        raise SpikeError("no toolUse block named respond was returned")
    if len(respond_uses) > 1:
        raise SpikeError("more than one respond toolUse block was returned")

    tool_input = respond_uses[0].get("input")
    if not isinstance(tool_input, dict):
        raise SpikeError("respond toolUse input is missing or not an object")
    return tool_input


def parse_respond_response(response: Any, reply_to: str = "spike-1") -> AgentResponse:
    """Extract and strictly validate. Raises SpikeError or pydantic.ValidationError."""
    tool_input = SpikeToolInput.model_validate(extract_respond_input(response))
    return to_agent_response(tool_input, reply_to)


# --- offline dry run --------------------------------------------------------------------------


def _converse_response(*blocks: dict[str, Any]) -> dict[str, Any]:
    return {
        "output": {"message": {"role": "assistant", "content": list(blocks)}},
        "stopReason": "tool_use",
    }


def _tool_use(tool_input: Any, name: str = TOOL_NAME) -> dict[str, Any]:
    return {"toolUse": {"toolUseId": "tooluse_synthetic", "name": name, "input": tool_input}}


VALID_INPUT: dict[str, Any] = {
    "speech": "The current file has one error.",
    "action": {"type": "NO_ACTION"},
    "confirmationRequired": False,
}


def _with(**changes: Any) -> dict[str, Any]:
    value = copy.deepcopy(VALID_INPUT)
    value.update(changes)
    return value


def _without(key: str) -> dict[str, Any]:
    value = copy.deepcopy(VALID_INPUT)
    del value[key]
    return value


def _rejects(label: str, response: Any) -> tuple[str, bool]:
    try:
        parse_respond_response(response)
    except (SpikeError, ValidationError):
        return label, True
    return label, False


def dry_run() -> bool:
    results: list[tuple[str, bool]] = []

    def check(label: str, condition: bool) -> None:
        results.append((label, condition))

    # Request construction.
    request = build_converse_request(os.environ.get("BEDROCK_MODEL_ID") or DEFAULT_MODEL_ID)
    tools = request["toolConfig"]["tools"]
    check("request has exactly one tool", len(tools) == 1)
    check("the tool is named respond", tools[0]["toolSpec"]["name"] == TOOL_NAME)
    check(
        "toolChoice forces the respond tool",
        request["toolConfig"]["toolChoice"] == {"tool": {"name": TOOL_NAME}},
    )
    check("tool schema forbids extra fields", RESPOND_INPUT_SCHEMA["additionalProperties"] is False)
    check(
        "tool schema action enum is exactly the allow-list",
        RESPOND_INPUT_SCHEMA["properties"]["action"]["properties"]["type"]["enum"]
        == sorted(ALLOWED_ACTIONS),
    )
    flat = repr(request).lower()
    check("request carries no credential-like text", not any(w in flat for w in ("secret", "token=", "akia")))
    check("model config forbids extra fields", SpikeToolInput.model_config.get("extra") == "forbid")

    # A valid synthetic Converse response, with text before the tool block.
    valid = _converse_response({"text": "Calling the tool."}, _tool_use(VALID_INPUT))
    try:
        parsed = parse_respond_response(valid)
        check("valid synthetic response parses into AgentResponse", parsed.action.type == "NO_ACTION")
        check("parsed confirmationRequired is False", parsed.confirmationRequired is False)
    except (SpikeError, ValidationError):
        check("valid synthetic response parses into AgentResponse", False)

    # Deliberately invalid synthetic responses: each must be rejected.
    invalid = [
        ("rejects an unexpected top-level field", _converse_response(_tool_use(_with(extra="x")))),
        ("rejects a command field inside the action", _converse_response(
            _tool_use(_with(action={"type": "NO_ACTION", "command": "rm -rf /"})))),
        ("rejects a missing required field", _converse_response(_tool_use(_without("confirmationRequired")))),
        ("rejects a missing speech", _converse_response(_tool_use(_without("speech")))),
        ("rejects an action outside the allow-list", _converse_response(
            _tool_use(_with(action={"type": "RUN_COMMAND", "command": "ls"})))),
        ("rejects bad action parameters", _converse_response(
            _tool_use(_with(action={"type": "GO_TO_LINE", "line": 0})))),
        ("rejects a non-boolean confirmationRequired", _converse_response(
            _tool_use(_with(confirmationRequired="false")))),
        ("rejects an over-long speech", _converse_response(
            _tool_use(_with(speech="x" * (MAX_SPEECH_CHARS + 1))))),
        ("rejects text-only output with no toolUse", _converse_response({"text": "Plain answer."})),
        ("rejects a toolUse with the wrong name", _converse_response(_tool_use(VALID_INPUT, name="other"))),
        ("rejects a non-object tool input", _converse_response(_tool_use("not an object"))),
        ("rejects a missing tool input", _converse_response({"toolUse": {"name": TOOL_NAME}})),
        ("rejects two respond blocks", _converse_response(_tool_use(VALID_INPUT), _tool_use(VALID_INPUT))),
        ("rejects a malformed response", {"output": {}}),
    ]
    results.extend(_rejects(label, response) for label, response in invalid)

    for label, passed in results:
        print(f"{'PASS' if passed else 'FAIL'}: {label}")

    no_boto = "boto3" not in sys.modules
    print(f"{'PASS' if no_boto else 'FAIL'}: dry run did not import boto3 (no network possible)")
    all_passed = all(passed for _, passed in results) and no_boto
    print("DRY RUN " + ("OK" if all_passed else "FAILED") + ": offline only, no AWS request was made")
    return all_passed


# --- optional single live request (never run by default) --------------------------------------


def live_run() -> bool:
    """One Converse request through the AWS SDK default credential chain."""
    import boto3  # imported lazily so the dry run can never reach the network
    from botocore.exceptions import BotoCoreError, ClientError

    region = os.environ.get("AWS_REGION") or DEFAULT_REGION
    model_id = os.environ.get("BEDROCK_MODEL_ID") or DEFAULT_MODEL_ID
    print(f"LIVE: region={region} model={model_id} (credentials via the AWS SDK default chain)")

    client = boto3.client("bedrock-runtime", region_name=region)
    try:
        response = client.converse(**build_converse_request(model_id))
    except ClientError as error:
        # Only the error category is printed, never the message or request details.
        code = error.response.get("Error", {}).get("Code", "UnknownClientError")
        print(f"FAIL: Bedrock Converse returned {code}")
        return False
    except BotoCoreError as error:
        print(f"FAIL: AWS SDK error {type(error).__name__}")
        return False

    try:
        parsed = parse_respond_response(response)
    except SpikeError as error:
        print(f"FAIL: {error}")
        return False
    except ValidationError:
        print("FAIL: respond tool input failed strict AgentResponse validation")
        return False

    print("PASS: respond tool returned and AgentResponse validation succeeded")
    print(f"      action={parsed.action.type} confirmationRequired={parsed.confirmationRequired}")
    return True


def main(argv: list[str]) -> int:
    if "--live" in argv:
        return 0 if live_run() else 1
    return 0 if dry_run() else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
