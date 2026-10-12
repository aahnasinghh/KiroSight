import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import type { SubmitAckStatus } from '../../src/pipeline/inputPipeline';
import { validateHostToWebviewMessage } from '../../src/protocol/bridgeMessages';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import { WebviewProvider, type PipelinePort } from '../../src/webview/webviewProvider';
import { DEFAULT_VOICE, createViewModel } from '../../src/webview/viewModel';
import { Uri, resetVscodeMock, vscodeMockState, type MockWebviewPanel } from '../mocks/vscode';

const testDirectory = dirname(fileURLToPath(import.meta.url));

function setup(handleStatus: SubmitAckStatus = 'handled') {
  const transcript = new TranscriptStore();
  const calls = { handle: [] as Array<[string, string]>, confirm: 0, decline: 0, interrupt: 0 };
  const pipeline: PipelinePort = {
    handle: async (text, source) => {
      calls.handle.push([text, source]);
      return handleStatus;
    },
    confirm: async () => { calls.confirm += 1; },
    decline: async () => { calls.decline += 1; },
    interrupt: () => { calls.interrupt += 1; },
  };
  const provider = new WebviewProvider({
    extensionUri: Uri.file('/ext') as never,
    pipeline,
    transcript,
    getViewModel: () => createViewModel({ transcript: transcript.getEntries() }),
  });

  return { provider, transcript, calls };
}

function panel(index = 0): MockWebviewPanel {
  return vscodeMockState.webviewPanels[index];
}

function nonceOf(html: string): string {
  return html.match(/script-src 'nonce-([^']+)'/)?.[1] ?? '';
}

describe('WebviewProvider', () => {
  beforeEach(() => {
    resetVscodeMock();
  });

  it('creates one panel on first open and reuses it with focus on repeat opens', () => {
    const { provider } = setup();

    provider.openOrFocus();
    expect(panel().webview.posted).toEqual([]);

    provider.openOrFocus();
    provider.openOrFocus();

    expect(vscodeMockState.webviewPanels).toHaveLength(1);
    expect(panel().revealCalls).toEqual([[undefined, false], [undefined, false]]);
  });

  it('requests command-input focus on every explicit re-activation of an open panel', async () => {
    const { provider, transcript } = setup();
    provider.openOrFocus();
    const entriesBefore = transcript.getEntries();

    provider.openOrFocus();
    provider.openOrFocus();

    expect(panel().webview.posted).toEqual([{ type: 'focus_input' }, { type: 'focus_input' }]);
    for (const message of panel().webview.posted) {
      expect(validateHostToWebviewMessage(message).ok).toBe(true);
    }
    expect(vscodeMockState.webviewPanels).toHaveLength(1);
    expect(transcript.getEntries()).toEqual(entriesBefore);
    expect(vscodeMockState.executedCommands).toEqual([]);

    // The focus request carries no view state, so it cannot reset the draft or the view.
    await panel().receive({ type: 'ready' });
    expect(panel().webview.posted.at(-1)).toMatchObject({ type: 'view_state' });
  });

  it('does not request input focus for a newly created panel or after dispose', () => {
    const { provider } = setup();

    provider.openOrFocus();
    panel().dispose();
    provider.openOrFocus();

    expect(vscodeMockState.webviewPanels).toHaveLength(2);
    expect(panel(0).webview.posted).toEqual([]);
    expect(panel(1).webview.posted).toEqual([]);
  });

  it('creates the panel with narrow, script-enabled, context-retaining options', () => {
    const { provider } = setup();

    provider.openOrFocus();

    expect(panel().options).toMatchObject({
      enableScripts: true,
      enableCommandUris: false,
      retainContextWhenHidden: true,
    });
    expect(panel().options.localResourceRoots).toHaveLength(1);
    expect(panel().options.localResourceRoots?.[0].path).toBe('/ext/media');
    expect(panel().showOptions).toMatchObject({ preserveFocus: false });
  });

  it('builds html from cspSource and asWebviewUri assets with a nonce CSP', () => {
    const { provider } = setup();

    provider.openOrFocus();

    const html = panel().webview.html;
    expect(html).toContain("style-src 'self' https://*.vscode-cdn.net;");
    expect(html).toContain('href="mock-uri:webview:/ext/media/styles.css"');
    expect(html).toContain('src="mock-uri:webview:/ext/media/main.js"');
    expect(nonceOf(html).length).toBeGreaterThan(0);
    expect(html).toContain(`<script nonce="${nonceOf(html)}"`);
    expect(html).not.toContain('connect-src');
    expect(html).not.toContain('file://');
  });

  it('clears the panel on dispose and builds a new panel with a new nonce on reopen', () => {
    const { provider } = setup();

    provider.openOrFocus();
    panel().dispose();
    provider.openOrFocus();

    expect(vscodeMockState.webviewPanels).toHaveLength(2);
    expect(panel(1).webview.html).not.toBe('');
    expect(nonceOf(panel(1).webview.html)).not.toBe(nonceOf(panel(0).webview.html));
  });

  it('posts the complete current view state on ready, repeatedly and validly', async () => {
    const { provider, transcript } = setup();
    provider.openOrFocus();

    await panel().receive({ type: 'ready' });
    await panel().receive({ type: 'ready' });

    const expected = { type: 'view_state', ...createViewModel({ transcript: transcript.getEntries() }) };
    expect(panel().webview.posted).toEqual([expected, expected]);
    expect(validateHostToWebviewMessage(panel().webview.posted[0]).ok).toBe(true);
  });

  it('routes submit_text to the pipeline once and acknowledges with the same submitId', async () => {
    for (const status of ['handled', 'not_handled', 'discarded'] as const) {
      resetVscodeMock();
      const { provider, calls } = setup(status);
      provider.openOrFocus();

      await panel().receive({ type: 'submit_text', submitId: 'abc-1', text: '  where am I  ' });

      expect(calls.handle).toEqual([['  where am I  ', 'typed']]);
      expect(panel().webview.posted).toEqual([{ type: 'submit_ack', submitId: 'abc-1', status }]);
      expect(validateHostToWebviewMessage(panel().webview.posted[0]).ok).toBe(true);
    }
  });

  it('acknowledges not_handled when the pipeline rejects, without leaking the error', async () => {
    const transcript = new TranscriptStore();
    const provider = new WebviewProvider({
      extensionUri: Uri.file('/ext') as never,
      pipeline: {
        handle: async () => { throw new Error('secret internal detail'); },
        confirm: async () => undefined,
        decline: async () => undefined,
        interrupt: () => undefined,
      },
      transcript,
      getViewModel: () => createViewModel(),
    });
    provider.openOrFocus();

    await expect(panel().receive({ type: 'submit_text', submitId: 's1', text: 'x' })).resolves.toBeUndefined();

    expect(panel().webview.posted).toEqual([{ type: 'submit_ack', submitId: 's1', status: 'not_handled' }]);
    expect(JSON.stringify(panel().webview.posted)).not.toContain('secret');
  });

  it('forwards confirm, decline and interrupt exactly once each', async () => {
    const { provider, calls } = setup();
    provider.openOrFocus();

    await panel().receive({ type: 'confirm' });
    await panel().receive({ type: 'decline' });
    await panel().receive({ type: 'interrupt' });

    expect(calls).toMatchObject({ confirm: 1, decline: 1, interrupt: 1, handle: [] });
    expect(panel().webview.posted).toEqual([]);
  });

  it('discards unknown, malformed, over-specified and primitive messages without any effect', async () => {
    const { provider, transcript, calls } = setup();
    provider.openOrFocus();
    const entriesBefore = transcript.getEntries();
    const invalid: unknown[] = [
      { type: 'run_command', command: 'rm -rf /' },
      { type: 'submit_text', text: 'no id' },
      { type: 'submit_text', submitId: 's', text: 7 },
      { type: 'confirm', extra: true },
      { type: 'ready', token: 'abc' },
      null, undefined, 'ready', 42, true, [], [{ type: 'ready' }], {},
    ];

    for (const raw of invalid) {
      await expect(panel().receive(raw)).resolves.toBeUndefined();
    }

    expect(calls).toEqual({ handle: [], confirm: 0, decline: 0, interrupt: 0 });
    expect(panel().webview.posted).toEqual([]);
    expect(transcript.getEntries()).toEqual(entriesBefore);
    expect(vscodeMockState.executedCommands).toEqual([]);
  });

  it('ignores future voice and playback messages in Milestone 4', async () => {
    const { provider, transcript, calls } = setup();
    provider.openOrFocus();
    const entriesBefore = transcript.getEntries();

    await panel().receive({ type: 'ptt_toggle' });
    await panel().receive({ type: 'audio_clip', clipId: 'c', mimeType: 'audio/webm', base64: 'AAEC' });
    await panel().receive({ type: 'mic_state', state: 'granted' });
    await panel().receive({ type: 'playback', state: 'started', id: 'p' });

    expect(calls).toEqual({ handle: [], confirm: 0, decline: 0, interrupt: 0 });
    expect(panel().webview.posted).toEqual([]);
    expect(transcript.getEntries()).toEqual(entriesBefore);
  });

  it('records the voice-unavailable notice once per provider, not per focus', () => {
    const { provider, transcript } = setup();

    provider.openOrFocus();
    provider.openOrFocus();
    panel().dispose();
    provider.openOrFocus();

    expect(transcript.getEntries()).toEqual([
      { seq: 1, role: 'system', text: DEFAULT_VOICE.reasonText },
    ]);
    expect(transcript.getEntries()[0]).not.toHaveProperty('source');
  });

  it('posts a full view state on update only while a panel exists', () => {
    const { provider } = setup();
    const model = createViewModel({ statusKind: 'processing' });

    provider.updateViewModel(model);
    expect(vscodeMockState.webviewPanels).toHaveLength(0);

    provider.openOrFocus();
    provider.updateViewModel(model);
    expect(panel().webview.posted).toEqual([{ type: 'view_state', ...model }]);

    panel().dispose();
    expect(() => provider.updateViewModel(model)).not.toThrow();
    expect(panel().webview.posted).toHaveLength(1);
  });

  it('does not deliver messages from a disposed panel', async () => {
    const { provider, calls } = setup();
    provider.openOrFocus();
    const first = panel();
    first.dispose();

    await first.receive({ type: 'confirm' });

    expect(calls.confirm).toBe(0);
  });

  it('has no command-execution, network, or credential path', () => {
    const source = readFileSync(resolve(testDirectory, '../../src/webview/webviewProvider.ts'), 'utf8');

    expect(source).not.toMatch(/executeCommand|fetch\(|WebSocket|process\.env|token|secret|apiKey/i);
  });
});
