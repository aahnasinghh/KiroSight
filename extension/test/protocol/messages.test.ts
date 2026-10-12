import { describe, expect, it } from 'vitest';

import { BACKEND_MESSAGE_TYPES, ERROR_CODES, PROTOCOL_VERSION } from '../../src/protocol/constants';
import { protocolMessageSchema, protocolTypesMatchSchemas } from '../../src/protocol/validators';

describe('backend protocol constants', () => {
  it('uses protocol version 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('defines exactly the fourteen approved backend message types', () => {
    expect([...BACKEND_MESSAGE_TYPES].sort()).toEqual([
      'action_request',
      'action_result',
      'agent_request',
      'agent_response',
      'audio_clip',
      'cancel',
      'error_message',
      'hello',
      'hello_ack',
      'record_start',
      'record_stop',
      'speech_audio',
      'speech_request',
      'transcription_result',
    ]);
    expect(new Set(BACKEND_MESSAGE_TYPES).size).toBe(14);
  });

  it('keeps the runtime union in step with the declared message types', () => {
    expect([...protocolMessageSchema.options.map((option) => option.shape.type.value)].sort())
      .toEqual([...BACKEND_MESSAGE_TYPES].sort());
  });

  it('defines exactly the approved ErrorCode set', () => {
    expect([...ERROR_CODES]).toEqual([
      'VALIDATION_FAILED',
      'UNSUPPORTED_VERSION',
      'UNKNOWN_TYPE',
      'UNAUTHORIZED',
      'BEDROCK_UNAVAILABLE',
      'BEDROCK_INVALID_RESPONSE',
      'STT_UNAVAILABLE',
      'STT_NO_SPEECH',
      'TTS_UNAVAILABLE',
      'MIC_UNAVAILABLE',
      'MIC_DENIED',
      'CREDENTIAL_MISSING',
      'TIMEOUT',
      'CANCELLED',
      'INTERNAL',
    ]);
  });

  it('has no executable or generic command message', () => {
    for (const forbidden of ['run_command', 'execute', 'command', 'ping', 'pong', 'debug', 'log', 'ready']) {
      expect(BACKEND_MESSAGE_TYPES).not.toContain(forbidden);
    }
  });

  it('compiles only when the TypeScript types and Zod schemas agree', () => {
    expect(protocolTypesMatchSchemas).toBe(true);
  });
});
