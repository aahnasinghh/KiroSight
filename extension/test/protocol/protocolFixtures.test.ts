import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BACKEND_MESSAGE_TYPES } from '../../src/protocol/constants';
import { validateProtocolMessage } from '../../src/protocol/validators';

/**
 * Task 6.9: the shared protocol fixtures. The Python backend validates these exact same files
 * (backend/tests/test_protocol_fixtures.py). They are hand-written contract samples, never
 * generated from either implementation.
 */
const fixtureDirectory = resolve(__dirname, '../../src/protocol/fixtures/messages');
const expectedFilenames = BACKEND_MESSAGE_TYPES.map((type) => `${type}.json`).sort();

function loadFixture(filename: string): unknown {
  return JSON.parse(readFileSync(resolve(fixtureDirectory, filename), 'utf8'));
}

describe('shared protocol message fixtures', () => {
  it('contains exactly one fixture for each of the fourteen message types', () => {
    expect(expectedFilenames).toHaveLength(14);
    expect(readdirSync(fixtureDirectory).sort()).toEqual(expectedFilenames);
  });

  it.each(expectedFilenames)('%s validates as its message type', (filename) => {
    const raw = loadFixture(filename);
    const result = validateProtocolMessage(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe(1);
      expect(result.value.type).toBe(filename.replace(/\.json$/, ''));
      expect(result.value).toEqual(raw);
    }
  });

  it.each(expectedFilenames)('%s contains no secret-shaped or absolute-path content', (filename) => {
    const text = readFileSync(resolve(fixtureDirectory, filename), 'utf8');
    for (const forbidden of ['AKIA', 'eyJ', 'sk-', 'C:\\\\', '/home/', '/Users/', 'activeFile']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
