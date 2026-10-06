import { beforeEach, describe, expect, it } from 'vitest';

import { activate } from '../src/extension';
import { resetVscodeMock, vscodeMockState } from './mocks/vscode';

interface DisposableLike {
  dispose(): void;
}

describe('extension activation', () => {
  beforeEach(() => {
    resetVscodeMock();
  });

  it('registers and invokes kirosight.activate without a keybinding dependency', async () => {
    const subscriptions: DisposableLike[] = [];
    const context = { subscriptions } as Parameters<typeof activate>[0];

    activate(context);

    expect(vscodeMockState.outputChannels).toHaveLength(1);
    expect(vscodeMockState.outputChannels[0].name).toBe('KiroSight');
    expect(vscodeMockState.registeredCommands.has('kirosight.activate')).toBe(true);
    expect(vscodeMockState.registeredCommands.has('kirosight.whereAmI')).toBe(true);
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0]).toBe(vscodeMockState.outputChannels[0]);

    const handler = vscodeMockState.registeredCommands.get('kirosight.activate');
    expect(handler).toBeTypeOf('function');
    await expect(Promise.resolve(handler?.())).resolves.toBeUndefined();

    expect(vscodeMockState.outputChannels[0].lines).toEqual(['KiroSight is active.']);
    expect(vscodeMockState.outputChannels[0].showCalls).toEqual([true]);

    const whereAmIHandler = vscodeMockState.registeredCommands.get('kirosight.whereAmI');
    expect(whereAmIHandler).toBeTypeOf('function');
    await expect(Promise.resolve(whereAmIHandler?.())).resolves.toBeUndefined();

    expect(vscodeMockState.outputChannels).toHaveLength(1);
    expect(vscodeMockState.outputChannels[0].lines).toEqual([
      'KiroSight is active.',
      'No file is open.',
    ]);
    expect(vscodeMockState.outputChannels[0].showCalls).toEqual([true, true]);

    for (const subscription of subscriptions) {
      subscription.dispose();
    }

    expect(vscodeMockState.outputChannels[0].disposed).toBe(true);
    expect(vscodeMockState.registeredCommands.has('kirosight.activate')).toBe(false);
    expect(vscodeMockState.registeredCommands.has('kirosight.whereAmI')).toBe(false);
  });
});
