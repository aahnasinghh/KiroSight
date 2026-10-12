import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface CommandContribution {
  readonly command: string;
  readonly title: string;
  readonly enablement?: string;
}

interface KeybindingContribution {
  readonly command: string;
  readonly key: string;
  readonly when?: string;
  readonly mac?: string;
}

interface ConfigurationProperty {
  readonly type: string;
  readonly default?: unknown;
  readonly description?: string;
  readonly minimum?: number;
  readonly scope?: string;
}

interface ExtensionManifest {
  readonly activationEvents?: readonly string[];
  readonly contributes?: {
    readonly commands?: readonly CommandContribution[];
    readonly keybindings?: readonly KeybindingContribution[];
    readonly configuration?: {
      readonly properties?: Readonly<Record<string, ConfigurationProperty>>;
    };
    readonly menus?: {
      readonly commandPalette?: ReadonlyArray<{
        readonly command: string;
        readonly when?: string;
      }>;
    };
  };
  readonly capabilities?: {
    readonly untrustedWorkspaces?: {
      readonly restrictedConfigurations?: readonly string[];
    };
  };
}

const testDirectory = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(testDirectory, '../package.json'), 'utf8'),
) as ExtensionManifest;
const spikeResults = readFileSync(
  resolve(testDirectory, '../../docs/spike-results.md'),
  'utf8',
);

function spikeAFoundNoConflict(): boolean {
  const match = spikeResults.match(/^- \*\*Conflict found:\*\* (.+)$/m);

  expect(match, 'Spike A must record an explicit conflict result').not.toBeNull();
  return match?.[1].startsWith('No conflict') ?? false;
}

describe('extension manifest', () => {
  it('contributes the activation command independently to the Command Palette', () => {
    const command = manifest.contributes?.commands?.find(
      (candidate) => candidate.command === 'kirosight.activate',
    );

    const activationPaletteRules = (manifest.contributes?.menus?.commandPalette ?? []).filter(
      (rule) => rule.command === 'kirosight.activate',
    );

    expect(command).toEqual({
      command: 'kirosight.activate',
      title: 'KiroSight: Activate',
    });
    expect(command?.enablement).toBeUndefined();
    expect(manifest.activationEvents).toContain('onCommand:kirosight.activate');
    expect(activationPaletteRules.every((rule) => rule.when === undefined)).toBe(true);
  });

  it('contributes the Where Am I command without a keybinding', () => {
    const command = manifest.contributes?.commands?.find(
      (candidate) => candidate.command === 'kirosight.whereAmI',
    );

    expect(command).toEqual({
      command: 'kirosight.whereAmI',
      title: 'KiroSight: Where Am I',
    });
    expect(manifest.activationEvents).toContain('onCommand:kirosight.whereAmI');
    expect(manifest.contributes?.keybindings?.some(
      (binding) => binding.command === 'kirosight.whereAmI',
    )).toBe(false);
  });

  it('contributes the Milestone 3 commands with activation events', () => {
    const expected = [
      ['kirosight.describeErrors', 'KiroSight: Describe Errors'],
      ['kirosight.nextError', 'KiroSight: Next Error'],
      ['kirosight.previousError', 'KiroSight: Previous Error'],
      ['kirosight.ask', 'KiroSight: Ask'],
    ] as const;

    for (const [command, title] of expected) {
      expect(manifest.contributes?.commands).toContainEqual({ command, title });
      expect(manifest.activationEvents).toContain(`onCommand:${command}`);
    }
  });

  it('contributes the Milestone 5 test commands with activation events and unique command ids', () => {
    for (const [command, title] of [
      ['kirosight.runTests', 'KiroSight: Run Tests'],
      ['kirosight.showTestOutput', 'KiroSight: Show Test Output'],
    ] as const) {
      expect(manifest.contributes?.commands).toContainEqual({ command, title });
      expect(manifest.activationEvents).toContain(`onCommand:${command}`);
    }
    const ids = (manifest.contributes?.commands ?? []).map((candidate) => candidate.command);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'kirosight.activate', 'kirosight.whereAmI', 'kirosight.describeErrors',
      'kirosight.nextError', 'kirosight.previousError', 'kirosight.ask',
    ]));
    expect(Object.prototype.hasOwnProperty.call(manifest.contributes ?? {}, 'capabilities')).toBe(false);
  });

  it('contributes the optional backend launcher command without a keybinding', () => {
    const command = manifest.contributes?.commands?.find(
      (candidate) => candidate.command === 'kirosight.startBackend',
    );

    expect(command).toEqual({
      command: 'kirosight.startBackend',
      title: 'KiroSight: Start Backend',
    });
    expect(manifest.activationEvents).toContain('onCommand:kirosight.startBackend');
    expect(manifest.contributes?.keybindings?.some(
      (binding) => binding.command === 'kirosight.startBackend',
    )).toBe(false);
  });

  it('contributes the optional user backend command setting without a runnable default', () => {
    const properties = manifest.contributes?.configuration?.properties ?? {};
    const backendCommand = properties['kirosight.backendCommand'];
    const restricted = manifest.capabilities?.untrustedWorkspaces
      ?.restrictedConfigurations ?? [];

    expect(backendCommand?.type).toBe('string');
    expect(backendCommand?.default).toBe('');
    expect(backendCommand?.description).toBeTruthy();
    expect(backendCommand?.scope).toBe('machine');
    expect(restricted.filter((key) => key === 'kirosight.backendCommand')).toHaveLength(1);
    expect(backendCommand?.default).not.toMatch(/npm|pytest|vitest|uvicorn|python|node/i);
  });
  it('contributes trusted test settings and restricts command-bearing configuration', () => {
    const properties = manifest.contributes?.configuration?.properties ?? {};
    const testCommand = properties['kirosight.testCommand'];
    const timeout = properties['kirosight.testTimeoutSeconds'];
    const restricted = manifest.capabilities?.untrustedWorkspaces
      ?.restrictedConfigurations ?? [];

    expect(manifest.capabilities).toBeDefined();
    expect(manifest.capabilities?.untrustedWorkspaces).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(manifest.contributes ?? {}, 'capabilities')).toBe(false);

    expect(testCommand?.type).toBe('string');
    expect(testCommand?.default).toBe('');
    expect(testCommand?.description).toBeTruthy();
    expect(timeout?.type).toBe('integer');
    expect(timeout?.default).toBe(300);
    expect(timeout?.minimum).toBeGreaterThan(0);
    expect(restricted).toContain('kirosight.testCommand');
    expect(restricted).toContain('kirosight.backendCommand');
    expect(new Set(restricted).size).toBe(restricted.length);
  });

  it('does not contribute a runnable default command', () => {
    const testCommand = manifest.contributes?.configuration?.properties?.['kirosight.testCommand'];

    expect(testCommand?.default).not.toMatch(/npm|pytest|vitest|mocha|node/i);
  });
  it('packages the compiled output and the webview media assets', () => {
    const files = (JSON.parse(
      readFileSync(resolve(testDirectory, '../package.json'), 'utf8'),
    ) as { files?: string[] }).files ?? [];

    expect(files).toContain('dist');
    expect(files).toContain('media');
    for (const excluded of ['src', 'test', 'node_modules']) {
      expect(files).not.toContain(excluded);
    }
    expect(existsSync(resolve(testDirectory, '../media/main.js'))).toBe(true);
    expect(existsSync(resolve(testDirectory, '../media/styles.css'))).toBe(true);
  });

  it('matches the default keybinding to the recorded Spike A decision', () => {
    const activationBindings = (manifest.contributes?.keybindings ?? []).filter(
      (binding) => binding.command === 'kirosight.activate',
    );

    if (spikeAFoundNoConflict()) {
      expect(activationBindings).toEqual([
        {
          command: 'kirosight.activate',
          key: 'ctrl+alt+k',
          when: 'isWindows || isLinux',
        },
      ]);
    } else {
      expect(activationBindings).toEqual([]);
    }

    for (const binding of activationBindings) {
      expect(binding.mac).toBeUndefined();
      expect(binding.when).toBe('isWindows || isLinux');
    }
  });
});
