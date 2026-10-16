/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import { validateWebviewToHostMessage } from '../../src/protocol/bridgeMessages';
import { buildWebviewHtml } from '../../src/webview/html';

/**
 * Task 9.4: the real media/main.js playback code in jsdom, against a fake audio element and fake
 * object URLs. It proves what the page does with play_audio, stop_audio and Escape, and which
 * playback states it reports. It does NOT prove that sound comes out of a speaker, and it does not
 * prove how Kiro's webview treats blob: media; both need a manual check.
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

type PlayMode = 'pending' | 'resolve' | 'reject';

interface Options {
  /** What play() does: resolve (without any "playing" event), reject, or stay pending. */
  readonly play?: PlayMode;
  /** Per audio element, in creation order: overrides `play` for the elements it covers. */
  readonly playModes?: readonly PlayMode[];
  /** Leave window.URL.createObjectURL undefined, as if object URLs were unavailable. */
  readonly noObjectUrl?: boolean;
  /** createObjectURL exists but throws. */
  readonly objectUrlThrows?: boolean;
  /** No window.Audio at all. */
  readonly noAudio?: boolean;
}

class FakeAudio {
  public src = '';
  public playCalls = 0;
  public pauseCalls = 0;
  public loadCalls = 0;
  public srcRemoved = false;
  /** Mirrors HTMLMediaElement.ended: true once the clip played to its end. */
  public ended = false;
  public resolvePlay: (() => void) | undefined;
  public rejectPlay: ((error: Error) => void) | undefined;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  public constructor(private readonly mode: PlayMode) {}

  public addEventListener(type: string, handler: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  public removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  public play(): Promise<void> {
    this.playCalls += 1;
    if (this.mode === 'resolve') return Promise.resolve();
    if (this.mode === 'reject') return Promise.reject(new Error('NotAllowedError'));
    return new Promise<void>((resolveFn, rejectFn) => {
      this.resolvePlay = resolveFn;
      this.rejectPlay = rejectFn;
    });
  }

  public pause(): void { this.pauseCalls += 1; }
  public load(): void { this.loadCalls += 1; }

  public removeAttribute(name: string): void {
    if (name === 'src') {
      this.src = '';
      this.srcRemoved = true;
    }
  }

  /** Delivers an element event as the browser would, to whichever listeners are still attached. */
  public emit(type: string): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler({ type });
  }

  public get listenerCount(): number {
    return [...this.listeners.values()].reduce((total, set) => total + set.size, 0);
  }
}

function createHarness(options: Options = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  opened.push(dom);
  const { window } = dom;
  const posts: any[] = [];
  const audios: FakeAudio[] = [];
  const created: Array<{ url: string; blob: Blob }> = [];
  const revoked: string[] = [];

  (window as any).acquireVsCodeApi = () => ({ postMessage: (message: unknown) => { posts.push(message); } });

  if (!options.noAudio) {
    (window as any).Audio = function Audio() {
      const audio = new FakeAudio(options.playModes?.[audios.length] ?? options.play ?? 'pending');
      audios.push(audio);
      return audio;
    };
  } else {
    (window as any).Audio = undefined;
  }

  if (options.noObjectUrl) {
    (window.URL as any).createObjectURL = undefined;
  } else if (options.objectUrlThrows) {
    (window.URL as any).createObjectURL = () => { throw new Error('object URLs are blocked'); };
  } else {
    (window.URL as any).createObjectURL = (blob: Blob) => {
      const url = `blob:fake/${created.length + 1}`;
      created.push({ url, blob });
      return url;
    };
  }
  (window.URL as any).revokeObjectURL = (url: string) => { revoked.push(url); };

  window.eval(mainSource);

  return {
    window,
    posts,
    audios,
    created,
    revoked,
    deliver: (data: unknown) => { window.dispatchEvent(new window.MessageEvent('message', { data })); },
    key: (key: string) => {
      const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      window.document.dispatchEvent(event);
      return event;
    },
    playbacks: () => posts.filter((post) => post.type === 'playback').map((post) => `${post.state}:${post.id}`),
    states: () => posts.filter((post) => post.type === 'playback').map((post) => post.state),
    byId: (id: string) => window.document.getElementById(id) as HTMLElement,
    status: () => (window.document.getElementById('status') as HTMLElement).textContent,
  };
}

type Harness = ReturnType<typeof createHarness>;

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64');
const clip = (id = 'speech-1', over: Record<string, unknown> = {}) => ({
  type: 'play_audio', id, mimeType: 'audio/mpeg', base64: b64([1, 2, 3, 4, 5, 6]), ...over,
});

const tick = (): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, 0));

async function readBlob(window: Window, blob: Blob): Promise<number[]> {
  return new Promise((resolveRead, rejectRead) => {
    const reader = new (window as any).FileReader();
    reader.onload = () => resolveRead([...new Uint8Array(reader.result as ArrayBuffer)]);
    reader.onerror = () => rejectRead(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Plays a clip all the way to "started" and returns its audio element. */
async function startedClip(harness: Harness, id = 'speech-1'): Promise<FakeAudio> {
  harness.deliver(clip(id));
  const audio = harness.audios.at(-1)!;
  audio.emit('playing');
  await tick();
  return audio;
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.window.close();
});

describe('play_audio: a valid clip', () => {
  it('creates one audio element from a blob: URL of the decoded bytes, keeping the MIME type', async () => {
    const harness = createHarness();

    harness.deliver(clip('speech-4', { mimeType: 'audio/wav' }));

    expect(harness.audios).toHaveLength(1);
    expect(harness.created).toHaveLength(1);
    expect(harness.audios[0]!.src).toBe(harness.created[0]!.url);
    expect(harness.audios[0]!.playCalls).toBe(1);
    expect(harness.created[0]!.blob.type).toBe('audio/wav');
    expect(await readBlob(harness.window as never, harness.created[0]!.blob)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('reports nothing until the element really plays: play() being called or resolving is not "started"', async () => {
    const harness = createHarness({ play: 'resolve' });

    harness.deliver(clip());
    await tick();
    await tick();

    expect(harness.audios[0]!.playCalls).toBe(1);
    expect(harness.playbacks()).toEqual([]);
    expect(harness.status()).not.toContain('Speaking');
  });

  it('reports started, with the same id, only when the element fires "playing"', async () => {
    const harness = createHarness();
    harness.deliver(clip('speech-7'));

    harness.audios[0]!.emit('playing');

    expect(harness.playbacks()).toEqual(['started:speech-7']);
    expect(harness.status()).toContain('Speaking');
  });

  it('reports ended after started, then releases everything', async () => {
    const harness = createHarness();
    const audio = await startedClip(harness, 'speech-7');

    audio.emit('ended');

    expect(harness.playbacks()).toEqual(['started:speech-7', 'ended:speech-7']);
    expect(harness.status()).not.toContain('Speaking');
    expect(harness.revoked).toEqual([harness.created[0]!.url]);
    expect(audio.listenerCount).toBe(0);
    expect(audio.srcRemoved).toBe(true);
    expect(audio.pauseCalls).toBeGreaterThan(0);
    expect(audio.loadCalls).toBeGreaterThan(0);
  });

  it('posts only playback messages the bridge validator accepts', async () => {
    const harness = createHarness();
    const audio = await startedClip(harness);
    audio.emit('ended');

    const playbackPosts = harness.posts.filter((post) => post.type === 'playback');
    expect(playbackPosts).toHaveLength(2);
    for (const post of playbackPosts) expect(validateWebviewToHostMessage(post).ok).toBe(true);
  });

  it('plays a large clip without trouble', async () => {
    const harness = createHarness();
    const bytes = new Array(300_000).fill(7);

    harness.deliver(clip('big', { base64: b64(bytes) }));

    expect(harness.created[0]!.blob.size).toBe(300_000);
  });
});

describe('blob: and data: sources', () => {
  it('uses a data: URL when object URLs are unavailable', () => {
    const harness = createHarness({ noObjectUrl: true });

    harness.deliver(clip('speech-1', { mimeType: 'audio/ogg', base64: b64([9, 8, 7]) }));

    expect(harness.created).toEqual([]);
    expect(harness.audios[0]!.src).toBe(`data:audio/ogg;base64,${b64([9, 8, 7])}`);
  });

  it('uses a data: URL when creating an object URL throws, and revokes nothing', () => {
    const harness = createHarness({ objectUrlThrows: true });

    harness.deliver(clip());

    expect(harness.audios[0]!.src.startsWith('data:audio/mpeg;base64,')).toBe(true);
    expect(harness.revoked).toEqual([]);
  });

  it('falls back to the data: URL once if the blob: URL fails to load, and then plays', async () => {
    const harness = createHarness();
    harness.deliver(clip('speech-2'));
    const first = harness.audios[0]!;

    first.emit('error');

    expect(harness.audios).toHaveLength(2);
    expect(harness.audios[1]!.src.startsWith('data:audio/mpeg;base64,')).toBe(true);
    expect(harness.revoked).toEqual([harness.created[0]!.url]); // the failed blob: URL was released
    expect(first.listenerCount).toBe(0);
    expect(harness.playbacks()).toEqual([]); // not a failure yet

    harness.audios[1]!.emit('playing');
    expect(harness.playbacks()).toEqual(['started:speech-2']);
  });

  it('fails once the data: fallback fails too', () => {
    const harness = createHarness();
    harness.deliver(clip('speech-2'));
    harness.audios[0]!.emit('error');

    harness.audios[1]!.emit('error');

    expect(harness.playbacks()).toEqual(['failed:speech-2']);
    expect(harness.audios).toHaveLength(2);
  });
});

describe('playback failures', () => {
  it('a rejected play() fails the clip once, after trying the data: URL, with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      const harness = createHarness({ play: 'reject' });

      harness.deliver(clip('speech-3'));
      await tick();
      await tick();

      expect(harness.audios).toHaveLength(2); // blob: then data:
      expect(harness.playbacks()).toEqual(['failed:speech-3']);
      expect(harness.status()).not.toContain('Speaking');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('a rejected play() on a data: source fails immediately, once', async () => {
    const harness = createHarness({ play: 'reject', noObjectUrl: true });

    harness.deliver(clip('speech-3'));
    await tick();

    expect(harness.audios).toHaveLength(1);
    expect(harness.playbacks()).toEqual(['failed:speech-3']);
  });

  it('an audio error after playback started is a failure, reported once', async () => {
    const harness = createHarness();
    const audio = await startedClip(harness, 'speech-5');

    audio.emit('error');
    audio.emit('error');

    expect(harness.playbacks()).toEqual(['started:speech-5', 'failed:speech-5']);
    expect(harness.status()).not.toContain('Speaking');
    expect(harness.revoked).toEqual([harness.created[0]!.url]);
  });

  it('a clip that ends without ever playing is a failure, not a success', async () => {
    const harness = createHarness();
    harness.deliver(clip('speech-6'));

    harness.audios[0]!.emit('ended');

    expect(harness.playbacks()).toEqual(['failed:speech-6']);
  });

  it('reports failed when the browser has no audio support', () => {
    const harness = createHarness({ noAudio: true });

    harness.deliver(clip('speech-8'));

    expect(harness.playbacks()).toEqual(['failed:speech-8']);
    expect(harness.created).toEqual([]);
  });

  it('reports failed when the audio element cannot be created', () => {
    const harness = createHarness();
    (harness.window as any).Audio = function Audio() { throw new Error('no audio'); };

    harness.deliver(clip('speech-9'));

    expect(harness.playbacks()).toEqual(['failed:speech-9']);
    expect(harness.revoked).toEqual([harness.created[0]!.url]);
  });

  it('ignores a play() refusal that arrives after the clip was stopped', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      const harness = createHarness({ play: 'pending' });
      harness.deliver(clip('speech-1'));
      const audio = harness.audios[0]!;
      harness.deliver({ type: 'stop_audio' });

      audio.rejectPlay?.(new Error('AbortError'));
      await tick();
      await tick();

      expect(harness.playbacks()).toEqual([]);
      expect(harness.audios).toHaveLength(1); // no data: retry was started for a stopped clip
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('invalid or unsupported payloads', () => {
  it.each([
    ['a non-audio MIME type', { mimeType: 'text/plain' }],
    ['an empty audio subtype', { mimeType: 'audio/' }],
    ['MIME parameters', { mimeType: 'audio/mpeg; codecs=x' }],
    ['a MIME type that could break a data: URL', { mimeType: 'audio/mpeg;base64,x' }],
    ['an empty MIME type', { mimeType: '' }],
    ['a non-string MIME type', { mimeType: 5 }],
    ['empty audio', { base64: '' }],
    ['non-base64 characters', { base64: 'AB!D' }],
    ['a length that is not a multiple of 4', { base64: 'ABC' }],
    ['padding in the middle', { base64: 'AB==AAAA' }],
    ['non-string data', { base64: 12345678 }],
    ['an oversized payload', { base64: 'A'.repeat(6_000_004) }],
  ])('reports failed for %s, without creating audio or a URL', (_label, over) => {
    const harness = createHarness();

    harness.deliver(clip('speech-1', over));

    expect(harness.playbacks()).toEqual(['failed:speech-1']);
    expect(harness.audios).toEqual([]);
    expect(harness.created).toEqual([]);
    expect(harness.status()).not.toContain('Speaking');
  });

  it.each([
    ['a missing id', { id: undefined }],
    ['an empty id', { id: '' }],
    ['a non-string id', { id: 5 }],
  ])('drops a message with %s: nothing can be correlated, so nothing is played or reported', (_label, over) => {
    const harness = createHarness();

    harness.deliver(clip('x', over));

    expect(harness.posts.filter((post) => post.type === 'playback')).toEqual([]);
    expect(harness.audios).toEqual([]);
  });

  it('does not interrupt a playing clip because a later one is invalid', async () => {
    const harness = createHarness();
    const audio = await startedClip(harness, 'speech-1');

    harness.deliver(clip('speech-2', { mimeType: 'video/mp4' }));

    expect(harness.playbacks()).toEqual(['started:speech-1', 'failed:speech-2']);
    expect(audio.srcRemoved).toBe(false);
    expect(harness.status()).toContain('Speaking');
  });
});

describe('stop_audio', () => {
  it('stops a playing clip: reports ended once, clears Speaking, and releases everything', async () => {
    const harness = createHarness();
    const audio = await startedClip(harness, 'speech-1');

    harness.deliver({ type: 'stop_audio' });

    expect(harness.playbacks()).toEqual(['started:speech-1', 'ended:speech-1']);
    expect(harness.status()).not.toContain('Speaking');
    expect(audio.pauseCalls).toBeGreaterThan(0);
    expect(audio.srcRemoved).toBe(true);
    expect(audio.listenerCount).toBe(0);
    expect(harness.revoked).toEqual([harness.created[0]!.url]);
  });

  it('late events from a stopped clip cannot restart it or report it again', async () => {
    const harness = createHarness();
    const audio = await startedClip(harness, 'speech-1');
    harness.deliver({ type: 'stop_audio' });
    const before = [...harness.posts];

    audio.emit('playing');
    audio.emit('ended');
    audio.emit('error');
    await tick();

    expect(harness.posts).toEqual(before);
    expect(harness.status()).not.toContain('Speaking');
    expect(harness.audios).toHaveLength(1);
  });

  it('stopping a clip that never started reports nothing, and its late "playing" is ignored', async () => {
    const harness = createHarness();
    harness.deliver(clip('speech-1'));
    const audio = harness.audios[0]!;

    harness.deliver({ type: 'stop_audio' });
    audio.emit('playing');

    expect(harness.playbacks()).toEqual([]);
    expect(harness.status()).not.toContain('Speaking');
  });

  it('does nothing when nothing is playing, and a repeated stop reports nothing more', async () => {
    const harness = createHarness();
    harness.deliver({ type: 'stop_audio' });
    expect(harness.posts.map((post) => post.type)).toEqual(['ready']);

    await startedClip(harness);
    harness.deliver({ type: 'stop_audio' });
    harness.deliver({ type: 'stop_audio' });

    expect(harness.states()).toEqual(['started', 'ended']);
  });

  it('a clip that was stopped is not played again if the host repeats it', async () => {
    const harness = createHarness();
    await startedClip(harness, 'speech-1');
    harness.deliver({ type: 'stop_audio' });

    harness.deliver(clip('speech-1'));

    expect(harness.audios).toHaveLength(1);
    expect(harness.states()).toEqual(['started', 'ended']);
  });
});

describe('Escape and other keys', () => {
  it('Escape stops speech first, then posts the usual interrupt', async () => {
    const harness = createHarness();
    await startedClip(harness, 'speech-1');

    harness.key('Escape');

    expect(harness.posts.slice(1).map((post) => post.type === 'playback' ? `playback:${post.state}` : post.type))
      .toEqual(['playback:started', 'playback:ended', 'interrupt']);
    expect(harness.status()).not.toContain('Speaking');
  });

  it('Escape when nothing is playing only posts interrupt', () => {
    const harness = createHarness();

    harness.key('Escape');

    expect(harness.posts.map((post) => post.type)).toEqual(['ready', 'interrupt']);
  });

  it('no other key stops speech, posts anything or is prevented', async () => {
    const harness = createHarness();
    await startedClip(harness, 'speech-1');
    const before = harness.posts.length;

    for (const key of ['a', 'Enter', ' ', 'Tab', 'ArrowDown', 'ArrowUp', 'Home', 'F6', 'Backspace', 'Control']) {
      expect(harness.key(key).defaultPrevented).toBe(false);
    }

    expect(harness.posts).toHaveLength(before);
    expect(harness.status()).toContain('Speaking');
  });
});

describe('the Speaking label', () => {
  it('shows in front of the host status while playing and gives the status back afterwards', async () => {
    const harness = createHarness();
    harness.deliver({ type: 'view_state', status: 'Idle. Backend connected', statusKind: 'idle', transcript: [], latest: null, voice: { state: 'available', reasonText: null }, listening: false });
    expect(harness.status()).toBe('Idle. Backend connected');

    const audio = await startedClip(harness);
    expect(harness.status()).toBe('Speaking. Backend connected');

    audio.emit('ended');
    expect(harness.status()).toBe('Idle. Backend connected');
  });

  it('is just "Speaking" over a bare Idle status, and keeps other host states in text', async () => {
    const harness = createHarness();
    await startedClip(harness);
    expect(harness.status()).toBe('Speaking');

    harness.deliver({ type: 'view_state', status: 'Confirmation pending', statusKind: 'confirmation_pending', transcript: [], latest: null, voice: { state: 'available', reasonText: null }, listening: false });
    expect(harness.status()).toBe('Speaking. Confirmation pending');

    harness.deliver({ type: 'stop_audio' });
    expect(harness.status()).toBe('Confirmation pending');
  });

  it('survives a backend_unavailable message and a refusal message while speaking', async () => {
    const harness = createHarness();
    await startedClip(harness);

    harness.deliver({ type: 'backend_unavailable', kind: 'text', message: 'The backend is not running.' });
    expect(harness.status()).toBe('Speaking. The backend is not running.');

    harness.deliver({ type: 'stop_audio' });
    expect(harness.status()).toBe('The backend is not running.');
  });

  it('is plain text in the polite status region: no color, no hidden node, no focus change', async () => {
    const harness = createHarness();
    const input = harness.byId('input') as HTMLInputElement;
    input.focus();
    input.value = 'my draft';
    const status = harness.byId('status');
    const focusBefore = harness.window.document.activeElement;

    const audio = await startedClip(harness);

    expect(status.getAttribute('role')).toBe('status');
    expect(status.hasAttribute('hidden')).toBe(false);
    expect(status.getAttribute('aria-hidden')).toBeNull();
    expect(status.children).toHaveLength(0);
    expect(status.textContent).toContain('Speaking');
    expect(harness.window.document.activeElement).toBe(focusBefore);
    expect(input.value).toBe('my draft');

    audio.emit('ended');
    expect(harness.window.document.activeElement).toBe(focusBefore);
    expect(input.value).toBe('my draft');
  });

  it('is cleared by every way a clip can end', async () => {
    for (const end of ['ended', 'error', 'stop']) {
      const harness = createHarness();
      const audio = await startedClip(harness);
      expect(harness.status()).toContain('Speaking');

      if (end === 'stop') harness.deliver({ type: 'stop_audio' });
      else audio.emit(end);

      expect(harness.status()).not.toContain('Speaking');
    }
  });

  it('is not shown for a clip that has not really started', () => {
    const harness = createHarness();
    harness.deliver(clip());
    expect(harness.status()).not.toContain('Speaking');
  });
});

describe('duplicates, replacement and correlation', () => {
  it('reports each state once however many times the element repeats an event', async () => {
    const harness = createHarness();
    const audio = harness.audios.length > 0 ? harness.audios[0]! : (harness.deliver(clip('speech-1')), harness.audios[0]!);

    audio.emit('playing');
    audio.emit('playing');
    audio.emit('ended');
    audio.emit('ended');
    audio.emit('error');

    expect(harness.playbacks()).toEqual(['started:speech-1', 'ended:speech-1']);
  });

  it('ignores a repeated play_audio for the clip that is playing, and for one that already finished', async () => {
    const harness = createHarness();
    const audio = await startedClip(harness, 'speech-1');

    harness.deliver(clip('speech-1'));
    expect(harness.audios).toHaveLength(1);

    audio.emit('ended');
    harness.deliver(clip('speech-1'));

    expect(harness.audios).toHaveLength(1);
    expect(harness.states()).toEqual(['started', 'ended']);
  });

  it('a newer clip replaces the current one, which is reported ended, and keeps the ids apart', async () => {
    const harness = createHarness();
    const first = await startedClip(harness, 'speech-1');

    harness.deliver(clip('speech-2'));
    const second = harness.audios[1]!;
    first.emit('ended'); // late event from the replaced clip
    first.emit('playing');
    second.emit('playing');
    second.emit('ended');

    expect(harness.playbacks()).toEqual([
      'started:speech-1', 'ended:speech-1', 'started:speech-2', 'ended:speech-2',
    ]);
    expect(harness.revoked).toEqual([harness.created[0]!.url, harness.created[1]!.url]);
  });

  it('plays a new clip with the same content under a new id', async () => {
    const harness = createHarness();
    const first = await startedClip(harness, 'speech-1');
    first.emit('ended');

    await startedClip(harness, 'speech-2');

    expect(harness.playbacks()).toEqual(['started:speech-1', 'ended:speech-1', 'started:speech-2']);
  });
});

describe('cleanup', () => {
  it('releases a playing clip when the page is hidden, without reporting', async () => {
    const harness = createHarness();
    const audio = await startedClip(harness);
    const before = harness.posts.length;

    harness.window.dispatchEvent(new harness.window.Event('pagehide'));

    expect(audio.listenerCount).toBe(0);
    expect(audio.srcRemoved).toBe(true);
    expect(harness.revoked).toEqual([harness.created[0]!.url]);
    expect(harness.posts).toHaveLength(before);
    expect(harness.status()).not.toContain('Speaking');
  });

  it('keeps no object URL alive after any ending', async () => {
    for (const end of ['ended', 'error', 'stop', 'replace']) {
      const harness = createHarness();
      const audio = await startedClip(harness, 'speech-1');
      if (end === 'ended' || end === 'error') audio.emit(end);
      else if (end === 'stop') harness.deliver({ type: 'stop_audio' });
      else harness.deliver(clip('speech-2'));

      const live = harness.created.filter((entry) => !harness.revoked.includes(entry.url));
      expect(live.length, end).toBe(end === 'replace' ? 1 : 0); // only the newer clip's URL is still in use
      expect(new Set(harness.revoked).size).toBe(harness.revoked.length); // each is revoked once
    }
  });

  it('does not leave unhandled rejections behind across a whole session', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      const harness = createHarness({ play: 'reject' });
      harness.deliver(clip('speech-1'));
      harness.deliver(clip('speech-2'));
      harness.deliver({ type: 'stop_audio' });
      harness.key('Escape');
      await tick();
      await tick();
      await tick();

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('the rest of the page is unaffected', () => {
  it('still submits and clears typed input while speech plays, and push-to-talk stays as it was', async () => {
    const harness = createHarness();
    await startedClip(harness);
    const input = harness.byId('input') as HTMLInputElement;
    input.value = 'where am I';

    harness.byId('cmd').dispatchEvent(new harness.window.Event('submit', { bubbles: true, cancelable: true }));
    const submit = harness.posts.at(-1);
    harness.deliver({ type: 'submit_ack', submitId: submit.submitId, status: 'handled' });

    expect(submit).toMatchObject({ type: 'submit_text', text: 'where am I' });
    expect(input.value).toBe('');
    expect(harness.byId('ptt').getAttribute('aria-disabled')).toBe('true');
    expect(harness.byId('ptt').hasAttribute('disabled')).toBe(false);
    expect(harness.status()).toContain('Speaking');
  });

  it('ignores unknown host messages and a play_audio-like type', () => {
    const harness = createHarness();

    harness.deliver({ type: 'play' });
    harness.deliver({ type: 'play_audio_now', id: 'x', mimeType: 'audio/mpeg', base64: 'AAAA' });
    harness.deliver(null);

    expect(harness.audios).toEqual([]);
    expect(harness.posts.map((post) => post.type)).toEqual(['ready']);
  });

  it('does not write audio anywhere or reach the network', () => {
    expect(mainSource).not.toMatch(/localStorage|sessionStorage|indexedDB|showSaveFilePicker|createWritable|download\s*=|fetch\(|XMLHttpRequest|WebSocket/);
  });
});

describe('the content security policy', () => {
  it('allows audio only from blob: and data:, and nothing else more than before', () => {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';

    expect(csp).toContain('media-src blob: data:;');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-dGVzdC1ub25jZS12YWx1ZQ=='");
    expect(csp).not.toMatch(/connect-src|unsafe-inline|unsafe-eval|media-src[^;]*(https?:|\*)/);
  });
});

/** Records unhandled promise rejections for the duration of one async test body. */
async function withoutUnhandledRejections(body: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    await body();
    await tick();
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', listener);
  }
}

const viewState = (status: string) => ({
  type: 'view_state', status, statusKind: 'idle', transcript: [], latest: null,
  voice: { state: 'available', reasonText: null }, listening: false,
});

describe('the Speaking label keeps words that merely start with "Idle"', () => {
  it.each([
    ['Idle', 'Speaking'],
    ['Idle.', 'Speaking'],
    ['Idle. Backend connected', 'Speaking. Backend connected'],
    ['Status: Idle', 'Speaking'],
    ['Status: Idle. Backend connected', 'Speaking. Backend connected'],
    ['Idleness check', 'Speaking. Idleness check'],
    ['Status: Idleness check', 'Speaking. Status: Idleness check'],
    ['Idle-ish mode', 'Speaking. Idle-ish mode'],
    ['Idle_mode', 'Speaking. Idle_mode'],
    ['Not Idle', 'Speaking. Not Idle'],
  ])('shows %j as %j while speaking, and restores it afterwards', async (hostText, speakingText) => {
    const harness = createHarness();
    harness.deliver(viewState(hostText));
    expect(harness.status()).toBe(hostText);

    const audio = await startedClip(harness);
    expect(harness.status()).toBe(speakingText);

    audio.emit('ended');
    expect(harness.status()).toBe(hostText);
  });
});

describe('edge cases: refused play(), late refusals, early Escape, largest payload', () => {
  it('a refused first play() is retried with the data: URL, which then plays and reports under the same id', async () => {
    await withoutUnhandledRejections(async () => {
      const harness = createHarness({ playModes: ['reject', 'pending'] });

      harness.deliver(clip('speech-12'));
      await tick();
      await tick();

      expect(harness.audios).toHaveLength(2);
      expect(harness.audios[1]!.src).toBe(`data:audio/mpeg;base64,${b64([1, 2, 3, 4, 5, 6])}`);
      expect(harness.playbacks()).toEqual([]); // the refusal alone is not a failure yet
      expect(harness.revoked).toEqual([harness.created[0]!.url]);
      expect(harness.audios[0]!.listenerCount).toBe(0);

      harness.audios[1]!.emit('playing');
      expect(harness.playbacks()).toEqual(['started:speech-12']);
      expect(harness.status()).toContain('Speaking');

      harness.audios[1]!.emit('ended');
      expect(harness.playbacks()).toEqual(['started:speech-12', 'ended:speech-12']);
      expect(harness.status()).not.toContain('Speaking');
      expect(harness.audios[1]!.listenerCount).toBe(0);
      expect(harness.audios[1]!.srcRemoved).toBe(true);
    });
  });

  it('a play() that is refused after playback already started fails the clip once and cleans up', async () => {
    await withoutUnhandledRejections(async () => {
      const harness = createHarness({ play: 'pending' });
      const audio = await startedClip(harness, 'speech-13');

      audio.rejectPlay?.(new Error('lost the audio device'));
      await tick();
      await tick();
      audio.emit('ended'); // late events from the failed clip change nothing
      audio.emit('error');

      expect(harness.playbacks()).toEqual(['started:speech-13', 'failed:speech-13']);
      expect(harness.audios).toHaveLength(1); // a started clip is never retried
      expect(harness.status()).not.toContain('Speaking');
      expect(audio.listenerCount).toBe(0);
      expect(audio.srcRemoved).toBe(true);
      expect(harness.revoked).toEqual([harness.created[0]!.url]);
    });
  });

  it('Escape before "playing" releases the clip, reports no playback state, and still posts interrupt', async () => {
    await withoutUnhandledRejections(async () => {
      const harness = createHarness({ play: 'pending' });
      harness.deliver(clip('speech-14'));
      const audio = harness.audios[0]!;

      harness.key('Escape');
      audio.emit('playing'); // late events from the released clip
      audio.emit('ended');
      audio.rejectPlay?.(new Error('AbortError')); // and a late refusal
      await tick();
      await tick();

      expect(harness.posts.map((post) => post.type)).toEqual(['ready', 'interrupt']);
      expect(harness.playbacks()).toEqual([]);
      expect(harness.status()).not.toContain('Speaking');
      expect(audio.listenerCount).toBe(0);
      expect(audio.srcRemoved).toBe(true);
      expect(audio.pauseCalls).toBeGreaterThan(0);
      expect(harness.revoked).toEqual([harness.created[0]!.url]);
      expect(harness.audios).toHaveLength(1); // no data: retry for a stopped clip

      harness.deliver(clip('speech-14')); // the same id is not played again
      expect(harness.audios).toHaveLength(1);
    });
  });

  it('plays a payload of exactly the largest permitted size, under its own id', async () => {
    const harness = createHarness();
    const base64 = Buffer.alloc(4_500_000, 7).toString('base64');
    expect(base64).toHaveLength(6_000_000);

    harness.deliver(clip('speech-max', { base64 }));

    expect(harness.playbacks()).toEqual([]); // accepted, not failed
    expect(harness.audios).toHaveLength(1);
    expect(harness.created[0]!.blob.size).toBe(4_500_000);

    harness.audios[0]!.emit('playing');
    harness.audios[0]!.emit('ended');
    expect(harness.playbacks()).toEqual(['started:speech-max', 'ended:speech-max']);
    expect(harness.revoked).toEqual([harness.created[0]!.url]);
  });
});

describe('unexpected pauses and other element events', () => {
  it('an outside pause of a playing clip ends it once, clears Speaking, and releases everything', async () => {
    await withoutUnhandledRejections(async () => {
      const harness = createHarness();
      const audio = await startedClip(harness, 'speech-15');

      audio.emit('pause');
      audio.emit('pause');
      audio.emit('ended');

      expect(harness.playbacks()).toEqual(['started:speech-15', 'ended:speech-15']);
      expect(harness.status()).not.toContain('Speaking');
      expect(audio.listenerCount).toBe(0);
      expect(audio.srcRemoved).toBe(true);
      expect(harness.revoked).toEqual([harness.created[0]!.url]);
    });
  });

  it('the pause the browser fires just before a natural "ended" does not end the clip early', async () => {
    const harness = createHarness();
    const audio = await startedClip(harness, 'speech-16');

    audio.ended = true;
    audio.emit('pause');
    expect(harness.playbacks()).toEqual(['started:speech-16']);
    expect(harness.status()).toContain('Speaking');

    audio.emit('ended');
    expect(harness.playbacks()).toEqual(['started:speech-16', 'ended:speech-16']);
  });

  it('a pause before the clip started changes nothing', () => {
    const harness = createHarness();
    harness.deliver(clip('speech-17'));

    harness.audios[0]!.emit('pause');

    expect(harness.playbacks()).toEqual([]);
    expect(harness.status()).not.toContain('Speaking');
    expect(harness.audios).toHaveLength(1);
  });

  it('buffering (waiting, stalled, suspend) is not an ending: the clip keeps speaking and can finish', async () => {
    const harness = createHarness();
    const audio = await startedClip(harness, 'speech-18');

    for (const type of ['waiting', 'stalled', 'suspend', 'seeking', 'timeupdate']) audio.emit(type);

    expect(harness.playbacks()).toEqual(['started:speech-18']);
    expect(harness.status()).toContain('Speaking');

    audio.emit('playing'); // buffering ends: still one "started"
    audio.emit('ended');
    expect(harness.playbacks()).toEqual(['started:speech-18', 'ended:speech-18']);
  });

  it('abort and emptied from the browser emptying a released element are ignored', async () => {
    const harness = createHarness();
    const audio = await startedClip(harness, 'speech-19');
    harness.deliver({ type: 'stop_audio' });
    const before = [...harness.posts];

    audio.emit('abort');
    audio.emit('emptied');
    audio.emit('pause');

    expect(harness.posts).toEqual(before);
    expect(harness.status()).not.toContain('Speaking');
  });
});
