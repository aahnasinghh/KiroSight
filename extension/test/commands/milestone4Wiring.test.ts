import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { activate } from '../../src/extension';
import { REASONING_NOT_CONNECTED } from '../../src/pipeline/localIntentHandler';
import { DEFAULT_VOICE } from '../../src/webview/viewModel';
import { Uri, resetVscodeMock, vscodeMockState, type MockWebviewPanel } from '../mocks/vscode';

interface PostedEntry { seq: number; role: string; text: string; source?: string }
interface PostedViewState { type: string; statusKind: string; transcript: PostedEntry[]; latest: string | null }

function boot(): Array<{ dispose(): void }> {
  const subscriptions: Array<{ dispose(): void }> = [];
  activate({ subscriptions, extensionUri: Uri.file('/ext') } as unknown as Parameters<typeof activate>[0]);
  return subscriptions;
}

const command = (name: string) => vscodeMockState.registeredCommands.get(name)!;
const panel = (): MockWebviewPanel => vscodeMockState.webviewPanels[0];
const viewStates = (): PostedViewState[] =>
  panel().webview.posted.filter((message) => (message as { type: string }).type === 'view_state') as PostedViewState[];

/** Asks the open panel for its full state the way the webview does on load. */
async function readyTranscript(): Promise<PostedEntry[]> {
  await panel().receive({ type: 'ready' });
  return viewStates().at(-1)!.transcript;
}

describe('Milestone 4 wiring', () => {
  beforeEach(() => {
    resetVscodeMock();
  });

  it('opens one panel for kirosight.activate and reuses it', async () => {
    boot();

    await command('kirosight.activate')();
    await command('kirosight.activate')();

    expect(vscodeMockState.webviewPanels).toHaveLength(1);
    expect(panel().revealCalls).toEqual([[undefined, false]]);
    expect(panel().webview.posted).toEqual([{ type: 'focus_input' }]);
  });

  it('opens or focuses the panel for kirosight.ask and never uses an input box', async () => {
    boot();
    vscodeMockState.inputBoxResponses.push('where am i');

    await command('kirosight.ask')();
    await command('kirosight.ask')();

    expect(vscodeMockState.webviewPanels).toHaveLength(1);
    expect(vscodeMockState.inputBoxCalls).toEqual([]);
    expect(panel().webview.posted).toEqual([{ type: 'focus_input' }]);
  });

  it('routes each direct command through the pipeline, recording typed query and response', async () => {
    boot();
    await command('kirosight.activate')();

    await command('kirosight.whereAmI')();
    await command('kirosight.describeErrors')();
    await command('kirosight.nextError')();
    await command('kirosight.previousError')();

    const entries = (await readyTranscript()).filter((entry) => entry.role !== 'system');
    expect(entries.map(({ role, text }) => [role, text])).toEqual([
      ['user', 'where am I'],
      ['kirosight', 'No file is open.'],
      ['user', 'what errors are there'],
      ['kirosight', 'No diagnostics found.'],
      ['user', 'next error'],
      ['kirosight', 'No file is open.'],
      ['user', 'previous error'],
      ['kirosight', 'No file is open.'],
    ]);
    for (const entry of entries.filter((candidate) => candidate.role === 'user')) {
      expect(entry.source).toBe('typed');
    }
    const sequences = entries.map((entry) => entry.seq);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(vscodeMockState.outputChannels).toHaveLength(0);
    expect(vscodeMockState.notifications).toEqual([]);
  });

  it('sends state to an open panel immediately, before the command finishes', async () => {
    boot();
    await command('kirosight.activate')();

    const pending = command('kirosight.whereAmI')();
    expect(viewStates().at(-1)).toMatchObject({ statusKind: 'processing' });

    await pending;
    expect(viewStates().at(-1)).toMatchObject({ statusKind: 'idle', latest: 'No file is open.' });
    expect(viewStates().map((state) => state.statusKind)).toEqual(['processing', 'idle']);
  });

  it('keeps state from commands run while the panel is closed and returns it on ready', async () => {
    boot();

    await command('kirosight.whereAmI')();
    await command('kirosight.describeErrors')();
    expect(vscodeMockState.webviewPanels).toHaveLength(0);

    await command('kirosight.activate')();
    const transcript = await readyTranscript();

    expect(transcript.map(({ role, text }) => [role, text])).toEqual([
      ['user', 'where am I'],
      ['kirosight', 'No file is open.'],
      ['user', 'what errors are there'],
      ['kirosight', 'No diagnostics found.'],
      ['system', DEFAULT_VOICE.reasonText],
    ]);
    expect(viewStates().at(-1)).toMatchObject({ latest: 'No diagnostics found.' });
  });

  it('records the voice-unavailable notice once and never loses it', async () => {
    boot();
    await command('kirosight.activate')();
    await command('kirosight.activate')();
    await command('kirosight.ask')();

    await command('kirosight.whereAmI')();
    const transcript = await readyTranscript();
    const notices = transcript.filter((entry) => entry.text === DEFAULT_VOICE.reasonText);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ role: 'system' });
    expect(notices[0]).not.toHaveProperty('source');
    expect(viewStates().every((state) =>
      state.transcript.some((entry) => entry.text === DEFAULT_VOICE.reasonText))).toBe(true);
  });

  it('shares one transcript and pipeline between the webview and direct commands', async () => {
    boot();
    await command('kirosight.activate')();

    await panel().receive({ type: 'submit_text', submitId: 's1', text: 'explain this' });
    await command('kirosight.whereAmI')();
    const transcript = await readyTranscript();

    expect(panel().webview.posted).toContainEqual({ type: 'submit_ack', submitId: 's1', status: 'not_handled' });
    expect(transcript.filter((entry) => entry.role !== 'system').map((entry) => [entry.role, entry.text])).toEqual([
      ['user', 'explain this'],
      ['kirosight', REASONING_NOT_CONNECTED],
      ['user', 'where am I'],
      ['kirosight', 'No file is open.'],
    ]);
  });

  it('constructs exactly one transcript, pipeline and provider, and no generic command path', () => {
    const source = readFileSync(resolvePath(__dirname, '../../src/extension.ts'), 'utf8');

    for (const constructor of ['TranscriptStore', 'InputPipeline', 'WebviewProvider']) {
      expect(source.match(new RegExp(`new ${constructor}\\(`, 'g'))).toHaveLength(1);
    }
    expect(source).not.toMatch(/showInputBox|executeCommand|ResponseSink|OutputChannel/);
  });
});
