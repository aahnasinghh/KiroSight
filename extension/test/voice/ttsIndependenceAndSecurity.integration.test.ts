import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOST_TO_WEBVIEW_TYPES } from '../../src/protocol/bridgeMessages';
import { AUDIO_BASE64, buildStack, flush, watchUnhandledRejections, type Stack } from './ttsHarness';

/**
 * Task 9.6, groups 5 and 6: INDEPENDENCE FROM SPEECH, and SECURITY / ACCESSIBILITY (Req 6.9, 9.4,
 * 10.2, 15.3).
 *
 * Defects these would catch: typed requests broken by a speech failure, by speech being switched
 * off, or by the backend lacking text-to-speech; an interruption deleting or shortening the text;
 * spoken audio or answer text reaching a log; a credential or a new kind of message leaving the
 * extension; speech code gaining a path that runs commands.
 *
 * Escape not trapping unrelated keys and speech cancellation not moving focus are proven in the
 * page itself by `test/webview/webviewPlayback.test.ts` (Task 9.4); here, the host side of that is
 * checked: no interruption ever sends the panel a `focus_input` message.
 */
const unhandled = watchUnhandledRejections();
beforeEach(() => unhandled.start());
afterEach(() => {
  vi.restoreAllMocks();
  expect(unhandled.finish()).toEqual([]);
});

const MARKER = 'PRIVATE-ANSWER-MARKER-7731';

describe('typed input does not depend on speech', () => {
  it('still works when the text-to-speech request fails', async () => {
    const s = await buildStack();
    s.pipeline.announce('First answer.');
    s.speakLatest();
    s.backendError('speech-1', 'TTS_UNAVAILABLE');
    expect(s.notices()).toHaveLength(1);

    await expect(s.pipeline.handle('where am I', 'typed')).resolves.toBe('handled');

    expect(s.kirosight()).toHaveLength(2);
    expect(s.kirosight()[0]!.text).toBe('First answer.');
  });

  it('still works with speech switched off: nothing is requested, no timer, no notice', async () => {
    const s = await buildStack({ speechOn: false });

    await expect(s.pipeline.handle('where am I', 'typed')).resolves.toBe('handled');
    s.speakLatest();
    s.speech.speakPendingConfirmation();
    s.speech.repeatConfirmation();

    expect(s.kirosight()).toHaveLength(1);
    expect(s.frames('speech_request')).toEqual([]);
    expect(s.notices()).toEqual([]);
    expect(s.scheduler.pendingCount).toBe(0);
  });

  it('still works when the backend reports no text-to-speech', async () => {
    const s = await buildStack({ tts: false });

    await expect(s.pipeline.handle('where am I', 'typed')).resolves.toBe('handled');
    s.speakLatest();

    expect(s.frames('speech_request')).toEqual([]);
    expect(s.kirosight()).toHaveLength(1);
    expect(s.scheduler.pendingCount).toBe(0);
  });

  it('still works after the backend connection is lost mid-speech (local commands never need it)', async () => {
    const s = await buildStack();
    s.pipeline.announce('An answer.');
    s.speakLatest();
    s.socket.triggerClose();

    await expect(s.pipeline.handle('where am I', 'typed')).resolves.toBe('handled');

    expect(s.kirosight().map((e) => e.text)[0]).toBe('An answer.');
    expect(s.kirosight()).toHaveLength(2);
  });
});

describe('cancelling speech never deletes or shortens the text', () => {
  it('the Transcript and the next view update keep the whole answer, at every phase', async () => {
    const long = `${'A complete sentence in a long answer. '.repeat(40)}Done.`;
    for (const phase of ['synthesis', 'delivered', 'playing', 'finished'] as const) {
      const s = await buildStack();
      s.pipeline.announce(long);
      s.speakLatest();
      if (phase !== 'synthesis') s.audio('speech-1');
      if (phase === 'playing' || phase === 'finished') s.speech.handlePlayback('started', 'speech-1');
      if (phase === 'finished') s.speech.handlePlayback('ended', 'speech-1');

      await s.escape();
      await flush();

      expect(s.kirosight().map((e) => e.text), phase).toEqual([long]);
      const views = s.posted().filter((m) => m.type === 'view_state') as unknown as Array<{ transcript: Array<{ text: string }> }>;
      expect(views.at(-1)!.transcript.map((e) => e.text), phase).toContain(long);
    }
  });
});

describe('failures are plain text, and nothing moves focus', () => {
  it('a speech failure is announced as an ordinary Transcript entry, in words', async () => {
    const s = await buildStack();
    s.pipeline.announce('An answer.');
    s.speakLatest();

    s.scheduler.advance(10_000);

    const notice = s.notices()[0]!;
    expect(notice.role).toBe('system');
    expect(notice.text).toMatch(/unavailable/i);
    expect(notice.text).toMatch(/transcript/i);
  });

  it('no interruption ever sends the panel a focus_input message', async () => {
    const s = await buildStack();
    s.pipeline.announce('An answer.');
    s.speakLatest();
    s.audio('speech-1');
    const mark = s.posted().length;

    await s.escape();
    s.pipeline.interrupt();
    await s.panel.receive({ type: 'ptt_toggle' });
    await flush();

    expect(s.posted().slice(mark).some((m) => m.type === 'focus_input')).toBe(false);
  });
});

describe('what is logged and what leaves the extension', () => {
  async function fullRun(): Promise<Stack> {
    const s = await buildStack();
    s.pipeline.announce(`${MARKER} first`);
    s.speakLatest();
    s.audio('speech-1');
    s.speech.handlePlayback('started', 'speech-1');
    await s.escape();
    s.pipeline.announce(`${MARKER} second`);
    s.speakLatest();
    s.backendError('speech-2', 'TTS_UNAVAILABLE');
    s.pipeline.announce(`${MARKER} third`);
    s.speakLatest();
    s.audio('speech-3');
    s.scheduler.advance(10_000);
    return s;
  }

  it('neither audio nor spoken text reaches the client log or the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));

    const s = await fullRun();

    const logged = s.logger.lines.join('\n');
    expect(logged).not.toContain(AUDIO_BASE64);
    expect(logged).not.toContain(MARKER);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(AUDIO_BASE64);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(MARKER);
  });

  it('audio is never stored in the Transcript or sent in any view update, only in play_audio', async () => {
    const s = await fullRun();

    expect(JSON.stringify(s.transcript.getEntries())).not.toContain(AUDIO_BASE64);
    const elsewhere = s.posted().filter((m) => m.type !== 'play_audio');
    expect(JSON.stringify(elsewhere)).not.toContain(AUDIO_BASE64);
  });

  it('no credential-like field leaves the extension, and only known message types are sent', async () => {
    const s = await fullRun();
    await s.panel.receive({ type: 'ptt_toggle' });
    await flush();

    const sent = JSON.stringify(s.socket.sentMessages);
    expect(sent).not.toMatch(/api[_-]?key|secret|password|authorization|bearer|DEEPGRAM|AWS_/i);
    const frameTypes = new Set(s.socket.sentMessages.map((m) => m.type as string));
    for (const type of frameTypes) {
      expect(['hello', 'speech_request', 'cancel', 'record_start', 'record_stop', 'agent_request', 'audio_clip']).toContain(type);
    }
    const hostTypes = new Set(s.posted().map((m) => m.type));
    for (const type of hostTypes) expect(HOST_TO_WEBVIEW_TYPES as readonly string[]).toContain(type);
  });

  it('no action ran, and no command or process path exists in the speech and interruption code', async () => {
    const s = await fullRun();
    expect(s.executed).toEqual([]);

    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
    for (const file of ['voice/speechController.ts', 'pipeline/inputPipeline.ts', 'backend/agentGateway.ts', 'webview/webviewProvider.ts']) {
      const source = readFileSync(resolve(root, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(source, file).not.toMatch(/RUN_COMMAND|child_process|executeCommand|\beval\(|new Function\(/);
    }
  });
});
