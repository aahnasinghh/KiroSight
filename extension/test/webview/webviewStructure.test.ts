import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import { buildWebviewHtml } from '../../src/webview/html';
import { createViewModel } from '../../src/webview/viewModel';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(resolve(testDirectory, '../../media/main.js'), 'utf8');
const stylesSource = readFileSync(resolve(testDirectory, '../../media/styles.css'), 'utf8');

const nonce = 'dGVzdC1ub25jZS12YWx1ZQ==';
const options = {
  cspSource: 'https://webview.example.invalid',
  styleUri: 'https://webview.example.invalid/media/styles.css',
  scriptUri: 'https://webview.example.invalid/media/main.js',
  nonce,
};
const html = buildWebviewHtml(options);

// A scoped key/value credential pattern for committed assets, not for runtime transcript text.
const credentialPattern = /token|secret|password|credential|authorization|bearer|api[_-]?key/i;

const opened: JSDOM[] = [];

/** Parses the real generated HTML only; scripts in the page are not run. */
function parse(): JSDOM {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  opened.push(dom);
  return dom;
}

/** Parses the real HTML and runs the real main.js against a fake webview API. */
function createHarness() {
  const dom = parse();
  const { window } = dom;
  const document = window.document;
  const posts: unknown[] = [];
  let apiCalls = 0;

  (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => {
    apiCalls += 1;
    return { postMessage: (message: unknown) => { posts.push(message); } };
  };
  window.eval(mainSource);

  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const input = byId('input') as HTMLInputElement;

  return {
    window,
    document,
    posts,
    input,
    byId,
    apiCalls: () => apiCalls,
    deliver: (data: unknown) => {
      window.dispatchEvent(new window.MessageEvent('message', { data }));
    },
    submit: () => {
      const form = byId('cmd');
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    },
    key: (key: string) => {
      const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      return event;
    },
    transcriptLines: () => Array.from(byId('transcript').children).map((child) => child.textContent),
  };
}

/** Normal Tab stops from the real DOM: tabindex >= 0, not disabled, not inside [hidden]. */
function tabStops(document: Document): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'))
    .filter((element) => !element.hasAttribute('disabled'))
    .filter((element) => !(element.hasAttribute('tabindex') && Number(element.getAttribute('tabindex')) < 0))
    .filter((element) => element.closest('[hidden]') === null)
    .map((element) => element.id);
}

const entry = (seq: number, role: 'user' | 'kirosight' | 'system', text: string) => ({ seq, role, text });
const viewState = (input: Parameters<typeof createViewModel>[0] = {}) => ({
  type: 'view_state',
  ...createViewModel(input),
});

afterEach(() => {
  while (opened.length > 0) {
    opened.pop()?.window.close();
  }
});

describe('webview structure (generated HTML)', () => {
  it('orders the main regions as designed in the DOM', () => {
    const { document } = parse().window;
    const ordered = [
      document.querySelector('h1'),
      document.getElementById('status'),
      document.getElementById('transcript'),
      document.getElementById('latest'),
      document.getElementById('confirm'),
      document.getElementById('input'),
      document.getElementById('send'),
      document.getElementById('ptt'),
      document.getElementById('ptt-note'),
    ];

    for (const element of ordered) {
      expect(element).not.toBeNull();
    }
    for (let index = 1; index < ordered.length; index += 1) {
      const position = ordered[index - 1]!.compareDocumentPosition(ordered[index]!);
      expect(position & 4).toBe(4); // DOCUMENT_POSITION_FOLLOWING
    }
  });

  it('has the expected Tab order and no positive tabindex', () => {
    const { document } = parse().window;

    expect(tabStops(document)).toEqual(['transcript', 'input', 'send', 'ptt']);
    for (const element of Array.from(document.querySelectorAll('[tabindex]'))) {
      expect(Number(element.getAttribute('tabindex'))).toBeLessThanOrEqual(0);
    }
  });

  it('has landmarks, headings and labelled sections', () => {
    const { document } = parse().window;

    expect(document.querySelectorAll('main')).toHaveLength(1);
    expect(document.querySelector('h1')?.textContent).toBe('KiroSight');
    for (const section of Array.from(document.querySelectorAll('section'))) {
      const heading = document.getElementById(section.getAttribute('aria-labelledby') ?? '');
      expect(heading?.tagName).toBe('H2');
      expect(heading?.textContent?.trim().length).toBeGreaterThan(0);
    }
    expect(document.querySelectorAll('section')).toHaveLength(3);
    expect(document.getElementById('cmd')?.tagName).toBe('FORM');
  });

  it('gives every control a visible accessible name', () => {
    const { document } = parse().window;

    expect(document.querySelector('label[for="input"]')?.textContent).toBe('Command');
    expect(document.getElementById('send')?.textContent).toBe('Send');
    expect(document.getElementById('confirm-yes')?.textContent).toBe('Confirm');
    expect(document.getElementById('confirm-no')?.textContent).toBe('Decline');
    expect(document.getElementById('ptt')?.textContent?.trim().length).toBeGreaterThan(0);
    for (const element of Array.from(document.querySelectorAll('button, input'))) {
      expect(element.hasAttribute('title') && !element.textContent?.trim() && !element.id).toBe(false);
    }
  });

  it('has one textual status region', () => {
    const { document } = parse().window;
    const statuses = document.querySelectorAll('[role="status"]');

    expect(statuses).toHaveLength(1);
    expect(statuses[0].id).toBe('status');
    expect(statuses[0].textContent).toBe('Status: Idle');
  });

  it('uses exactly one live announcer for transcript entries', () => {
    const { document } = parse().window;
    const liveSelector = '[aria-live], [role="log"], [role="status"], [role="alert"]';
    const transcript = document.getElementById('transcript')!;
    const latest = document.getElementById('latest')!;

    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(transcript.getAttribute('role')).toBe('log');
    expect(transcript.getAttribute('aria-live')).toBe('polite');
    expect(latest.closest(liveSelector)).toBeNull();
    expect(document.getElementById('status')!.contains(transcript)).toBe(false);
    // Only the transcript and the separate status line are live; latest is never announced.
    expect(Array.from(document.querySelectorAll(liveSelector)).map((element) => element.id)).toEqual([
      'status',
      'transcript',
    ]);
  });

  it('emits the approved CSP with no connect-src', () => {
    const { document } = parse().window;
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`style-src ${options.cspSource}`);
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).toContain('media-src blob: data:');
    expect(csp).not.toContain('connect-src');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('carries no credential patterns in main.js, styles.css or the generated HTML', () => {
    for (const asset of [mainSource, stylesSource, html]) {
      expect(asset).not.toMatch(credentialPattern);
    }
  });

  it('keeps push-to-talk a real, focusable, aria-disabled button without the native disabled state', () => {
    const { document } = parse().window;
    const ptt = document.getElementById('ptt')!;
    const note = document.getElementById(ptt.getAttribute('aria-describedby') ?? '');

    expect(ptt.tagName).toBe('BUTTON');
    expect(ptt.getAttribute('aria-pressed')).toBe('false');
    expect(ptt.getAttribute('aria-disabled')).toBe('true');
    expect(ptt.hasAttribute('disabled')).toBe(false);
    expect(tabStops(document)).toContain('ptt');
    expect(note?.id).toBe('ptt-note');
    expect(note?.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('accepts at least 1,000 characters in the command input', () => {
    const { document } = parse().window;
    const input = document.getElementById('input') as HTMLInputElement;

    expect(input.maxLength === -1 || (input.maxLength >= 1000 && input.maxLength <= 4000)).toBe(true);
    input.value = 'x'.repeat(4000);
    expect(input.value).toHaveLength(4000);
  });

  it('uses native buttons for every button control', () => {
    const { document } = parse().window;

    for (const id of ['send', 'confirm-yes', 'confirm-no', 'ptt']) {
      expect(document.getElementById(id)?.tagName).toBe('BUTTON');
    }
  });
});

describe('webview runtime (real main.js in jsdom)', () => {
  it('acquires the API once, posts ready once and focuses the input', () => {
    const harness = createHarness();

    expect(harness.apiCalls()).toBe(1);
    expect(harness.posts).toEqual([{ type: 'ready' }]);
    expect(harness.document.activeElement).toBe(harness.input);
  });

  it('keeps the draft until a matching handled acknowledgement', () => {
    const harness = createHarness();
    harness.input.value = 'where am I';

    harness.submit();
    expect(harness.posts.at(-1)).toEqual({ type: 'submit_text', submitId: 'submit-1', text: 'where am I' });
    expect(harness.input.value).toBe('where am I');

    harness.deliver({ type: 'submit_ack', submitId: 'submit-1', status: 'not_handled' });
    expect(harness.input.value).toBe('where am I');

    harness.submit();
    harness.deliver({ type: 'submit_ack', submitId: 'submit-2', status: 'discarded' });
    expect(harness.input.value).toBe('where am I');

    harness.submit();
    harness.deliver({ type: 'submit_ack', submitId: 'submit-3', status: 'handled' });
    expect(harness.input.value).toBe('');
  });

  it('does not let a stale handled acknowledgement clear a newer draft', () => {
    const harness = createHarness();
    harness.input.value = 'draft A';
    harness.submit();
    harness.input.value = 'draft B';

    harness.deliver({ type: 'submit_ack', submitId: 'submit-1', status: 'handled' });

    expect(harness.input.value).toBe('draft B');
  });

  it('ignores acknowledgements for unknown submissions', () => {
    const harness = createHarness();
    harness.input.value = 'keep';

    harness.deliver({ type: 'submit_ack', submitId: 'never-sent', status: 'handled' });

    expect(harness.input.value).toBe('keep');
  });

  it('submits long drafts untouched', () => {
    const harness = createHarness();
    const text = '  spaced '.repeat(200);
    harness.input.value = text;

    harness.submit();

    expect(harness.posts.at(-1)).toEqual({ type: 'submit_text', submitId: 'submit-1', text });
    expect(harness.input.value).toBe(text);
  });

  it('shows backend_unavailable text while keeping the draft', () => {
    const harness = createHarness();
    harness.input.value = 'explain this error';
    const postsBefore = harness.posts.length;

    harness.deliver({ type: 'backend_unavailable', kind: 'text', message: 'The backend is not running.' });

    expect(harness.byId('status').textContent).toBe('The backend is not running.');
    expect(harness.input.value).toBe('explain this error');
    expect(harness.posts).toHaveLength(postsBefore);
  });

  it('renders a view_state', () => {
    const harness = createHarness();

    harness.deliver(viewState({
      statusKind: 'listening',
      transcript: [entry(1, 'user', 'where am I'), entry(2, 'kirosight', 'In login.ts')],
      latest: 'In login.ts',
      voice: { state: 'available', reasonText: 'Microphone ready.' },
    }));

    const ptt = harness.byId('ptt');
    expect(harness.byId('status').textContent).toBe('Listening');
    expect(harness.transcriptLines()).toEqual(['You: where am I', 'KiroSight: In login.ts']);
    expect(harness.byId('latest').textContent).toBe('In login.ts');
    expect(harness.byId('ptt-note').textContent).toBe('Microphone ready.');
    expect(ptt.getAttribute('aria-disabled')).toBe('false');
    expect(ptt.getAttribute('aria-pressed')).toBe('true');
    expect(ptt.textContent).toBe('Stop listening');
  });

  it('keeps push-to-talk focusable and explained when voice is unavailable', () => {
    const harness = createHarness();

    harness.deliver(viewState());

    const ptt = harness.byId('ptt');
    expect(ptt.getAttribute('aria-disabled')).toBe('true');
    expect(ptt.getAttribute('aria-pressed')).toBe('false');
    expect(ptt.textContent).toBe('Push to talk');
    expect(ptt.hasAttribute('disabled')).toBe(false);
    expect(harness.byId('ptt-note').textContent).toContain('Voice is unavailable');
    expect(tabStops(harness.document)).toContain('ptt');
  });

  it('posts ptt_toggle only when voice is available', () => {
    const harness = createHarness();
    const ptt = harness.byId('ptt');

    ptt.click();
    expect(harness.posts).toEqual([{ type: 'ready' }]);
    expect(harness.byId('status').textContent).toBe(harness.byId('ptt-note').textContent);

    harness.deliver(viewState({ voice: { state: 'available', reasonText: null } }));
    ptt.click();
    expect(harness.posts.at(-1)).toEqual({ type: 'ptt_toggle' });
  });

  it('renders HTML-like text as text, never as markup', () => {
    const harness = createHarness();

    harness.deliver(viewState({
      transcript: [entry(1, 'user', '<script>alert(1)</script>')],
      latest: '<b>not markup</b>',
    }));

    expect(harness.transcriptLines()).toEqual(['You: <script>alert(1)</script>']);
    expect(harness.byId('transcript').querySelector('script')).toBeNull();
    expect(harness.byId('latest').textContent).toBe('<b>not markup</b>');
    expect(harness.byId('latest').querySelector('b')).toBeNull();
  });

  it('appends each transcript entry once across transcript_append and a later view_state', () => {
    const harness = createHarness();
    harness.deliver(viewState({ transcript: [entry(1, 'user', 'one'), entry(2, 'kirosight', 'two')] }));
    const firstLine = harness.byId('transcript').firstElementChild;

    harness.deliver({ type: 'transcript_append', entry: entry(3, 'system', 'three') });
    expect(harness.transcriptLines()).toEqual(['You: one', 'KiroSight: two', 'System: three']);

    harness.deliver({ type: 'transcript_append', entry: entry(3, 'system', 'three') });
    expect(harness.transcriptLines()).toHaveLength(3);

    harness.deliver(viewState({
      transcript: [entry(1, 'user', 'one'), entry(2, 'kirosight', 'two'), entry(3, 'system', 'three')],
    }));
    expect(harness.transcriptLines()).toEqual(['You: one', 'KiroSight: two', 'System: three']);
    expect(harness.byId('transcript').firstElementChild).toBe(firstLine);
  });

  it('keeps the confirmation section hidden and out of the Tab order while nothing is pending', () => {
    const harness = createHarness();

    harness.deliver(viewState());

    const confirm = harness.byId('confirm');
    expect(confirm.hidden).toBe(true);
    expect(tabStops(harness.document)).not.toContain('confirm-yes');
    expect(tabStops(harness.document)).not.toContain('confirm-no');
  });

  it('posts confirm and decline when the buttons are activated', () => {
    const harness = createHarness();

    harness.byId('confirm-yes').click();
    harness.byId('confirm-no').click();

    expect(harness.posts.slice(1)).toEqual([{ type: 'confirm' }, { type: 'decline' }]);
  });

  it('moves focus to the input on focus_input without any other effect', () => {
    const harness = createHarness();
    harness.byId('ptt').focus();
    harness.input.value = 'my draft';
    const postsBefore = harness.posts.length;
    const statusBefore = harness.byId('status').textContent;
    const transcriptBefore = harness.transcriptLines();

    harness.deliver({ type: 'focus_input' });

    expect(harness.document.activeElement).toBe(harness.input);
    expect(harness.input.value).toBe('my draft');
    expect(harness.posts).toHaveLength(postsBefore);
    expect(harness.byId('status').textContent).toBe(statusBefore);
    expect(harness.transcriptLines()).toEqual(transcriptBefore);
  });

  it('posts interrupt on Escape without preventing the key', () => {
    const harness = createHarness();

    const event = harness.key('Escape');

    expect(harness.posts.at(-1)).toEqual({ type: 'interrupt' });
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not react to navigation, activation or Tab keys', () => {
    const harness = createHarness();
    const postsBefore = harness.posts.length;

    for (const key of [
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Enter', ' ',
    ]) {
      const event = harness.key(key);
      expect(event.defaultPrevented).toBe(false);
    }

    expect(harness.posts).toHaveLength(postsBefore);
  });

  it('ignores unknown and malformed host messages safely', () => {
    const harness = createHarness();
    const postsBefore = harness.posts.length;

    for (const data of [null, undefined, 'view_state', 7, [], {}, { type: 'unknown' }, { type: 'view_state', status: 5 }]) {
      expect(() => harness.deliver(data)).not.toThrow();
    }

    expect(harness.posts).toHaveLength(postsBefore);
  });
});
