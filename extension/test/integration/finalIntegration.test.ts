import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { classifyReply } from '../../src/confirmation/replyClassifier';
import { route } from '../../src/intent/localIntentRouter';
import { HELP_TEXT } from '../../src/pipeline/localIntentHandler';

/**
 * Task 10.9: the offline, deterministic part of the final integration pass. It checks that the
 * manifest, the command registration, the help response, the README and the demo script agree with
 * each other. It reads files only: no vscode host, no backend, no network, no AWS or Deepgram.
 *
 * It does NOT prove that the demo journey works end to end. That needs a running Extension
 * Development Host, with the backend running and again with it stopped (see docs/demo-script.md).
 */
const testDirectory = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(testDirectory, '../..');
const repoRoot = resolve(extensionRoot, '..');

const read = (...parts: string[]): string => readFileSync(resolve(repoRoot, ...parts), 'utf8');

interface Manifest {
  readonly activationEvents?: readonly string[];
  readonly contributes?: {
    readonly commands?: readonly { readonly command: string; readonly title: string }[];
    readonly configuration?: { readonly properties?: Readonly<Record<string, unknown>> };
  };
}

const manifest = JSON.parse(read('extension', 'package.json')) as Manifest;
const readme = read('README.md');
const demoScript = read('docs', 'demo-script.md');
const registerSource = read('extension', 'src', 'commands', 'registerCommands.ts');

const manifestCommands = manifest.contributes?.commands ?? [];

describe('manifest commands are registered and documented', () => {
  it('contributes at least one command and no duplicates', () => {
    const ids = manifestCommands.map(({ command }) => command);

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('registers exactly the commands the manifest contributes', () => {
    const manifestIds = new Set(manifestCommands.map(({ command }) => command));
    const declared = Array.from(
      registerSource.matchAll(/export const [A-Z_]+_COMMAND = '(kirosight\.\w+)'/g),
    ).map((match) => match[1]!);

    expect(declared.length).toBeGreaterThan(0);
    expect(declared.sort()).toEqual(Array.from(manifestIds).sort());
    // Every declared command id is actually passed to registerCommand, none is declared and left unused.
    const registrations = Array.from(registerSource.matchAll(/registerCommand\(([A-Z_]+_COMMAND),/g));
    expect(registrations).toHaveLength(manifestIds.size);
  });

  it('activates on every contributed command', () => {
    const events = new Set(manifest.activationEvents ?? []);

    for (const { command } of manifestCommands) {
      expect(events.has(`onCommand:${command}`), command).toBe(true);
    }
  });

  it('documents every contributed command in the README by its palette title', () => {
    for (const { title } of manifestCommands) {
      const suffix = title.replace(/^KiroSight:\s*/, '');
      const documented = readme.includes(`\`${title}\``) || readme.includes(`\`${suffix}\``);

      expect(documented, title).toBe(true);
    }
  });

  it('documents every contributed setting in the README', () => {
    const keys = Object.keys(manifest.contributes?.configuration?.properties ?? {});

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(readme.includes(`\`${key}\``), key).toBe(true);
    }
  });
});

describe('the help response lists the supported commands', () => {
  const help = HELP_TEXT.toLowerCase();

  // Each phrase that help advertises must really route as advertised.
  const local = [
    'where am i', 'current function', 'read selection', 'what errors are there',
    'errors in this file', 'next error', 'previous error', 'go to the first error',
    'go to line 40', 'open discount.ts', 'focus editor', 'run tests',
    'summarize the test failures', 'list all failures', 'help',
  ] as const;

  it.each(local)('routes the advertised phrase "%s" locally', (phrase) => {
    expect(route(phrase).route).toBe('local');
  });

  it('routes "explain this error" to the backend agent', () => {
    expect(route('explain this error')).toEqual({ route: 'agent', reason: 'semantic' });
  });

  it.each([
    'where am i', 'current function', 'read selection', 'what errors are there',
    'errors in this file', 'next error', 'previous error', 'go to the first',
    'go to line', 'open a file name', 'focus editor', 'run tests',
    'summarize the test failures', 'list all failures', 'explain this error', 'help',
  ])('mentions "%s"', (phrase) => {
    expect(help).toContain(phrase);
  });

  it('says that explaining an error needs the backend', () => {
    expect(help).toMatch(/explain this error \([^)]*backend[^)]*\)/);
  });

  it.each([
    ['confirm', 'confirm'], ['decline', 'decline'], ['cancel', 'cancel'], ['repeat', 'repeat'],
  ] as const)('mentions the confirmation reply "%s" and it is recognized', (word, expected) => {
    expect(help).toContain(word);
    expect(classifyReply(word)).toBe(expected);
  });

  it('does not advertise features the MVP does not have', () => {
    expect(help).not.toMatch(/\bgit\b|symbol|\bfix\b|\bedit\b|\bscreenshot\b/);
  });
});

describe('the README and the demo script use phrases the router handles', () => {
  const journey = [
    ['where am I', 'local'],
    ['what errors are there', 'local'],
    ['go to the first error', 'local'],
    ['open discount.ts', 'local'],
    ['run my tests', 'local'],
    ['summarize the test failures', 'local'],
    ['help', 'local'],
    ['explain this error', 'agent'],
  ] as const;

  it.each(journey)('the demo script uses "%s" and it routes %s', (phrase, expected) => {
    expect(demoScript.toLowerCase()).toContain(`"${phrase.toLowerCase()}"`);
    expect(route(phrase).route).toBe(expected);
  });

  it.each([
    ['where am I', 'local'],
    ['what errors are there', 'local'],
    ['go to the first error', 'local'],
    ['open auth.ts', 'local'],
    ['run my tests', 'local'],
    ['summarize the test failures', 'local'],
    ['help', 'local'],
    ['explain this error', 'agent'],
  ] as const)('the README command table uses "%s" and it routes %s', (phrase, expected) => {
    expect(readme.toLowerCase()).toContain(`"${phrase.toLowerCase()}"`);
    expect(route(phrase).route).toBe(expected);
  });
});

function sourceFiles(directory: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === '__pycache__' || name === '.venv' || name === 'dist') continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path, extensions));
    else if (extensions.some((extension) => name.endsWith(extension))) found.push(path);
  }
  return found;
}

describe('throwaway spike code is gone from the runtime path', () => {
  const removed = [
    'spikes/activation-command/extension.js', 'spikes/activation-command/extension-host-test.js',
    'spikes/activation-command/package.json', 'spikes/activation-command/smoke-test.js',
    'spikes/document-symbol/extension.js', 'spikes/document-symbol/fixture.ts',
    'spikes/document-symbol/package.json', 'spikes/document-symbol/symbol-test.js',
    'spikes/trusted-test-command-windows/run.js', 'spikes/trusted-test-command-windows/fixtures/normal.js',
    'spikes/webview-mic/extension.js', 'spikes/webview-mic/smoke-test.js', 'spikes/webview-mic/package.json',
    'backend/spikes/bedrock_converse.py',
  ];

  it.each(removed)('%s has been removed', (file) => {
    expect(existsSync(resolve(repoRoot, file)), file).toBe(false);
  });

  it('is not imported, required or referenced by any product source, script or test', () => {
    const roots = [
      ['extension/src', ['.ts', '.js']], ['extension/media', ['.js']], ['extension/test', ['.ts']],
      ['backend/app', ['.py']], ['backend/tests', ['.py']], ['scripts', ['.ps1']], ['demo-project/src', ['.ts']],
    ] as const;
    const referencing: string[] = [];

    for (const [root, extensions] of roots) {
      for (const file of sourceFiles(resolve(repoRoot, root), extensions)) {
        // This test file names the removed paths on purpose.
        if (file.endsWith('finalIntegration.test.ts')) continue;
        if (/\bspikes[/\\]/.test(readFileSync(file, 'utf8'))) referencing.push(file);
      }
    }

    expect(referencing).toEqual([]);
  });

  it('keeps the spike findings in docs/spike-results.md and says the code was removed', () => {
    const spikes = read('docs', 'spike-results.md');

    expect(spikes).toContain('removed in Task 10.9');
    expect(readme).not.toMatch(/Throwaway spike code\*\* is still/);
  });
});

describe('documentation links and spike records', () => {
  it('points every relative README link at a file that exists', () => {
    const links = Array.from(readme.matchAll(/\]\(([^)\s]+)\)/g))
      .map((match) => match[1]!)
      .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'))
      .map((target) => target.split('#')[0]!);

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(existsSync(resolve(repoRoot, link)), link).toBe(true);
    }
  });

  it('names only files that exist in the demo script', () => {
    for (const file of [
      'scripts/preflight.ps1', 'demo-project/README.md', 'docs/env-vars.md',
      'docs/accessibility-checklist.md', 'docs/demo-script.md',
    ]) {
      expect(existsSync(resolve(repoRoot, file)), file).toBe(true);
    }
  });

  it('records all five spikes with a result and a decision', () => {
    const spikes = read('docs', 'spike-results.md');

    for (const letter of ['A', 'B', 'C', 'D', 'E']) {
      expect(spikes, `Spike ${letter} heading`).toMatch(new RegExp(`^## Spike ${letter} `, 'm'));
      expect(spikes, `Spike ${letter} summary row`).toMatch(new RegExp(`\\| \\*\\*${letter}\\*\\* \\(Task`));
    }
  });
});
