import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildContentSecurityPolicy,
  buildWebviewHtml,
  generateNonce,
} from '../../src/webview/html';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const nonce = 'dGVzdC1ub25jZS12YWx1ZQ==';
const options = {
  cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
  styleUri: 'https://file+.vscode-resource.vscode-cdn.net/media/styles.css',
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/media/main.js',
  nonce,
};

function cspOf(html: string): string {
  const match = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/);
  expect(match).not.toBeNull();
  return match![1];
}

describe('webview html', () => {
  const html = buildWebviewHtml(options);

  it('generates a complete document', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<h1>KiroSight</h1>');
    expect(html).toContain(`href="${options.styleUri}"`);
  });

  it('emits exactly the approved CSP with no connect-src', () => {
    expect(cspOf(html)).toBe(
      `default-src 'none'; style-src ${options.cspSource}; script-src 'nonce-${nonce}'; media-src blob: data:;`,
    );
    expect(html).not.toContain('connect-src');
    expect(html).not.toContain('unsafe-inline');
    expect(html).not.toContain('unsafe-eval');
  });

  it('uses the nonce on the only script and nowhere unsafe', () => {
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain(`<script nonce="${nonce}" src="${options.scriptUri}"></script>`);
  });

  it('rejects an invalid nonce instead of weakening the CSP', () => {
    expect(() => buildContentSecurityPolicy('src', "x' 'unsafe-inline")).toThrow();
    expect(() => buildContentSecurityPolicy('src', '')).toThrow();
    expect(() => buildContentSecurityPolicy('x; connect-src *', nonce)).toThrow();
    expect(() => buildContentSecurityPolicy('', nonce)).toThrow();
  });

  it('generates fresh, well-formed nonces', () => {
    const nonces = Array.from({ length: 50 }, () => generateNonce());

    expect(new Set(nonces).size).toBe(nonces.length);
    for (const value of nonces) {
      expect(value).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    }
  });

  it('escapes injected attribute values', () => {
    const escaped = buildWebviewHtml({ ...options, styleUri: 'x"><script>alert(1)</script>' });

    expect(escaped).not.toContain('<script>alert(1)');
  });

  it('does not pre-populate the command input with a draft', () => {
    const input = html.match(/<input[^>]*id="input"[^>]*>/)?.[0] ?? '';

    expect(input).not.toBe('');
    expect(input).not.toMatch(/\bvalue=/);
    expect(input).not.toMatch(/maxlength/i);
  });

  it('keeps push-to-talk focusable with aria state and a visible note', () => {
    const button = html.match(/<button[^>]*id="ptt"[^>]*>/)?.[0] ?? '';

    expect(button).toContain('aria-pressed="false"');
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('aria-describedby="ptt-note"');
    expect(button).not.toMatch(/\sdisabled(\s|=|>)/);
    expect(html).toMatch(/<p id="ptt-note">[^<]+<\/p>/);
  });

  it('renders the hidden confirmation controls and no inline handlers or positive tabindex', () => {
    expect(html).toMatch(/<section id="confirm" hidden/);
    expect(html).toContain('>Confirm</button>');
    expect(html).toContain('>Decline</button>');
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/tabindex="[1-9]/);
  });

  it('embeds no credential-like data or network behavior', () => {
    expect(html).not.toMatch(/token|api[_-]?key|secret|password|credential|authorization|bearer/i);
    expect(html).not.toMatch(/fetch\(|WebSocket|EventSource|XMLHttpRequest/);
  });

  it('has no vscode dependency', () => {
    const source = readFileSync(resolve(testDirectory, '../../src/webview/html.ts'), 'utf8');

    expect(source).not.toMatch(/from ['"]vscode['"]|Math\.random|Date\.now/);
  });
});

describe('webview styles', () => {
  const css = readFileSync(resolve(testDirectory, '../../media/styles.css'), 'utf8');

  it('draws a 3px focus outline from the theme focus color with a fallback', () => {
    expect(css).toMatch(/outline:\s*3px solid var\(--vscode-focusBorder,\s*#[0-9a-fA-F]{3,8}\)/);
  });

  it('uses theme variables and respects forced colors', () => {
    expect(css).toContain('--vscode-foreground');
    expect(css).toContain('--vscode-input-background');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).not.toContain('forced-color-adjust');
  });

  it('never removes the outline and gives the unavailable state a non-color cue', () => {
    expect(css).not.toMatch(/outline:\s*(none|0)/);
    expect(css).toMatch(/aria-disabled='true'\][^}]*border-style:\s*dashed/);
  });

  it('contains no network or credential references', () => {
    expect(css).not.toMatch(/url\(\s*['"]?https?:|@import|token|secret|password/i);
  });
});
