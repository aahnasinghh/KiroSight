import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ALLOWLIST } from '../../src/actions/allowlist';
import type { Action } from '../../src/actions/actionTypes';
import { validateAction } from '../../src/actions/actionValidator';

type FixtureEntry = {
  name: string;
  risk: string;
  parameters: string[];
};

type Fixture = { actions: FixtureEntry[] };

const fixturePath = resolve(__dirname, '../../src/protocol/fixtures/allowlist.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
const fixtureByName = Object.fromEntries(fixture.actions.map((entry) => [entry.name, entry]));
const FORBIDDEN_ACTIONS = ['RUN_COMMAND', 'GO_TO_SYMBOL'];

const parameterSamples: Record<string, unknown> = {
  index: 0,
  severity: 'error',
  path: 'src/a.ts',
  line: 1,
};

function actionWithFixtureParameters(entry: FixtureEntry): Record<string, unknown> {
  return {
    type: entry.name,
    ...Object.fromEntries(entry.parameters.map((name) => [name, parameterSamples[name]])),
  };
}

describe('backend/extension allow-list parity', () => {
  it('matches the canonical fixture names and risk classes exactly', () => {
    const fixtureNames = fixture.actions.map((entry) => entry.name).sort();
    const registryNames = Object.keys(ALLOWLIST).sort();

    expect(fixture.actions).toHaveLength(8);
    expect(registryNames).toHaveLength(8);
    expect(registryNames).toEqual(fixtureNames);
    expect(FORBIDDEN_ACTIONS.some((name) => fixtureNames.includes(name))).toBe(false);
    expect(FORBIDDEN_ACTIONS.some((name) => registryNames.includes(name))).toBe(false);

    const fixtureRisks = Object.fromEntries(
      fixture.actions.map((entry) => [entry.name, entry.risk]),
    );
    const registryRisks = Object.fromEntries(
      registryNames.map((name) => [name, ALLOWLIST[name as Action['type']].risk]),
    );
    expect(registryRisks).toEqual(fixtureRisks);
    expect(fixtureRisks.RUN_TESTS).toBe('needs-confirmation');
    expect(ALLOWLIST.RUN_TESTS.risk).toBe('needs-confirmation');
  });

  it('matches the fixture parameter names to the TypeScript action schemas', () => {
    for (const entry of fixture.actions) {
      const result = validateAction(actionWithFixtureParameters(entry), 'agent');
      expect(result.ok, entry.name).toBe(true);
    }

    expect(fixtureByName.NO_ACTION.parameters).toEqual([]);
    expect(fixtureByName.FOCUS_EDITOR.parameters).toEqual([]);
    expect(fixtureByName.RUN_TESTS.parameters).toEqual([]);
  });
});
