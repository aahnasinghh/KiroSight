/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import { validateWebviewToHostMessage } from '../../src/protocol/bridgeMessages';
import { buildWebviewHtml } from '../../src/webview/html';

/**
 * Task 8.3: the real media/main.js capture code in jsdom, against a fake microphone and a fake
 * MediaRecorder. It proves what the page does with the host's start_capture and stop_capture; it
 * does NOT prove that Kiro's webview is allowed to use a microphone (Spike D found it is not).
 */
const testDirectory = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(resolve(testDirectory, '../../media/main.js'), 'utf8');
const html = buildWebviewHtml({
  cspSource: "'self' https://*.vscode-cdn.net",
  styleUri: 'https://webview.example.invalid/media/styles.css',
  scriptUri: 'https://webview.example.invalid/media/main.js',
  nonce: 'dGVzdC1ub25jZS12YWx1ZQ==',
});

const opened: JSDOM[] = [];

class Track {
  public stopped = 0;
  public stop(): void { this.stopped += 1; }
}

interface Options {
  /** What getUserMedia does: 'granted' resolves, a string rejects with that error name, 'pending' waits. */
  readonly microphone?: 'granted' | 'pending' | string;
  readonly noMediaDevices?: boolean;
  readonly noRecorder?: boolean;
}

function createHarness(options: Options = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  opened.push(dom);
  const { window } = dom;
  const posts: any[] = [];
  const tracks = [new Track()];
  const recorders: any[] = [];
  const getUserMediaCalls: unknown[] = [];
  let grant: (() => void) | undefined;
  const stream = { getTracks: () => tracks };

  (window as any).acquireVsCodeApi = () => ({ postMessage: (message: unknown) => { posts.push(message); } });

  if (!options.noMediaDevices) {
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: (constraints: unknown) => {
          getUserMediaCalls.push(constraints);
          const mode = options.microphone ?? 'granted';
          if (mode === 'granted') return Promise.resolve(stream);
          if (mode === 'pending') return new Promise((resolveStream) => { grant = () => resolveStream(stream); });
          return Promise.reject({ name: mode });
        },
      },
    });
  }

  if (!options.noRecorder) {
    class FakeRecorder {
      public static isTypeSupported(type: string): boolean { return type === 'audio/webm;codecs=opus'; }
      public state = 'inactive';
      public mimeType: string;
      public sliceMs: number | undefined;
      public ondataavailable: ((event: { data: Blob }) => void) | null = null;
      public onstop: (() => void) | null = null;
      public onerror: (() => void) | null = null;
      public constructor(public readonly mediaStream: unknown, init?: { mimeType?: string }) {
        this.mimeType = init?.mimeType ?? 'audio/webm';
        recorders.push(this);
      }
      public start(sliceMs?: number): void { this.state = 'recording'; this.sliceMs = sliceMs; }
      public emit(bytes: number[] | Uint8Array): void {
        this.ondataavailable?.({ data: new window.Blob([new window.Uint8Array(bytes as number[])], { type: this.mimeType }) });
      }
      public stop(): void { this.state = 'inactive'; this.onstop?.(); }
    }
    (window as any).MediaRecorder = FakeRecorder;
  }

  window.eval(mainSource);

  return {
    window,
    posts,
    tracks,
    recorders,
    getUserMediaCalls,
    grant: () => grant?.(),
    deliver: (data: unknown) => { window.dispatchEvent(new window.MessageEvent('message', { data })); },
    clips: () => posts.filter((post) => post.type === 'audio_clip'),
    mics: () => posts.filter((post) => post.type === 'mic_state').map((post) => post.state),
    byId: (id: string) => window.document.getElementById(id) as HTMLElement,
  };
}

type Harness = ReturnType<typeof createHarness>;

async function until(condition: () => boolean, label = 'condition'): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Starts a capture and waits for the recorder to exist. */
async function recording(harness: Harness) {
  harness.deliver({ type: 'start_capture' });
  await until(() => harness.recorders.length > 0 && harness.recorders[0].state === 'recording', 'recording');
  return harness.recorders[0];
}

const bytesOf = (post: any): number[] => [...Buffer.from(post.base64, 'base64')];

afterEach(() => {
  while (opened.length > 0) opened.pop()?.window.close();
});

describe('the page never records on its own', () => {
  it('does nothing at load: no microphone request, no mic_state, no audio', async () => {
    const harness = createHarness();
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));

    expect(harness.getUserMediaCalls).toEqual([]);
    expect(harness.recorders).toEqual([]);
    expect(harness.posts.map((post) => post.type)).toEqual(['ready']);
  });

  it('ignores typing, push-to-talk clicks and Escape: only the host starts a capture', async () => {
    const harness = createHarness();
    harness.byId('ptt').setAttribute('aria-disabled', 'false');
    harness.byId('ptt').click();
    harness.window.document.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));

    expect(harness.getUserMediaCalls).toEqual([]);
    expect(harness.posts.map((post) => post.type)).toEqual(['ready', 'ptt_toggle', 'interrupt']);
  });
});

describe('start_capture', () => {
  it('asks for the microphone once, reports granted, and starts a recorder with a 1 s slice', async () => {
    const harness = createHarness();

    const recorder = await recording(harness);

    expect(harness.getUserMediaCalls).toEqual([{ audio: true }]);
    expect(harness.mics()).toEqual(['granted']);
    expect(recorder.sliceMs).toBe(1000);
    expect(recorder.mimeType).toBe('audio/webm;codecs=opus');
  });

  it('ignores a repeated start_capture while recording', async () => {
    const harness = createHarness();
    await recording(harness);

    harness.deliver({ type: 'start_capture' });
    harness.deliver({ type: 'start_capture' });
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));

    expect(harness.getUserMediaCalls).toHaveLength(1);
    expect(harness.recorders).toHaveLength(1);
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'unavailable'],
    ['NotReadableError', 'unavailable'],
    ['SomethingElse', 'unavailable'],
  ])('reports %s as %s and records nothing', async (name, state) => {
    const harness = createHarness({ microphone: name });

    harness.deliver({ type: 'start_capture' });
    await until(() => harness.mics().length > 0, 'mic_state');

    expect(harness.mics()).toEqual([state]);
    expect(harness.recorders).toEqual([]);
    expect(harness.clips()).toEqual([]);
  });

  it.each([
    ['no microphone API', { noMediaDevices: true }],
    ['no MediaRecorder', { noRecorder: true }],
  ])('reports unavailable when there is %s', async (_label, options) => {
    const harness = createHarness(options);
    harness.deliver({ type: 'start_capture' });
    await until(() => harness.mics().length > 0, 'mic_state');
    expect(harness.mics()).toEqual(['unavailable']);
  });

  it('can try again after a refusal', async () => {
    const harness = createHarness({ microphone: 'NotAllowedError' });
    harness.deliver({ type: 'start_capture' });
    await until(() => harness.mics().length === 1);
    harness.deliver({ type: 'start_capture' });
    await until(() => harness.mics().length === 2);
    expect(harness.getUserMediaCalls).toHaveLength(2);
  });
});

describe('recording and posting', () => {
  it('posts every slice as an ordered audio_clip chunk and ends with an empty final marker', async () => {
    const harness = createHarness();
    const recorder = await recording(harness);

    recorder.emit([1, 2, 3, 4, 5]);
    recorder.emit([6, 7, 8]);
    harness.deliver({ type: 'stop_capture' });
    await until(() => harness.clips().length === 3, 'three chunks');

    const chunks = harness.clips();
    expect(chunks.map((chunk) => [chunk.seq, chunk.final])).toEqual([[0, false], [1, false], [2, true]]);
    expect(new Set(chunks.map((chunk) => chunk.clipId)).size).toBe(1);
    expect(chunks.every((chunk) => chunk.mimeType === 'audio/webm;codecs=opus')).toBe(true);
    expect(bytesOf(chunks[0])).toEqual([1, 2, 3, 4, 5]);
    expect(bytesOf(chunks[1])).toEqual([6, 7, 8]);
    expect(chunks[2].base64).toBe('');
  });

  it('posts messages the bridge validator accepts', async () => {
    const harness = createHarness();
    const recorder = await recording(harness);
    recorder.emit([1, 2, 3]);
    harness.deliver({ type: 'stop_capture' });
    await until(() => harness.clips().length === 2);

    for (const post of harness.posts) {
      expect(validateWebviewToHostMessage(post).ok, JSON.stringify(post).slice(0, 80)).toBe(true);
    }
  });

  it('splits a large slice into chunks under 1 MB of base64, in order, without losing a byte', async () => {
    const harness = createHarness();
    const recorder = await recording(harness);
    const big = new Uint8Array(1_500_000).map((_, index) => index % 251);

    recorder.emit(big);
    harness.deliver({ type: 'stop_capture' });
    await until(() => harness.clips().some((chunk) => chunk.final === true), 'final marker');

    const chunks = harness.clips();
    expect(chunks.length).toBeGreaterThanOrEqual(4); // three data chunks and the marker
    expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_, index) => index));
    expect(chunks.every((chunk) => chunk.base64.length <= 1_000_000)).toBe(true);
    expect(chunks.filter((chunk) => chunk.final)).toHaveLength(1);
    const joined = chunks.flatMap(bytesOf);
    expect(joined).toHaveLength(big.length);
    expect(joined.slice(0, 1000)).toEqual([...big.slice(0, 1000)]);
    expect(joined.slice(-1000)).toEqual([...big.slice(-1000)]);
  });

  it('skips empty slices', async () => {
    const harness = createHarness();
    const recorder = await recording(harness);
    recorder.ondataavailable({ data: new harness.window.Blob([]) });
    harness.deliver({ type: 'stop_capture' });
    await until(() => harness.clips().length === 1);
    expect(harness.clips()[0].final).toBe(true);
  });

  it('numbers a second capture separately', async () => {
    const harness = createHarness();
    const first = await recording(harness);
    first.emit([1]);
    harness.deliver({ type: 'stop_capture' });
    await until(() => harness.clips().some((chunk) => chunk.final));
    harness.recorders.length = 0;

    const second = await recording(harness);
    second.emit([2]);
    harness.deliver({ type: 'stop_capture' });
    await until(() => harness.clips().filter((chunk) => chunk.final).length === 2);

    const ids = harness.clips().map((chunk) => chunk.clipId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('stopping releases the microphone', () => {
  it('stops the recorder and every track on stop_capture', async () => {
    const harness = createHarness();
    await recording(harness);

    harness.deliver({ type: 'stop_capture' });
    await until(() => harness.clips().length === 1);

    expect(harness.recorders[0].state).toBe('inactive');
    expect(harness.tracks[0].stopped).toBe(1);
  });

  it('does nothing for a stop_capture when not recording, and for a repeated one', async () => {
    const harness = createHarness();
    harness.deliver({ type: 'stop_capture' });
    await recording(harness);
    harness.deliver({ type: 'stop_capture' });
    harness.deliver({ type: 'stop_capture' });
    await until(() => harness.clips().length === 1);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));

    expect(harness.clips()).toHaveLength(1);
    expect(harness.tracks[0].stopped).toBe(1);
  });

  it('records nothing and releases the stream when stop_capture arrives during the permission prompt', async () => {
    const harness = createHarness({ microphone: 'pending' });
    harness.deliver({ type: 'start_capture' });
    await until(() => harness.getUserMediaCalls.length === 1);

    harness.deliver({ type: 'stop_capture' });
    harness.grant();
    await until(() => harness.clips().length === 1, 'final marker');

    expect(harness.recorders).toEqual([]);
    expect(harness.tracks[0].stopped).toBe(1);
    expect(harness.clips()[0]).toMatchObject({ base64: '', final: true });
    expect(harness.mics()).toEqual([]); // never reported granted: nothing was recorded
  });

  it('releases the microphone when the page is hidden or closed', async () => {
    const harness = createHarness();
    await recording(harness);

    harness.window.dispatchEvent(new harness.window.Event('pagehide'));
    await until(() => harness.clips().length === 1);

    expect(harness.tracks[0].stopped).toBeGreaterThanOrEqual(1);
    expect(harness.recorders[0].state).toBe('inactive');
  });

  it('stops and reports unavailable if the recorder fails', async () => {
    const harness = createHarness();
    const recorder = await recording(harness);

    recorder.onerror();
    await until(() => harness.clips().length === 1);

    expect(harness.mics()).toEqual(['granted', 'unavailable']);
    expect(harness.tracks[0].stopped).toBe(1);
  });
});

describe('typed input and the existing page are unaffected', () => {
  it('still submits typed text and keeps push-to-talk focusable and aria-disabled without voice', async () => {
    const harness = createHarness();
    const input = harness.byId('input') as HTMLInputElement;
    input.value = 'where am I';

    harness.byId('cmd').dispatchEvent(new harness.window.Event('submit', { bubbles: true, cancelable: true }));

    expect(harness.posts.at(-1)).toMatchObject({ type: 'submit_text', text: 'where am I' });
    expect(harness.byId('ptt').getAttribute('aria-disabled')).toBe('true');
    expect(harness.byId('ptt').hasAttribute('disabled')).toBe(false);
  });

  it('ignores unknown host messages', async () => {
    const harness = createHarness();
    harness.deliver({ type: 'start_capture_now' });
    harness.deliver({ type: 'record' });
    harness.deliver(null);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(harness.getUserMediaCalls).toEqual([]);
  });
});
