import { readFileSync } from 'node:fs';
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

interface ExtensionManifest {
  readonly activationEvents?: readonly string[];
  readonly contributes?: {
    readonly commands?: readonly CommandContribution[];
    readonly keybindings?: readonly KeybindingContribution[];
    readonly menus?: {
      readonly commandPalette?: ReadonlyArray<{
        readonly command: string;
        readonly when?: string;
      }>;
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
