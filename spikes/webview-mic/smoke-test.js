'use strict';

/**
 * Offline checks for the Spike D harness (Task 8.1). Plain Node, no dependencies, no microphone,
 * no Kiro, no network. They prove the harness judges an attempt correctly; they do NOT prove that
 * a Kiro webview can capture audio. That needs a person with a microphone running the command in
 * Kiro (see docs/spike-results.md).
 *
 *   node smoke-test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { FIRST_SAMPLE_BUDGET_MS, decodeBase64, evaluate, sniffContainer } = require('./evaluate');
const { CaptureSession, MAX_CLIP_BASE64_CHARS } = require('./session');
const { buildHtml } = require('./page');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const filler = Buffer.alloc(64, 7);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), filler]);
const OGG = Buffer.concat([Buffer.from('OggS'), filler]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), filler]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE'), filler]);
const goodAttempt = () => ({
  micState: 'granted', firstSampleElapsedMs: 300, firstSampleBytes: 1200, clipBase64: WEBM.toString('base64'),
});

// --- evaluate -----------------------------------------------------------------------------------

check('a granted mic, an early non-empty sample and a real container PASS, pending a listen', () => {
  const result = evaluate(goodAttempt());
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.container, 'webm');
  assert.equal(result.clipBytes, WEBM.length);
  assert.equal(result.playbackNeedsHumanConfirmation, true);
});

check('the first-sample budget is 5000 ms, inclusive', () => {
  assert.equal(FIRST_SAMPLE_BUDGET_MS, 5000);
  assert.equal(evaluate({ ...goodAttempt(), firstSampleElapsedMs: 5000 }).verdict, 'PASS');
  assert.equal(evaluate({ ...goodAttempt(), firstSampleElapsedMs: 5001 }).verdict, 'FALLBACK');
  assert.equal(evaluate({ ...goodAttempt(), firstSampleElapsedMs: 0 }).verdict, 'PASS');
});

check('every container the recorder may produce is recognised, and text or noise is not', () => {
  assert.equal(sniffContainer(WEBM), 'webm');
  assert.equal(sniffContainer(OGG), 'ogg');
  assert.equal(sniffContainer(MP4), 'mp4');
  assert.equal(sniffContainer(WAV), 'wav');
  assert.equal(sniffContainer(Buffer.from('this is not audio at all')), null);
  assert.equal(sniffContainer(Buffer.alloc(0)), null);
  assert.equal(sniffContainer(Buffer.from([0x1a, 0x45])), null);
});

check('denied, unavailable and never-granted microphones FALLBACK with a stated reason', () => {
  for (const [micState, text] of [
    ['denied', 'denied'], ['unavailable', 'unavailable'], ['prompt', 'never granted'], ['weird', 'unavailable'],
  ]) {
    const result = evaluate({ ...goodAttempt(), micState });
    assert.equal(result.verdict, 'FALLBACK', micState);
    assert.ok(result.reasons.some((reason) => reason.includes(text)), `${micState}: ${result.reasons}`);
  }
});

check('a missing, negative or non-numeric first-sample time is a FALLBACK', () => {
  for (const firstSampleElapsedMs of [null, undefined, -1, Number.NaN, Infinity, '300']) {
    assert.equal(evaluate({ ...goodAttempt(), firstSampleElapsedMs }).verdict, 'FALLBACK', String(firstSampleElapsedMs));
  }
});

check('a zero-length first sample is a FALLBACK', () => {
  for (const firstSampleBytes of [0, null, undefined, -5]) {
    assert.equal(evaluate({ ...goodAttempt(), firstSampleBytes }).verdict, 'FALLBACK', String(firstSampleBytes));
  }
});

check('a missing, empty, malformed or non-audio final clip is a FALLBACK', () => {
  const notAudio = Buffer.from('plain text pretending to be audio').toString('base64');
  for (const clipBase64 of [undefined, null, '', 'abc', 'not base64!!', '====', notAudio, 42]) {
    assert.equal(evaluate({ ...goodAttempt(), clipBase64 }).verdict, 'FALLBACK', String(clipBase64));
  }
});

check('strict base64 decoding', () => {
  assert.deepEqual([...decodeBase64('AQID')], [1, 2, 3]);
  assert.equal(decodeBase64('AQI'), null);
  assert.equal(decodeBase64('AQI*'), null);
  assert.equal(decodeBase64(''), null);
  assert.equal(decodeBase64(undefined), null);
});

// --- session (the host clock and message gate) ----------------------------------------------------

function sessionWithClock() {
  let time = 1000;
  const session = new CaptureSession(() => time);
  return { session, advance: (ms) => { time += ms; } };
}

check('a normal attempt is judged on host-clock timestamps', () => {
  const { session, advance } = sessionWithClock();
  assert.equal(session.handle({ type: 'mic_state', state: 'granted' }), null);
  assert.equal(session.handle({ type: 'capture_start' }), null);
  advance(400);
  assert.equal(session.handle({ type: 'first_sample', bytes: 900 }), null);
  advance(3600);
  const result = session.handle({ type: 'audio_clip', mimeType: 'audio/webm', base64: WEBM.toString('base64') });
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.micState, 'granted');
  assert.equal(result.mimeType, 'audio/webm');
});

check('a first sample that arrives late on the host clock FALLBACKs, whatever the webview claims', () => {
  const { session, advance } = sessionWithClock();
  session.handle({ type: 'mic_state', state: 'granted' });
  session.handle({ type: 'capture_start' });
  advance(6200);
  session.handle({ type: 'first_sample', bytes: 900, elapsedMs: 10 });
  const result = session.handle({ type: 'audio_clip', mimeType: 'audio/webm', base64: WEBM.toString('base64') });
  assert.equal(result.verdict, 'FALLBACK');
});

check('a sample before capture_start does not count', () => {
  const { session } = sessionWithClock();
  session.handle({ type: 'mic_state', state: 'granted' });
  session.handle({ type: 'first_sample', bytes: 900 });
  const result = session.handle({ type: 'audio_clip', mimeType: 'audio/webm', base64: WEBM.toString('base64') });
  assert.equal(result.verdict, 'FALLBACK');
});

check('only the first sample is timed, and granted is not downgraded by a stale prompt report', () => {
  const { session, advance } = sessionWithClock();
  session.handle({ type: 'mic_state', state: 'granted' });
  session.handle({ type: 'capture_start' });
  advance(100);
  session.handle({ type: 'first_sample', bytes: 10 });
  advance(9000);
  session.handle({ type: 'first_sample', bytes: 10 });
  session.handle({ type: 'mic_state', state: 'prompt' });
  const result = session.handle({ type: 'audio_clip', mimeType: 'audio/webm', base64: WEBM.toString('base64') });
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.micState, 'granted');
});

check('denied overrides granted', () => {
  const { session } = sessionWithClock();
  session.handle({ type: 'mic_state', state: 'granted' });
  session.handle({ type: 'mic_state', state: 'denied' });
  session.handle({ type: 'capture_start' });
  session.handle({ type: 'first_sample', bytes: 10 });
  assert.equal(session.handle({ type: 'audio_clip', base64: WEBM.toString('base64') }).verdict, 'FALLBACK');
});

check('unknown or malformed messages are ignored and counted, never acted on', () => {
  const { session } = sessionWithClock();
  for (const message of [null, undefined, 'x', 5, [], {}, { type: 'run_command', command: 'calc' }, { type: 'AUDIO_CLIP' }]) {
    assert.equal(session.handle(message), null);
  }
  assert.equal(session.ignored, 8);
});

check('an oversized clip is refused', () => {
  const { session } = sessionWithClock();
  session.handle({ type: 'mic_state', state: 'granted' });
  session.handle({ type: 'capture_start' });
  session.handle({ type: 'first_sample', bytes: 10 });
  const result = session.handle({ type: 'audio_clip', base64: 'A'.repeat(MAX_CLIP_BASE64_CHARS + 4) });
  assert.equal(result.verdict, 'FALLBACK');
  assert.equal(result.clipBytes, 0);
});

// --- the webview page -----------------------------------------------------------------------------

check('the page has a locked-down CSP, a keyboard-operable button and a live status', () => {
  const html = buildHtml('NONCE123');
  assert.match(html, /Content-Security-Policy[^>]*default-src 'none'/);
  assert.match(html, /script-src 'nonce-NONCE123'/);
  assert.doesNotMatch(html, /connect-src|http:|https:|ws:|wss:/);
  assert.match(html, /<button id="record" type="button">/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /<script nonce="NONCE123">/);
});

check('the webview script compiles, opens no network connection and holds no secret', () => {
  const source = fs.readFileSync(path.join(__dirname, 'capture-script.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(source));
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|eval\(/);
  assert.doesNotMatch(source, /api[_-]?key|token|secret|password|Bearer/i);
  // The microphone is requested only inside the click handler's path, never on load.
  assert.equal(source.match(/getUserMedia\(/g).length, 1);
  assert.match(source, /button\.addEventListener\('click'/);
});

// --- the extension entry point, with a fake vscode ---------------------------------------------------

check('the command opens a script-enabled panel and judges the messages it receives', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.contributes.commands.map((c) => c.command), ['kirosight.micSpike']);

  const lines = [];
  const messages = [];
  const shown = [];
  let registered;
  let panelOptions;
  let html = '';
  let listener = () => undefined;
  const fakeVscode = {
    ViewColumn: { Active: -1 },
    window: {
      createOutputChannel: () => ({ appendLine: (line) => lines.push(line), show: () => undefined, dispose: () => undefined }),
      createWebviewPanel: (_id, _title, _column, options) => {
        panelOptions = options;
        return {
          webview: {
            set html(value) { html = value; },
            onDidReceiveMessage: (fn) => { listener = fn; return { dispose: () => undefined }; },
          },
        };
      },
      showInformationMessage: (text) => { shown.push(text); return Promise.resolve(); },
    },
    commands: { registerCommand: (id, fn) => { registered = { id, fn }; return { dispose: () => undefined }; } },
  };
  const originalLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    return request === 'vscode' ? fakeVscode : originalLoad.call(this, request, ...rest);
  };
  let savedPath;
  try {
    const extension = require('./extension');
    extension.activate({ subscriptions: [] });
    assert.equal(registered.id, 'kirosight.micSpike');
    registered.fn();
    assert.equal(panelOptions.enableScripts, true);
    assert.match(html, /<button id="record"/);

    for (const message of [
      { type: 'mic_state', state: 'granted' }, { type: 'capture_start' }, { type: 'first_sample', bytes: 500 },
      { type: 'audio_clip', mimeType: 'audio/webm', base64: WEBM.toString('base64'), durationMs: 4000 },
    ]) {
      messages.push(message);
      listener(message);
    }
    assert.ok(lines.includes('Spike D verdict: PASS'), lines.join('\n'));
    const saved = lines.find((line) => line.includes('saved to'));
    assert.ok(saved, 'the clip is saved for playback');
    savedPath = saved.match(/saved to (.+?): play it/)[1];
    assert.ok(savedPath.startsWith(os.tmpdir()));
    assert.deepEqual(fs.readFileSync(savedPath), WEBM);
    assert.match(shown[0], /Spike D: PASS/);
  } finally {
    Module._load = originalLoad;
    if (savedPath !== undefined && fs.existsSync(savedPath)) fs.unlinkSync(savedPath); // only the file this test wrote
  }
});

console.log(`\n${passed} checks passed.`);
