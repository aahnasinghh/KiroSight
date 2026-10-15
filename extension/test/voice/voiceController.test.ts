import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Capabilities } from '../../src/protocol/messages';
import {
  FIRST_SAMPLE_WATCHDOG_MS,
  STT_RESPONSE_LIMIT_MS,
  VOICE_INIT_BUDGET_MS,
  VoiceController,
  describeVoiceStatus,
  type VoiceControllerDeps,
  type VoiceStatus,
} from '../../src/voice/voiceController';
import {
  DEFAULT_VOICE_KIND,
  MAX_VOICE_DURATION_MS,
  type TranscriptionOutcome,
  type VoiceAvailability,
  type VoiceClip,
  type VoiceInput,
  type VoiceKind,
  type VoiceTranscriber,
} from '../../src/voice/voiceInput';
import { FakeScheduler } from '../mocks/fakeScheduler';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeInput implements VoiceInput {
  public readonly maxDurationMs = MAX_VOICE_DURATION_MS;
  public readonly calls: string[] = [];
  public availability: VoiceAvailability = { ok: true };
  public availableNever = false;
  public startError = false;
  public stopError = false;
  public clip: VoiceClip = { backendClipId: 'clip-1' };

  public constructor(public readonly kind: VoiceKind) {}

  public available(): Promise<VoiceAvailability> {
    this.calls.push('available');
    return this.availableNever ? new Promise(() => undefined) : Promise.resolve(this.availability);
  }

  public async start(): Promise<void> {
    this.calls.push('start');
    if (this.startError) throw new Error('device busy');
  }

  public async stop(): Promise<VoiceClip> {
    this.calls.push('stop');
    if (this.stopError) throw new Error('device lost');
    return this.clip;
  }

  public cancel(): void {
    this.calls.push('cancel');
  }

  public count(call: string): number {
    return this.calls.filter((entry) => entry === call).length;
  }
}

class FakeTranscriber implements VoiceTranscriber {
  public readonly clips: VoiceClip[] = [];
  public cancelled = 0;
  public next: () => Promise<TranscriptionOutcome> = () => Promise.resolve({ ok: true, text: 'where am I' });

  public transcribe(clip: VoiceClip): Promise<TranscriptionOutcome> {
    this.clips.push(clip);
    return this.next();
  }

  public cancel(): void {
    this.cancelled += 1;
  }
}

const caps = (overrides: Partial<Capabilities> = {}): Capabilities =>
  ({ bedrock: false, stt: true, tts: false, mic: 'available', ...overrides });

function build(options: { kinds?: VoiceKind[]; preferred?: VoiceKind } = {}) {
  const scheduler = new FakeScheduler();
  const webview = new FakeInput('webview');
  const local = new FakeInput('backend_local');
  const kinds = options.kinds ?? ['webview', 'backend_local'];
  const transcriber = new FakeTranscriber();
  const handled: Array<[string, string]> = [];
  const pipeline = { handle: async (text: string, source: 'voice') => { handled.push([text, source]); return 'handled'; } };
  const deps: VoiceControllerDeps = {
    inputs: {
      ...(kinds.includes('webview') ? { webview } : {}),
      ...(kinds.includes('backend_local') ? { backend_local: local } : {}),
    },
    transcriber,
    pipeline,
    scheduler,
    ...(options.preferred === undefined ? {} : { preferred: options.preferred }),
  };
  const controller = new VoiceController(deps);
  const statuses: VoiceStatus[] = [];
  controller.onStatus((status) => statuses.push(status));
  return { controller, scheduler, webview, local, transcriber, handled, statuses };
}

async function ready(options: Parameters<typeof build>[0] = {}, capabilities: Capabilities = caps()) {
  const harness = build(options);
  await harness.controller.initialize(capabilities);
  return harness;
}

describe('the Spike D default', () => {
  it('prefers the backend-local implementation, because webview capture was refused in Kiro', () => {
    expect(DEFAULT_VOICE_KIND).toBe('backend_local');
  });

  it('keeps the documented limits', () => {
    expect(MAX_VOICE_DURATION_MS).toBe(60_000);
    expect(FIRST_SAMPLE_WATCHDOG_MS).toBe(5_000);
    expect(STT_RESPONSE_LIMIT_MS).toBe(10_000);
    expect(VOICE_INIT_BUDGET_MS).toBe(10_000);
  });
});

describe('initialization', () => {
  it('selects the backend-local input by default and never records while doing so', async () => {
    const { controller, local, webview } = build();

    const status = await controller.initialize(caps());

    expect(status).toMatchObject({ phase: 'idle', kind: 'backend_local', micState: 'granted', cause: null });
    expect(local.calls).toEqual(['available']); // asked, never started
    expect(webview.calls).toEqual([]);
    expect(status.text).toBe('Voice is ready. Press push-to-talk to speak.');
  });

  it('is unavailable with no backend or no speech recognition, and says why in plain text', async () => {
    const offline = await build().controller.initialize(null);
    const noStt = await build().controller.initialize(caps({ stt: false }));

    expect(offline).toMatchObject({ phase: 'unavailable', cause: 'no_backend' });
    expect(offline.text).toContain('You can keep typing.');
    expect(noStt).toMatchObject({ phase: 'unavailable', cause: 'stt_unavailable' });
  });

  it.each([
    ['denied', 'mic_denied'],
    ['unavailable', 'mic_unavailable'],
    ['not_applicable', 'unsupported'],
  ] as const)('is unavailable when the backend reports the microphone %s', async (mic, cause) => {
    const { controller, local } = build({ kinds: ['backend_local'] });

    const status = await controller.initialize(caps({ mic }));

    expect(status).toMatchObject({ phase: 'unavailable', kind: null, cause });
    expect(local.calls).toEqual([]);
  });

  it('gives up at exactly the 10 s voice initialization budget, not before', async () => {
    const { controller, scheduler, local } = build();
    local.availableNever = true;

    const pending = controller.initialize(caps());
    await flush();
    scheduler.advance(VOICE_INIT_BUDGET_MS - 1);
    await flush();
    expect(controller.status.phase).toBe('initializing');

    scheduler.advance(1);
    const status = await pending;

    expect(status).toMatchObject({ phase: 'unavailable', cause: 'init_timeout' });
    expect(status.text).toContain('unavailable for this session');
    expect(scheduler.pendingCount).toBe(0);
  });

  it('uses the webview input when it is preferred and it can capture', async () => {
    const { controller } = build({ preferred: 'webview' });
    expect(await controller.initialize(caps({ mic: 'not_applicable' }))).toMatchObject({ phase: 'idle', kind: 'webview' });
  });

  it('falls through to the backend-local input when the webview is refused, and remembers that', async () => {
    const { controller, webview } = build({ preferred: 'webview' });
    webview.availability = { ok: false, reason: 'denied' };

    const status = await controller.initialize(caps());

    expect(status).toMatchObject({ phase: 'idle', kind: 'backend_local', webviewUnreliable: true });
  });

  it('leaves an undetermined webview permission to the first attempt, and says so', async () => {
    const { controller, webview } = build({ preferred: 'webview' });
    webview.availability = { ok: false, reason: 'undetermined' };

    const status = await controller.initialize(caps({ mic: 'not_applicable' }));

    expect(status).toMatchObject({ phase: 'idle', kind: 'webview', micState: 'undetermined' });
    expect(status.text).toContain('Press push-to-talk to request it');
  });

  it('survives an input whose availability check throws', async () => {
    const { controller, local } = build({ kinds: ['backend_local'] });
    local.available = () => Promise.reject(new Error('broken'));

    expect(await controller.initialize(caps())).toMatchObject({ phase: 'unavailable', cause: 'mic_unavailable' });
  });
});

describe('push-to-talk', () => {
  it('starts only when asked, once, and reports the listening state', async () => {
    const { controller, local, statuses } = await ready();
    expect(local.count('start')).toBe(0);

    expect(await controller.startListening()).toEqual({ status: 'listening' });
    expect(await controller.startListening()).toEqual({ status: 'busy' });

    expect(local.count('start')).toBe(1);
    expect(controller.status).toMatchObject({ phase: 'listening', text: 'Listening.' });
    expect(statuses.at(-1)).toMatchObject({ phase: 'listening' });
  });

  it('hands the transcribed text, trimmed, to the pipeline as a voice utterance, and nothing else', async () => {
    const { controller, local, transcriber, handled } = await ready();
    transcriber.next = () => Promise.resolve({ ok: true, text: '  go to line 12 \n' });
    await controller.startListening();

    const outcome = await controller.stopListening();

    expect(outcome).toEqual({ status: 'routed' });
    expect(handled).toEqual([['go to line 12', 'voice']]);
    expect(transcriber.clips).toEqual([{ backendClipId: 'clip-1' }]);
    expect(local.count('stop')).toBe(1);
    expect(controller.status.phase).toBe('idle');
  });

  it('passes the same text through the same call whichever implementation produced it (Req 19.7)', async () => {
    const results: Array<Array<[string, string]>> = [];
    for (const preferred of ['webview', 'backend_local'] as const) {
      const harness = await ready({ preferred }, caps({ mic: 'available' }));
      harness.transcriber.next = () => Promise.resolve({ ok: true, text: 'what errors are there' });
      await harness.controller.startListening();
      await harness.controller.stopListening();
      results.push(harness.handled);
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual([['what errors are there', 'voice']]);
  });

  it('ends the capture itself at the 60 s cap and reports the outcome', async () => {
    const { controller, scheduler, local, handled } = await ready();
    const capOutcomes: unknown[] = [];
    controller.onCapReached((outcome) => capOutcomes.push(outcome));
    await controller.startListening();

    scheduler.advance(MAX_VOICE_DURATION_MS - 1);
    await flush();
    expect(local.count('stop')).toBe(0);

    scheduler.advance(1);
    await flush();

    expect(local.count('stop')).toBe(1);
    expect(handled).toEqual([['where am I', 'voice']]);
    expect(capOutcomes).toEqual([{ status: 'routed' }]);
  });

  it('does not stop anything when not listening', async () => {
    const { controller, local } = await ready();
    expect(await controller.stopListening()).toEqual({ status: 'not_listening' });
    expect(local.count('stop')).toBe(0);
  });

  it('refuses to start before initialization or when voice is unavailable', async () => {
    const fresh = build();
    expect(await fresh.controller.startListening()).toEqual({ status: 'failed', reason: 'not_available' });
    const offline = build();
    await offline.controller.initialize(null);
    expect(await offline.controller.startListening()).toEqual({ status: 'failed', reason: 'not_available' });
    expect(fresh.local.calls).toEqual([]);
    expect(offline.local.calls).toEqual([]);
  });
});

describe('failure leaves nothing routed and typed input untouched', () => {
  it('routes nothing when the speech-to-text limit of 10 s passes, and ignores a late answer', async () => {
    const { controller, scheduler, transcriber, handled } = await ready();
    let answer: (outcome: TranscriptionOutcome) => void = () => undefined;
    transcriber.next = () => new Promise((resolve) => { answer = resolve; });
    await controller.startListening();

    const stopping = controller.stopListening();
    await flush();
    scheduler.advance(STT_RESPONSE_LIMIT_MS - 1);
    await flush();
    expect(controller.status.phase).toBe('processing');
    scheduler.advance(1);
    const outcome = await stopping;
    answer({ ok: true, text: 'too late' });
    await flush();

    expect(outcome).toEqual({ status: 'failed', reason: 'timeout' });
    expect(handled).toEqual([]);
    expect(transcriber.cancelled).toBe(1);
    expect(controller.status.phase).toBe('idle'); // push-to-talk stays available
    expect(scheduler.pendingCount).toBe(0);
  });

  it.each(['stt_unavailable', 'no_speech', 'backend_unavailable'] as const)('passes %s through and routes nothing', async (reason) => {
    const { controller, transcriber, handled } = await ready();
    transcriber.next = () => Promise.resolve({ ok: false, reason });
    await controller.startListening();

    expect(await controller.stopListening()).toEqual({ status: 'failed', reason });
    expect(handled).toEqual([]);
    expect(controller.status.phase).toBe('idle');
  });

  it.each(['', '   ', '\n\t'])('treats %j as an empty transcription', async (text) => {
    const { controller, transcriber, handled } = await ready();
    transcriber.next = () => Promise.resolve({ ok: true, text });
    await controller.startListening();

    expect(await controller.stopListening()).toEqual({ status: 'failed', reason: 'empty' });
    expect(handled).toEqual([]);
  });

  it('survives a transcriber that throws', async () => {
    const { controller, transcriber, handled } = await ready();
    transcriber.next = () => Promise.reject(new Error('boom'));
    await controller.startListening();

    expect(await controller.stopListening()).toEqual({ status: 'failed', reason: 'stt_unavailable' });
    expect(handled).toEqual([]);
  });

  it('reports a capture that cannot start or stop, and returns to idle', async () => {
    const failsToStart = await ready();
    failsToStart.local.startError = true;
    expect(await failsToStart.controller.startListening()).toEqual({ status: 'failed', reason: 'capture_failed' });
    expect(failsToStart.controller.status.phase).toBe('idle');

    const failsToStop = await ready();
    failsToStop.local.stopError = true;
    await failsToStop.controller.startListening();
    expect(await failsToStop.controller.stopListening()).toEqual({ status: 'failed', reason: 'capture_failed' });
    expect(failsToStop.controller.status.phase).toBe('idle');
    expect(failsToStop.handled).toEqual([]);
  });

  it('does not let a failing pipeline break the controller', async () => {
    const harness = await ready();
    const controller = new VoiceController({
      inputs: { backend_local: harness.local },
      transcriber: harness.transcriber,
      pipeline: { handle: () => Promise.reject(new Error('pipeline down')) },
      scheduler: harness.scheduler,
    });
    await controller.initialize(caps());
    await controller.startListening();

    expect(await controller.stopListening()).toEqual({ status: 'failed', reason: 'internal' });
    expect(controller.status.phase).toBe('idle');
  });
});

describe('the last known microphone state (Req 18.6)', () => {
  it('remembers a denial, then works at once after the permission is granted, with no restart', async () => {
    const { controller, local } = await ready();
    local.availability = { ok: false, reason: 'denied' };

    expect(await controller.startListening()).toEqual({ status: 'failed', reason: 'not_available' });
    expect(controller.status.micState).toBe('denied');
    expect(local.count('start')).toBe(0);

    local.availability = { ok: true };
    expect(await controller.startListening()).toEqual({ status: 'listening' });
    expect(controller.status.micState).toBe('granted');
    expect(local.count('start')).toBe(1);
  });

  it('records a device that vanishes and a backend that reports a denied microphone', async () => {
    const { controller, transcriber } = await ready();
    transcriber.next = () => Promise.resolve({ ok: false, reason: 'mic_denied' });
    await controller.startListening();
    await controller.stopListening();
    expect(controller.status.micState).toBe('denied');

    transcriber.next = () => Promise.resolve({ ok: false, reason: 'mic_unavailable' });
    await controller.startListening();
    await controller.stopListening();
    expect(controller.status.micState).toBe('unavailable');
  });
});

describe('the 5 s first-sample watchdog (webview only)', () => {
  const webviewReady = () => ready({ preferred: 'webview' }, caps({ mic: 'available' }));

  it('marks webview capture unreliable at 5 s, releases the microphone and moves to the backend-local input', async () => {
    const { controller, scheduler, webview } = await webviewReady();
    await controller.startListening();

    scheduler.advance(FIRST_SAMPLE_WATCHDOG_MS - 1);
    expect(controller.status).toMatchObject({ phase: 'listening', kind: 'webview' });
    scheduler.advance(1);

    expect(webview.count('cancel')).toBe(1);
    expect(controller.status).toMatchObject({ phase: 'idle', kind: 'backend_local', webviewUnreliable: true });
    expect(scheduler.pendingCount).toBe(0);
  });

  it('is satisfied by a first sample, and the capture then runs on to the cap', async () => {
    const { controller, scheduler, webview } = await webviewReady();
    await controller.startListening();

    scheduler.advance(FIRST_SAMPLE_WATCHDOG_MS - 1);
    controller.notifyFirstSample();
    scheduler.advance(10_000);

    expect(webview.count('cancel')).toBe(0);
    expect(controller.status).toMatchObject({ phase: 'listening', kind: 'webview', webviewUnreliable: false });
  });

  it('with no other input, becomes unavailable with a plain-text reason', async () => {
    const { controller, scheduler } = build({ kinds: ['webview'], preferred: 'webview' });
    await controller.initialize(caps({ mic: 'not_applicable' }));
    await controller.startListening();

    scheduler.advance(FIRST_SAMPLE_WATCHDOG_MS);

    expect(controller.status).toMatchObject({ phase: 'unavailable', cause: 'webview_unreliable', kind: null });
    expect(controller.status.text).toContain('You can keep typing.');
  });

  it('does not run for the backend-local input', async () => {
    const { controller, scheduler, local } = await ready();
    await controller.startListening();

    scheduler.advance(FIRST_SAMPLE_WATCHDOG_MS + 1);

    expect(local.count('cancel')).toBe(0);
    expect(controller.status.phase).toBe('listening');
  });

  it('falls back when the webview refuses at the start of an attempt', async () => {
    const { controller, webview } = await webviewReady();
    webview.availability = { ok: false, reason: 'unavailable' };

    expect(await controller.startListening()).toEqual({ status: 'failed', reason: 'webview_unreliable' });

    expect(webview.count('start')).toBe(0);
    expect(controller.status).toMatchObject({ kind: 'backend_local', webviewUnreliable: true });
  });
});

describe('cancellation and shutdown release the microphone', () => {
  it('cancels a capture, clears its timers, and routes nothing even if text arrives later', async () => {
    const { controller, scheduler, local, transcriber, handled } = await ready();
    await controller.startListening();

    controller.cancel();

    expect(local.count('cancel')).toBe(1);
    expect(scheduler.pendingCount).toBe(0);
    expect(controller.status.phase).toBe('idle');
    expect(await controller.stopListening()).toEqual({ status: 'not_listening' });
    expect(handled).toEqual([]);
    expect(transcriber.clips).toEqual([]);
  });

  it('drops a transcription that was pending when it was cancelled', async () => {
    const { controller, transcriber, handled } = await ready();
    let answer: (outcome: TranscriptionOutcome) => void = () => undefined;
    transcriber.next = () => new Promise((resolve) => { answer = resolve; });
    await controller.startListening();
    const stopping = controller.stopListening();
    await flush();

    controller.cancel();
    answer({ ok: true, text: 'where am I' });

    expect(await stopping).toEqual({ status: 'cancelled' });
    expect(handled).toEqual([]);
    expect(transcriber.cancelled).toBe(1);
  });

  it('a new capture is not affected by an older one that was cancelled', async () => {
    const { controller, transcriber, handled } = await ready();
    await controller.startListening();
    controller.cancel();
    transcriber.next = () => Promise.resolve({ ok: true, text: 'next error' });

    await controller.startListening();
    await controller.stopListening();

    expect(handled).toEqual([['next error', 'voice']]);
  });

  it('dispose releases the microphone and every timer, and makes the controller inert', async () => {
    const { controller, scheduler, local, handled, statuses } = await ready();
    await controller.startListening();
    const seen = statuses.length;

    controller.dispose();
    controller.dispose();

    expect(local.count('cancel')).toBe(1);
    expect(scheduler.pendingCount).toBe(0);
    expect(await controller.startListening()).toEqual({ status: 'failed', reason: 'not_available' });
    expect(await controller.stopListening()).toEqual({ status: 'not_listening' });
    expect((await controller.initialize(caps())).phase).not.toBe('listening');
    expect(statuses.length).toBe(seen + 1); // only the cancel's own status change, nothing afterwards
    expect(handled).toEqual([]);
    expect(local.count('start')).toBe(1);
  });

  it('a status listener that throws cannot break the controller', async () => {
    const { controller } = build();
    controller.onStatus(() => { throw new Error('ui bug'); });

    await expect(controller.initialize(caps())).resolves.toMatchObject({ phase: 'idle' });
  });
});

describe('status text', () => {
  it('has a non-empty plain sentence for every phase and cause, and never relies on color', () => {
    for (const phase of ['initializing', 'idle', 'listening', 'processing'] as const) {
      expect(describeVoiceStatus({ phase, cause: null, micState: 'unknown' }).length).toBeGreaterThan(5);
    }
    for (const cause of ['no_backend', 'stt_unavailable', 'no_input', 'mic_denied', 'mic_unavailable', 'unsupported', 'webview_unreliable', 'init_timeout'] as const) {
      const text = describeVoiceStatus({ phase: 'unavailable', cause, micState: 'unknown' });
      expect(text).toMatch(/unavailable|not available/);
      expect(text).toContain('You can keep typing.');
    }
  });
});

describe('what the controller is allowed to depend on', () => {
  const source = readFileSync(resolvePath(__dirname, '../../src/voice/voiceController.ts'), 'utf8');

  it('never reaches the router, the validator, the confirmation manager, the executor or a credential', () => {
    expect(source).not.toMatch(/from '\.\.\/(?:intent|actions|confirmation|context|navigation|pipeline|transcript)\//);
    expect(source).not.toMatch(/localIntentRouter|validateAction|ConfirmationManager|ActionGate|ActionExecutor/);
    expect(source).not.toMatch(/api[_-]?key|token|secret|password|Bearer|process\.env|child_process|fetch\(|WebSocket/i);
  });

  it('calls the pipeline in exactly one place, with the voice source', () => {
    expect(source.match(/pipeline\.handle\(/g)).toHaveLength(1);
    expect(source).toContain("pipeline.handle(text, 'voice')");
  });

  it('starts a capture in exactly one place: startListening', () => {
    expect(source.match(/\.start\(\)/g)).toHaveLength(1);
  });

  it('logs nothing', () => {
    expect(source).not.toMatch(/console\.|logger|appendLine/);
  });
});

describe('a webview with nothing to fall back to is not written off (Req 18.6, Property 28)', () => {
  const webviewOnly = () => build({ kinds: ['webview'], preferred: 'webview' });
  const webviewCaps = caps({ mic: 'not_applicable' });

  it.each([
    ['denied', 'mic_denied', 'denied'],
    ['unavailable', 'mic_unavailable', 'unavailable'],
    ['unsupported', 'unsupported', 'unavailable'],
  ] as const)('stays selectable after "%s", so granting access later works without a restart', async (reason, cause, micState) => {
    const { controller, webview, handled } = webviewOnly();
    webview.availability = { ok: false, reason };

    const first = await controller.initialize(webviewCaps);

    expect(first).toMatchObject({ phase: 'unavailable', cause, micState, webviewUnreliable: false, kind: null });
    expect(first.text).toContain('You can keep typing.');

    webview.availability = { ok: true }; // access granted; same controller, no reload
    const second = await controller.initialize(webviewCaps);

    expect(second).toMatchObject({ phase: 'idle', kind: 'webview', webviewUnreliable: false });
    expect(await controller.startListening()).toEqual({ status: 'listening' });
    expect(webview.count('start')).toBe(1);
    expect(handled).toEqual([]); // nothing was routed by asking
  });

  it('a refusal at the start of an attempt keeps push-to-talk usable and asks again on the next press', async () => {
    const { controller, webview } = webviewOnly();
    await controller.initialize(webviewCaps);
    webview.availability = { ok: false, reason: 'denied' };

    expect(await controller.startListening()).toEqual({ status: 'failed', reason: 'not_available' });

    expect(webview.count('start')).toBe(0); // nothing recorded
    expect(controller.status).toMatchObject({ phase: 'idle', kind: 'webview', webviewUnreliable: false, micState: 'denied' });

    webview.availability = { ok: true };
    expect(await controller.startListening()).toEqual({ status: 'listening' });
    expect(webview.count('start')).toBe(1);
  });

  it('still treats a webview that gives no audio as unreliable for the session', async () => {
    const { controller, scheduler } = webviewOnly();
    await controller.initialize(webviewCaps);
    await controller.startListening();

    scheduler.advance(FIRST_SAMPLE_WATCHDOG_MS);

    expect(controller.status).toMatchObject({ phase: 'unavailable', cause: 'webview_unreliable', webviewUnreliable: true });
  });

  it('still falls back for the session when a backend-local input exists', async () => {
    const { controller, webview } = await webviewReadyForFallback();
    webview.availability = { ok: false, reason: 'denied' };

    const status = await controller.initialize(caps());

    expect(status).toMatchObject({ phase: 'idle', kind: 'backend_local', webviewUnreliable: true });
  });

  async function webviewReadyForFallback() {
    const harness = build({ preferred: 'webview' });
    await harness.controller.initialize(caps());
    return harness;
  }
});
