import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import { buildWebviewHtml } from '../../src/webview/html';
import { createViewModel, STATUS_LABELS } from '../../src/webview/viewModel';
import type { StatusKind } from '../../src/webview/viewModel';

/**
 * Task 10.4: accessibility polish of the webview. These tests run the real generated HTML and the
 * real media/main.js in jsdom, and read the real styles.css. They prove DOM, focus, text and
 * announcement-trigger behavior. They do NOT prove what a screen reader says, how a theme renders,
 * or the real contrast of a theme's own focus color; those need the manual checks listed in the
 * Task 10.6 checklist.
 */
const testDirectory = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(resolve(testDirectory, '../../media/main.js'), 'utf8');
const css = readFileSync(resolve(testDirectory, '../../media/styles.css'), 'utf8');

const html = buildWebviewHtml({
  cspSource: "'self' https://*.vscode-cdn.net",
  styleUri: 'https://webview.example.invalid/media/styles.css',
  scriptUri: 'https://webview.example.invalid/media/main.js',
  nonce: 'dGVzdC1ub25jZS12YWx1ZQ==',
});

const opened: JSDOM[] = [];

function createPage() {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  opened.push(dom);
  const { window } = dom;
  const posts: unknown[] = [];
  (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => { posts.push(message); },
  });
  window.eval(mainSource);

  const byId = (id: string) => window.document.getElementById(id) as HTMLElement;
  return {
    window,
    document: window.document,
    posts,
    byId,
    input: byId('input') as HTMLInputElement,
    deliver: (data: unknown) => {
      window.dispatchEvent(new window.MessageEvent('message', { data }));
    },
    /** Watches the given elements for any DOM change (text replaced, nodes added or removed). */
    watch: (ids: readonly string[]) => {
      const observer = new window.MutationObserver(() => undefined);
      for (const id of ids) {
        // Text and node changes only: that is what a live region announces. Re-setting an
        // attribute to its current value is not an announcement.
        observer.observe(byId(id), { childList: true, characterData: true, subtree: true });
      }
      return observer;
    },
  };
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

describe('focus after Send', () => {
  it('keeps focus in the command input when the Send button is used', () => {
    const page = createPage();
    page.input.value = 'what file am I in';
    page.byId('send').focus();

    page.byId('cmd').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));

    expect(page.document.activeElement).toBe(page.input);
  });

  it('still keeps the draft until the host acknowledges it', () => {
    const page = createPage();
    page.input.value = 'draft';

    page.byId('cmd').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));

    expect(page.input.value).toBe('draft');
  });

  it('lets a confirmation raised by the reply take focus after the submit', () => {
    const page = createPage();
    page.input.value = 'run my tests';
    page.byId('cmd').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));

    page.deliver(viewState({
      statusKind: 'confirmation_pending',
      pendingConfirmation: { promptText: 'Run tests?', presentationKey: 'key-1' },
    }));

    expect(page.document.activeElement).toBe(page.byId('confirm-prompt'));
  });
});

describe('focus after Confirm or Decline', () => {
  const pending = (key: string) => viewState({
    statusKind: 'confirmation_pending',
    pendingConfirmation: { promptText: 'Run tests using "npm test"?', presentationKey: key },
  });

  it.each([
    ['confirm-yes', 'confirm'],
    ['confirm-no', 'decline'],
  ])('%s posts %s and leaves focus in the command input, not on a hidden button', (id, type) => {
    const page = createPage();
    page.deliver(pending('key-1'));
    page.byId(id).focus();
    const before = page.posts.length;

    page.byId(id).click();
    expect(page.posts.slice(before)).toEqual([{ type }]);
    expect(page.document.activeElement).toBe(page.input);

    page.deliver(viewState());
    expect(page.byId('confirm').hidden).toBe(true);
    expect(page.document.activeElement).toBe(page.input);
  });

  it('keeps the typed draft when a confirmation is answered', () => {
    const page = createPage();
    page.input.value = 'half-typed command';
    page.deliver(pending('key-1'));

    page.byId('confirm-yes').click();
    page.deliver(viewState());

    expect(page.input.value).toBe('half-typed command');
  });

  it('gives a follow-up confirmation focus when it appears after an answer', () => {
    const page = createPage();
    page.deliver(pending('key-1'));
    page.byId('confirm-yes').click();

    page.deliver(pending('key-2'));

    expect(page.document.activeElement).toBe(page.byId('confirm-prompt'));
  });
});

describe('one announcement per change', () => {
  it('does not touch any announced or focused text when an identical view_state arrives again', () => {
    const page = createPage();
    const message = viewState({
      statusKind: 'confirmation_pending',
      backendStatus: 'Backend connected',
      transcript: [entry(1, 'user', 'run my tests'), entry(2, 'kirosight', 'Run tests?')],
      latest: 'Run tests?',
      pendingConfirmation: { promptText: 'Run tests?', presentationKey: 'key-1' },
      voice: { state: 'available', reasonText: 'Microphone ready.' },
      listening: true,
    });
    page.deliver(message);
    const observer = page.watch(['status', 'transcript', 'latest', 'confirm-prompt', 'ptt', 'ptt-note']);

    page.deliver(message);
    page.deliver({ ...message });

    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
  });

  it('does change the status text, once, when the status really changes', () => {
    const page = createPage();
    page.deliver(viewState({ statusKind: 'processing' }));
    const observer = page.watch(['status']);

    page.deliver(viewState({ statusKind: 'idle' }));

    expect(page.byId('status').textContent).toBe('Idle');
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    observer.disconnect();
  });

  it('adds a transcript entry exactly once across transcript_append and view_state', () => {
    const page = createPage();
    page.deliver(viewState({ transcript: [entry(1, 'user', 'one')] }));
    const observer = page.watch(['transcript']);

    page.deliver({ type: 'transcript_append', entry: entry(2, 'kirosight', 'two') });
    page.deliver({ type: 'transcript_append', entry: entry(2, 'kirosight', 'two') });
    page.deliver(viewState({ transcript: [entry(1, 'user', 'one'), entry(2, 'kirosight', 'two')] }));

    const added = observer.takeRecords().flatMap((record) => Array.from(record.addedNodes));
    expect(added).toHaveLength(1);
    expect(added[0].textContent).toBe('KiroSight: two');
    expect(page.byId('transcript').children).toHaveLength(2);
    observer.disconnect();
  });

  it('shows the latest response without making it a second announcer', () => {
    const page = createPage();
    const live = '[aria-live], [role="log"], [role="status"], [role="alert"], [role="alertdialog"]';

    page.deliver(viewState({
      transcript: [entry(1, 'kirosight', 'In login.ts')],
      latest: 'In login.ts',
    }));

    expect(page.byId('latest').textContent).toBe('In login.ts');
    expect(page.byId('latest').closest(live)).toBeNull();
    expect(page.byId('confirm-prompt').closest(live)).toBeNull();
    expect(Array.from(page.document.querySelectorAll(live)).map((element) => element.id)).toEqual([
      'status',
      'transcript',
    ]);
  });

  it('does not change the status or the transcript when only the latest response changes', () => {
    const page = createPage();
    const base = { transcript: [entry(1, 'kirosight', 'one')], latest: 'one' };
    page.deliver(viewState(base));
    const observer = page.watch(['status', 'transcript']);

    page.deliver(viewState({ ...base, latest: 'one, repeated' }));

    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
  });

  it('still re-announces the reason when push-to-talk is activated while voice is unavailable', () => {
    const page = createPage();
    page.deliver(viewState());
    const note = page.byId('ptt-note').textContent;
    const observer = page.watch(['status']);

    page.byId('ptt').click();

    expect(page.byId('status').textContent).toBe(note);
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    expect(page.posts.some((post) => (post as { type: string }).type === 'ptt_toggle')).toBe(false);
    observer.disconnect();
  });
});

describe('text label for every status', () => {
  const kinds = Object.keys(STATUS_LABELS) as StatusKind[];

  it.each(kinds)('shows the visible text label for %s', (kind) => {
    const page = createPage();

    page.deliver(viewState({ statusKind: kind }));

    const shown = page.byId('status').textContent ?? '';
    expect(shown.trim().length).toBeGreaterThan(0);
    expect(shown).toBe(STATUS_LABELS[kind]);
  });

  it('keeps the backend summary in the same single status text', () => {
    const page = createPage();

    page.deliver(viewState({ statusKind: 'error', backendStatus: 'Backend not running' }));

    expect(page.byId('status').textContent).toBe('Error. Backend not running');
  });

  it('never marks a state by an icon, color class or attribute alone', () => {
    expect(html).not.toMatch(/class="[^"]*(red|green|error|success)/i);
    expect(html).not.toMatch(/\bstyle=/i);
    expect(mainSource).not.toMatch(/style\.(color|background)|classList|className/);
  });
});

describe('accessible names and roles', () => {
  it('names the transcript log from its visible heading', () => {
    const page = createPage();
    const log = page.byId('transcript');
    const heading = page.document.getElementById(log.getAttribute('aria-labelledby') ?? '');

    expect(log.getAttribute('role')).toBe('log');
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent).toBe('Transcript');
  });

  it('keeps the confirmation prompt readable by focus and the buttons named by their text', () => {
    const page = createPage();
    page.deliver(viewState({
      statusKind: 'confirmation_pending',
      pendingConfirmation: { promptText: 'Run tests?', presentationKey: 'key-1' },
    }));

    expect(page.document.activeElement).toBe(page.byId('confirm-prompt'));
    expect(page.byId('confirm-prompt').textContent).toBe('Run tests?');
    expect(page.byId('confirm-yes').textContent).toBe('Confirm');
    expect(page.byId('confirm-no').textContent).toBe('Decline');
    expect(page.byId('confirm').getAttribute('aria-labelledby')).toBe('confirm-heading');
  });

  it('has no positive tabindex and hides no control from assistive technology', () => {
    const page = createPage();

    for (const element of Array.from(page.document.querySelectorAll('[tabindex]'))) {
      expect(Number(element.getAttribute('tabindex'))).toBeLessThanOrEqual(0);
    }
    for (const element of Array.from(page.document.querySelectorAll('button, input'))) {
      expect(element.closest('[aria-hidden="true"]')).toBeNull();
    }
  });
});

describe('no interception of screen reader or navigation keys', () => {
  it('registers one keydown listener that looks only at Escape', () => {
    expect(mainSource.match(/addEventListener\('key\w+'/g)).toEqual(["addEventListener('keydown'"]);
    expect(mainSource.match(/event\.key\s*===\s*'[^']*'/g)).toEqual(["event.key === 'Escape'"]);
    expect(mainSource).not.toMatch(/\.(keyCode|which|code)\b/);
  });

  it('prevents default only for the form submit', () => {
    expect(mainSource.match(/preventDefault\(\)/g)).toHaveLength(1);
    expect(mainSource).toMatch(/addEventListener\('submit',\s*function \(event\)\s*\{\s*event\.preventDefault\(\)/);
    expect(mainSource).not.toMatch(/stopPropagation|stopImmediatePropagation/);
  });

  it('leaves Tab, arrows, Home, End and Enter or Space untouched', () => {
    const page = createPage();
    const before = page.posts.length;

    for (const key of ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ']) {
      const event = new page.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      page.document.dispatchEvent(event);
      expect(event.defaultPrevented, key).toBe(false);
    }

    expect(page.posts).toHaveLength(before);
  });

  it('does not set role=application or disable browse mode', () => {
    expect(html).not.toMatch(/role="application"|aria-hidden="true"[^>]*tabindex/);
    expect(mainSource).not.toMatch(/role['"]?\s*,\s*['"]application|setAttribute\(\s*'role'/);
  });
});

describe('focus indicator, high contrast and forced colors (styles.css)', () => {
  function block(selector: string): string {
    const start = css.indexOf(selector);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf('}', start));
  }

  function luminance(hex: string): number {
    const channels = [1, 3, 5].map((index) => {
      const value = parseInt(hex.slice(index, index + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function contrast(a: string, b: string): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  }

  it('draws an outline at least 2px wide (3px) with an offset, and never removes it', () => {
    const rule = /^:focus,\s*:focus-visible\s*\{([^}]*)\}/m.exec(css)?.[1] ?? '';
    const width = Number(/outline:\s*(\d+)px solid/.exec(rule)?.[1]);

    expect(width).toBeGreaterThanOrEqual(3);
    expect(rule).toMatch(/outline-offset:\s*\d+px/);
    expect(css).not.toMatch(/outline:\s*(none|0)\b/);
    expect(css).not.toMatch(/outline-width:\s*[01]px/);
  });

  it('has a fallback focus color that holds 3:1 on the light, dark and high-contrast backgrounds', () => {
    const fallback = /var\(--vscode-focusBorder,\s*(#[0-9a-fA-F]{6})\)/.exec(css)?.[1];

    expect(fallback).toBeDefined();
    // Typical VS Code backgrounds: Light, Light sidebar, Dark, Dark sidebar, High Contrast, High Contrast Light.
    for (const background of ['#ffffff', '#f3f3f3', '#1e1e1e', '#252526', '#000000', '#ffffff']) {
      expect(contrast(fallback!, background), background).toBeGreaterThanOrEqual(3);
    }
  });

  it('styles the VS Code high-contrast themes with theme borders and the theme focus color', () => {
    expect(css).toContain('.vscode-high-contrast');
    expect(css).toContain('.vscode-high-contrast-light');
    expect(css).toContain('--vscode-contrastBorder');
    expect(css).toMatch(/\.vscode-high-contrast :focus[\s\S]*outline-color:\s*var\(--vscode-focusBorder/);
  });

  it('uses system colors for regions, fields and focus under forced-colors', () => {
    const start = css.indexOf('@media (forced-colors: active)');
    expect(start).toBeGreaterThanOrEqual(0);
    const forced = css.slice(start);

    expect(forced).toContain('outline-color: Highlight');
    expect(forced).toMatch(/#status,\s*#transcript\s*\{\s*border-color:\s*CanvasText/);
    expect(forced).toMatch(/input\[type='text'\]\s*\{\s*border-color:\s*FieldText/);
    expect(forced).toContain('ButtonText');
    expect(forced).toMatch(/aria-disabled='true'\]\s*\{\s*border-style:\s*dashed/);
    expect(css).not.toContain('forced-color-adjust');
  });

  it('carries meaning by shape and text, not color alone', () => {
    expect(block("button[aria-disabled='true']")).toContain('border-style: dashed');
    expect(block('#ptt-note')).toMatch(/border-left:\s*3px solid currentColor/);
    expect(block('#status')).toContain('font-weight: 600');
  });
});
