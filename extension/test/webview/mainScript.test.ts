import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { buildWebviewHtml } from '../../src/webview/html';

// These tests only protect static constraints of the script source. They do not
// prove runtime DOM behavior; that is covered by the later jsdom structure suite.
const testDirectory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(testDirectory, '../../media/main.js'), 'utf8');
const html = buildWebviewHtml({
  cspSource: 'https://example.invalid',
  styleUri: 'styles.css',
  scriptUri: 'main.js',
  nonce: 'dGVzdC1ub25jZS12YWx1ZQ==',
});

describe('webview main.js source', () => {
  it('is syntactically valid plain JavaScript', () => {
    expect(() => new Script(source)).not.toThrow();
  });

  it('acquires the webview API exactly once and posts ready once', () => {
    expect(source.match(/acquireVsCodeApi\(\)/g)).toHaveLength(1);
    expect(source.match(/type: 'ready'/g)).toHaveLength(1);
    expect(source).not.toMatch(/window\.\w*vscode|window\.api/i);
  });

  it('uses only element ids that exist in the generated html', () => {
    const ids = [...source.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('posts only message types the bridge defines for the webview', () => {
    const posted = [...source.matchAll(/post\(\{ type: '([a-z_]+)'/g)].map((match) => match[1]);

    expect(new Set(posted)).toEqual(
      new Set(['ready', 'submit_text', 'confirm', 'decline', 'ptt_toggle', 'interrupt', 'mic_state']),
    );
    // The recording is posted as audio_clip chunks (multi-line posts the pattern above skips).
    expect(source.match(/type: 'audio_clip'/g)).toHaveLength(2);
  });

  it('clears the draft only for a handled acknowledgement', () => {
    expect(source).toContain("message.status === 'handled'");
    expect(source.match(/input\.value = ''/g)).toHaveLength(1);
  });

  it('handles backend_unavailable, view_state and transcript_append', () => {
    for (const type of ['view_state', 'submit_ack', 'backend_unavailable', 'transcript_append']) {
      expect(source).toContain(`case '${type}'`);
    }
  });

  it('handles focus_input by focusing the input only, with no global focus handler', () => {
    const start = source.indexOf("case 'focus_input'");
    const end = source.indexOf("case 'transcript_append'");
    const block = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('elements.input.focus()');
    expect(block).not.toMatch(/value|post\(|setStatus|textContent|select\(|setSelectionRange/);
    // Initial load, the explicit focus_input path, the pending prompt, and the input after the
    // last confirmation resolves; nothing else moves focus.
    expect(source.match(/\.focus\(\)/g)).toHaveLength(4);
    expect(source).not.toMatch(/addEventListener\('(focus|focusin|visibilitychange)'/);
  });

  it('never builds markup from data or runs dynamic code', () => {
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it('has no network or backend access', () => {
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|https?:\/\//);
  });

  it('keeps push-to-talk focusable and does not use the native disabled state', () => {
    expect(source).not.toMatch(/\.disabled\s*=|setAttribute\('disabled'/);
    expect(source).toContain("setAttribute('aria-disabled'");
    expect(source).toContain("setAttribute('aria-pressed'");
  });

  it('does not intercept navigation keys or screen reader shortcuts', () => {
    expect(source).not.toMatch(/Arrow(Up|Down|Left|Right)|PageUp|PageDown|'Home'|'End'|'Tab'|'Enter'|' '/);
    expect(source).not.toContain('stopPropagation');
    // preventDefault is needed once, to stop the form navigating; the key handler must not call it.
    expect(source.match(/preventDefault\(\)/g)).toHaveLength(1);
    const keyHandler = source.slice(source.indexOf("document.addEventListener('keydown'"));
    expect(keyHandler).not.toContain('preventDefault');
    expect(keyHandler).toContain("event.key === 'Escape'");
  });

  it('avoids time, randomness, persistence, and framework code', () => {
    expect(source).not.toMatch(/Date\.now|Math\.random|setState|localStorage|import |require\(/);
  });

  it('does not depend on jsdom, which is only an exactly pinned dev dependency', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(testDirectory, '../../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    expect(source).not.toContain('jsdom');
    expect(manifest.dependencies?.jsdom).toBeUndefined();
    expect(manifest.devDependencies?.jsdom).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
