import { beforeEach, describe, expect, it } from 'vitest';

import { read } from '../../src/testing/testCommandConfig';
import { resetVscodeMock, setMockConfiguration } from '../mocks/vscode';

describe('testCommandConfig.read', () => {
  beforeEach(() => {
    resetVscodeMock();
  });

  it('takes no parameters and reads the namespaced VS Code setting', () => {
    expect(read.length).toBe(0);
    setMockConfiguration({ 'kirosight.testCommand': 'npm.cmd test' });

    expect(read()).toBe('npm.cmd test');
  });

  it.each([
    ['  npm.cmd test', 'npm.cmd test'],
    ['npm.cmd test  ', 'npm.cmd test'],
    ['  npm.cmd test -- --runInBand  ', 'npm.cmd test -- --runInBand'],
  ])('trims only outer whitespace: %j', (configured, expected) => {
    setMockConfiguration({ 'kirosight.testCommand': configured });

    expect(read()).toBe(expected);
  });

  it('preserves internal spaces, quotes, casing, slashes and backslashes', () => {
    const configured = '  NPM.CMD test -- "Case Sensitive" C:\\fixture path\\tests /tmp/Auth.ts  ';
    setMockConfiguration({ 'kirosight.testCommand': configured });

    expect(read()).toBe('NPM.CMD test -- "Case Sensitive" C:\\fixture path\\tests /tmp/Auth.ts');
  });

  it.each([undefined, '', '   ', '\t\r\n'])('returns empty for missing or blank settings: %j', (configured) => {
    if (configured === undefined) {
      setMockConfiguration({});
    } else {
      setMockConfiguration({ 'kirosight.testCommand': configured });
    }

    expect(read()).toBe('');
  });

  it('does not invent a fallback command', () => {
    setMockConfiguration({});

    expect(read()).not.toMatch(/npm|pytest|vitest|mocha/);
    expect(read()).toBe('');
  });
});
