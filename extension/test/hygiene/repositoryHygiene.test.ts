import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildWebviewHtml } from '../../src/webview/html';

/**
 * Task 10.3: repository hygiene (Req 17.3, 17.4, 17.6, 19.4).
 *
 * Three things are kept true here, without reading any real `.env` file, any real credential, or
 * making any network call:
 *
 * 1. The environment variable NAMES the Python and TypeScript sources read match `.env.example` and
 *    `docs/env-vars.md`, so setup instructions can never silently drift from the code.
 * 2. `.gitignore` really keeps secrets, dependencies, virtual environments, bytecode caches and build
 *    output out of version control (checked with `git check-ignore`, not just by reading the file), and
 *    no such file is tracked.
 * 3. No credential-shaped text appears in the webview assets, the generated HTML or the extension source.
 *
 * Pattern scanning catches credential SHAPES only. It cannot prove that no secret exists anywhere, and
 * it is not a substitute for a dedicated secret scanner or for keeping real keys out of the repository.
 * Every fake credential below is assembled from fragments at run time, so this file contains no
 * complete credential-shaped string.
 */
const testDirectory = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(testDirectory, '../..');
const repoRoot = resolve(extensionRoot, '..');

const SKIPPED_DIRECTORIES = new Set(['node_modules', '__pycache__', 'dist', '.git', '.hypothesis', '.pytest_cache', '.venv']);

function filesUnder(directory: string, extensions: readonly string[], found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) filesUnder(full, extensions, found);
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full);
  }
  return found.sort();
}

const read = (...parts: string[]): string => readFileSync(join(repoRoot, ...parts), 'utf8');
const lines = (text: string): string[] => text.split(/\r?\n/);

// --- environment variable names -------------------------------------------------------------------------

/** Names (and values) in an `.env.example`. Comments and blank lines are ignored. */
function exampleEntries(file: string): Array<{ name: string; value: string }> {
  const entries: Array<{ name: string; value: string }> = [];
  for (const line of lines(read(file))) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    expect(match, `${file}: "${trimmed}" is not NAME=`).not.toBeNull();
    entries.push({ name: match![1]!, value: match![2]! });
  }
  return entries;
}

/**
 * Variables the Python backend reads: quoted names with the project's prefixes. A name ending in
 * `_URL` is a constant, not a variable (for example the Deepgram endpoints in `__all__`).
 */
function pythonReferencedNames(): Set<string> {
  const names = new Set<string>();
  for (const file of filesUnder(join(repoRoot, 'backend', 'app'), ['.py'])) {
    for (const match of readFileSync(file, 'utf8').matchAll(/["']((?:KIROSIGHT|DEEPGRAM|AWS)_[A-Z0-9_]+|BEDROCK_MODEL_ID)["']/g)) {
      if (!match[1]!.endsWith('_URL')) names.add(match[1]!);
    }
  }
  return names;
}

/** `process.env.NAME` / `process.env['NAME']` in the extension source and the webview assets. */
function typescriptReferencedNames(directories: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const directory of directories) {
    for (const file of filesUnder(directory, ['.ts', '.js'])) {
      for (const match of readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Za-z0-9_]+)|process\.env\[\s*['"]([A-Za-z0-9_]+)['"]\s*\]/g)) {
        names.add((match[1] ?? match[2])!);
      }
    }
  }
  return names;
}

const documentedNames = (): string[] => [...read('docs', 'env-vars.md').matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((match) => match[1]!);
const sorted = (values: Iterable<string>): string[] => [...values].sort();

describe('environment variable names stay in step with the code', () => {
  const exampleNames = exampleEntries('.env.example').map((entry) => entry.name);

  it('the scanner really finds the variables the backend reads (so the checks below cannot pass by finding nothing)', () => {
    const found = pythonReferencedNames();
    for (const name of ['DEEPGRAM_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'KIROSIGHT_LLM', 'KIROSIGHT_AUTH_TOKEN', 'AWS_DEFAULT_REGION']) {
      expect(found.has(name), name).toBe(true);
    }
    expect(found.has('DEEPGRAM_LISTEN_URL')).toBe(false);
    expect(found.has('BEDROCK_UNAVAILABLE')).toBe(false); // an error code, not a variable
  });

  it('every variable the Python sources read is listed in .env.example', () => {
    const missing = sorted(pythonReferencedNames()).filter((name) => !exampleNames.includes(name));
    expect(missing).toEqual([]);
  });

  it('every variable listed in .env.example is read by some source (no stale entries)', () => {
    const used = new Set([...pythonReferencedNames(), ...typescriptReferencedNames([join(extensionRoot, 'src')])]);
    expect(sorted(exampleNames).filter((name) => !used.has(name))).toEqual([]);
  });

  it('docs/env-vars.md documents exactly the variables in .env.example, each once', () => {
    const documented = documentedNames();
    expect(new Set(documented).size).toBe(documented.length);
    expect(sorted(documented)).toEqual(sorted(exampleNames));
  });

  it('the root and backend .env.example files list the same names in the same order', () => {
    expect(exampleEntries('backend/.env.example').map((entry) => entry.name)).toEqual(exampleNames);
    expect(new Set(exampleNames).size).toBe(exampleNames.length);
  });

  it('.env.example files hold names only: no value, so no secret can be committed through them', () => {
    for (const file of ['.env.example', 'backend/.env.example']) {
      for (const entry of exampleEntries(file)) expect(entry.value, `${file}: ${entry.name}`).toBe('');
    }
  });

  it('the extension and the webview read no environment variable the examples do not list', () => {
    const extensionReads = typescriptReferencedNames([join(extensionRoot, 'src'), join(extensionRoot, 'media')]);
    expect(sorted(extensionReads).filter((name) => !exampleNames.includes(name))).toEqual([]);
    expect(sorted(typescriptReferencedNames([join(extensionRoot, 'media')]))).toEqual([]); // the webview reads none at all
  });

  it('the backend tests isolate every one of these variables from a developer\'s real environment', () => {
    const conftest = read('backend', 'tests', 'conftest.py');
    const unisolated = exampleNames.filter((name) => !new RegExp(`["']${name}["']`).test(conftest));
    expect(unisolated).toEqual([]);
  });
});

// --- .gitignore -----------------------------------------------------------------------------------------

function git(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', [...args], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  expect(result.error, `git ${args.join(' ')} could not run`).toBeUndefined();
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** `git check-ignore --no-index` applies the ignore rules to a path whether or not it exists or is tracked. */
const isIgnored = (path: string): boolean => {
  const result = git(['check-ignore', '-q', '--no-index', '--', path]);
  expect([0, 1], `${path}: ${result.stderr}`).toContain(result.status);
  return result.status === 0;
};

describe('.gitignore keeps secrets, dependencies and generated files out of version control', () => {
  const rules = lines(read('.gitignore')).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));

  it('lists the required rules', () => {
    for (const rule of ['.env', '.env.*', '!.env.example', '!**/.env.example', 'node_modules/', '.venv/', 'venv/', 'env/', '__pycache__/', 'dist/', 'out/', 'build/']) {
      expect(rules, rule).toContain(rule);
    }
  });

  it.each([
    '.env',
    'backend/.env',
    'extension/.env',
    'demo-project/.env',
    'backend/.env.local',
    'backend/.env.production',
    'node_modules/pkg/index.js',
    'extension/node_modules/vitest/package.json',
    'demo-project/node_modules/vitest/package.json',
    'backend/.venv/Scripts/python.exe',
    'venv/bin/python',
    'env/lib/site.py',
    'backend/app/__pycache__/main.cpython-312.pyc',
    'backend/tests/__pycache__/conftest.cpython-312.pyc',
    'extension/dist/extension.js',
    'build/output.txt',
    'out/index.js',
  ])('really ignores %s', (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it.each(['.env.example', 'backend/.env.example', 'demo-project/package.json', 'backend/app/config.py', 'extension/src/extension.ts'])(
    'does not ignore %s',
    (path) => {
      expect(isIgnored(path)).toBe(false);
    },
  );

  it('tracks no real environment file, dependency directory, virtual environment, bytecode or build output', () => {
    const tracked = lines(git(['ls-files']).stdout).filter((line) => line !== '');
    expect(tracked.length).toBeGreaterThan(0);

    const envFiles = tracked.filter((path) => /(^|\/)\.env(\.|$)/.test(path) && !path.endsWith('.env.example'));
    expect(envFiles).toEqual([]);
    const generated = tracked.filter((path) => /(^|\/)(node_modules|\.venv|venv|__pycache__|dist)\//.test(path) || path.endsWith('.pyc'));
    expect(generated).toEqual([]);
  });
});

// --- credential patterns ----------------------------------------------------------------------------------

/**
 * Credential SHAPES only: provider key formats, bearer tokens, JWTs, private-key blocks, and a long
 * literal assigned to a name that says it is a secret.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['AWS access key id', /\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}\b/],
  ['bearer token', /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/i],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['prefixed provider key', /\b(?:dg[_-][A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,})\b/],
  ['private key block', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['secret-named literal', /(?:api[_-]?key|secret|token|password|credential|authorization)\w*['"]?\s*[:=]\s*['"][A-Za-z0-9+/_=-]{16,}['"]/i],
];

function credentialFindings(text: string): string[] {
  return CREDENTIAL_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

describe('no credential-shaped text in the webview, the generated HTML or the extension source', () => {
  it('the detectors recognise fake credentials of each shape (so a clean result means something)', () => {
    const samples: Record<string, string> = {
      'AWS access key id': `id: ${'AKIA' + 'IOSFODNN7EXAMPLE'}`,
      'bearer token': `Authorization: ${'Bearer ' + 'abcdefghijklmnopqrstuvwxyz0123456789'}`,
      JWT: `${'eyJ' + 'hbGciOiJIUzI1NiJ9'}.${'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0'}.${'abcdefghij' + 'klmnop'}`,
      'prefixed provider key': `${'dg_' + 'a1b2c3d4e5f6g7h8i9j0'}`,
      'private key block': `${'-----BEGIN ' + 'RSA PRIVATE KEY-----'}`,
      'secret-named literal': `const apiKey = "${'abcd1234' + 'abcd1234abcd'}";`,
    };
    for (const [name, sample] of Object.entries(samples)) {
      expect(credentialFindings(sample), name).toContain(name);
    }
  });

  it('the detectors leave ordinary code alone', () => {
    for (const sample of [
      'const token = getToken();',
      'nonce="dGVzdC1ub25jZS12YWx1ZQ=="',
      'const AWS_ACCESS_KEY_PATTERN = /\\b(?:AKIA)\\b/g;',
      "const SECRET_STORAGE_KEY = 'kirosight.backendToken';",
      'password: string',
    ]) {
      expect(credentialFindings(sample), sample).toEqual([]);
    }
  });

  it('the webview assets (media/) contain none', () => {
    const assets = filesUnder(join(extensionRoot, 'media'), ['.js', '.css', '.html']);
    expect(assets.length).toBeGreaterThanOrEqual(2); // main.js and styles.css
    for (const asset of assets) {
      expect(credentialFindings(readFileSync(asset, 'utf8')), relative(repoRoot, asset)).toEqual([]);
    }
  });

  const exampleNames = exampleEntries('.env.example').map((entry) => entry.name);

  it('the webview assets hold no environment variable name either: credentials never belong in the page', () => {
    for (const asset of filesUnder(join(extensionRoot, 'media'), ['.js', '.css', '.html'])) {
      const text = readFileSync(asset, 'utf8');
      expect(exampleNames.filter((name) => text.includes(name)), relative(repoRoot, asset)).toEqual([]);
    }
  });

  it('the generated HTML contains none, and no environment variable name', () => {
    const html = buildWebviewHtml({
      cspSource: "'self' https://*.vscode-cdn.net",
      styleUri: 'https://webview.example.invalid/media/styles.css',
      scriptUri: 'https://webview.example.invalid/media/main.js',
      nonce: 'dGVzdC1ub25jZS12YWx1ZQ==',
    });

    expect(html.length).toBeGreaterThan(200);
    expect(credentialFindings(html)).toEqual([]);
    expect(exampleNames.filter((name) => html.includes(name))).toEqual([]);
  });

  it('the extension source (src/**/*.ts) contains none', () => {
    const sources = filesUnder(join(extensionRoot, 'src'), ['.ts']);
    expect(sources.length).toBeGreaterThan(50);
    const findings = sources
      .map((file) => ({ file: relative(repoRoot, file), found: credentialFindings(readFileSync(file, 'utf8')) }))
      .filter((entry) => entry.found.length > 0);
    expect(findings).toEqual([]);
  });

  it('nothing writes to the console or to standard output where a credential could leak', () => {
    const typescript = [...filesUnder(join(extensionRoot, 'src'), ['.ts']), ...filesUnder(join(extensionRoot, 'media'), ['.js'])];
    const python = filesUnder(join(repoRoot, 'backend', 'app'), ['.py']);
    const consoleCalls = typescript.filter((file) => /\bconsole\.(log|debug|info|warn|error)\s*\(/.test(readFileSync(file, 'utf8')));
    const printCalls = python.filter((file) => /^\s*print\s*\(/m.test(readFileSync(file, 'utf8')));

    expect(consoleCalls.map((file) => relative(repoRoot, file))).toEqual([]);
    expect(printCalls.map((file) => relative(repoRoot, file))).toEqual([]);
  });
});
