import { beforeEach, describe, expect, it } from 'vitest';

import { activate } from '../src/extension';
import { Uri, editorMockState, resetEditorMock, resetVscodeMock, vscodeMockState } from './mocks/vscode';

interface DisposableLike {
  dispose(): void;
}

function boot(): DisposableLike[] {
  const subscriptions: DisposableLike[] = [];
  activate({ subscriptions, extensionUri: Uri.file('/ext') } as unknown as Parameters<typeof activate>[0]);
  return subscriptions;
}

describe('extension activation', () => {
  beforeEach(() => {
    resetVscodeMock();
    resetEditorMock();
  });

  it('activates, registers its commands, and creates no panel until asked', () => {
    const subscriptions = boot();

    expect(vscodeMockState.registeredCommands.has('kirosight.activate')).toBe(true);
    expect(vscodeMockState.registeredCommands.has('kirosight.whereAmI')).toBe(true);
    expect(vscodeMockState.webviewPanels).toHaveLength(0);
    expect(vscodeMockState.outputChannels).toHaveLength(0);
    // command registrations, panel, and the single editor adapter
    expect(subscriptions).toHaveLength(3);
    expect(editorMockState.activeListeners).toHaveLength(1);
  });

  it('opens the KiroSight panel for kirosight.activate and reuses it on repeat', async () => {
    boot();
    const handler = vscodeMockState.registeredCommands.get('kirosight.activate');

    await expect(Promise.resolve(handler?.())).resolves.toBeUndefined();
    await expect(Promise.resolve(handler?.())).resolves.toBeUndefined();

    expect(vscodeMockState.webviewPanels).toHaveLength(1);
    expect(vscodeMockState.webviewPanels[0].title).toBe('KiroSight');
    expect(vscodeMockState.webviewPanels[0].revealCalls).toEqual([[undefined, false]]);
  });

  it('disposes its command registrations and panel with the extension', async () => {
    const subscriptions = boot();
    await vscodeMockState.registeredCommands.get('kirosight.activate')?.();

    for (const subscription of subscriptions) {
      subscription.dispose();
    }

    expect(vscodeMockState.webviewPanels[0].disposed).toBe(true);
    expect(vscodeMockState.registeredCommands.has('kirosight.activate')).toBe(false);
    expect(vscodeMockState.registeredCommands.has('kirosight.whereAmI')).toBe(false);
  });
});
