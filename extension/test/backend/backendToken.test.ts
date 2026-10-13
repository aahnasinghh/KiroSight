import { describe, expect, it } from 'vitest';

import {
  BACKEND_TOKEN_INPUT_OPTIONS,
  BACKEND_TOKEN_SECRET_KEY,
  promptForBackendToken,
  readBackendToken,
} from '../../src/backend/backendToken';
import { FakeSecrets } from '../mocks/fakeSecrets';

const SENTINEL = 'SUPER_SECRET_BACKEND_TOKEN_123';

describe('readBackendToken', () => {
  it('returns undefined when nothing is stored (a backend without auth needs no token)', async () => {
    expect(await readBackendToken(new FakeSecrets())).toBeUndefined();
  });

  it('returns the stored token exactly as stored, without trimming', async () => {
    const secrets = new FakeSecrets({ [BACKEND_TOKEN_SECRET_KEY]: ` ${SENTINEL} ` });
    expect(await readBackendToken(secrets)).toBe(` ${SENTINEL} `);
    expect(secrets.calls).toEqual([{ method: 'get', key: 'kirosight.backendToken' }]);
  });

  it('treats an empty or unreadable secret as no token and never throws', async () => {
    expect(await readBackendToken(new FakeSecrets({ [BACKEND_TOKEN_SECRET_KEY]: '' }))).toBeUndefined();
    const failing = { get: () => Promise.reject(new Error('boom')), store: async () => undefined, delete: async () => undefined };
    expect(await readBackendToken(failing)).toBeUndefined();
    expect(await readBackendToken(undefined as never)).toBeUndefined();
  });
});

describe('promptForBackendToken', () => {
  function run(response: string | undefined, secrets = new FakeSecrets()) {
    const optionsSeen: unknown[] = [];
    const result = promptForBackendToken({
      secrets,
      showInputBox: (options) => {
        optionsSeen.push(options);
        return Promise.resolve(response);
      },
    });
    return { result, secrets, optionsSeen };
  }

  it('asks with a masked input box that is never prefilled with the current token', async () => {
    const { result, optionsSeen } = run(undefined, new FakeSecrets({ [BACKEND_TOKEN_SECRET_KEY]: SENTINEL }));
    await result;

    expect(optionsSeen).toEqual([BACKEND_TOKEN_INPUT_OPTIONS]);
    expect(BACKEND_TOKEN_INPUT_OPTIONS.password).toBe(true);
    expect(BACKEND_TOKEN_INPUT_OPTIONS).not.toHaveProperty('value');
    expect(JSON.stringify(BACKEND_TOKEN_INPUT_OPTIONS)).not.toContain(SENTINEL);
  });

  it('stores a typed token exactly as entered under the one stable key', async () => {
    const { result, secrets } = run(`  ${SENTINEL}  `);

    expect(await result).toBe('stored');
    expect(secrets.values.get('kirosight.backendToken')).toBe(`  ${SENTINEL}  `);
    expect(secrets.calls).toEqual([{ method: 'store', key: 'kirosight.backendToken' }]);
  });

  it('changes nothing when the input box is cancelled', async () => {
    const { result, secrets } = run(undefined, new FakeSecrets({ [BACKEND_TOKEN_SECRET_KEY]: SENTINEL }));

    expect(await result).toBe('cancelled');
    expect(secrets.calls).toEqual([]);
    expect(secrets.values.get(BACKEND_TOKEN_SECRET_KEY)).toBe(SENTINEL);
  });

  it('clears the token for an empty submission instead of storing an empty secret', async () => {
    const { result, secrets } = run('', new FakeSecrets({ [BACKEND_TOKEN_SECRET_KEY]: SENTINEL }));

    expect(await result).toBe('cleared');
    expect(secrets.values.has(BACKEND_TOKEN_SECRET_KEY)).toBe(false);
    expect(secrets.calls).toEqual([{ method: 'delete', key: 'kirosight.backendToken' }]);
  });

  it('reports a storage failure without throwing or echoing the token', async () => {
    const secrets = new FakeSecrets();
    secrets.failStore = true;
    const { result } = run(SENTINEL, secrets);

    const outcome = await result;
    expect(outcome).toBe('failed');
    expect(outcome).not.toContain(SENTINEL);
  });
});
