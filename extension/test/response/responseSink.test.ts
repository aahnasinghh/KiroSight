import { beforeEach, describe, expect, it } from 'vitest';

import { VscodeResponseSink } from '../../src/response/responseSink';
import { resetVscodeMock, vscodeMockState } from '../mocks/vscode';

describe('VscodeResponseSink', () => {
  beforeEach(() => {
    resetVscodeMock();
  });

  it('writes, shows, and notifies with the same complete response without disposing the channel', () => {
    const channel = {
      name: 'KiroSight',
      lines: [] as string[],
      showCalls: [] as Array<boolean | undefined>,
      disposed: false,
      appendLine(line: string) {
        this.lines.push(line);
      },
      show(preserveFocus?: boolean) {
        this.showCalls.push(preserveFocus);
      },
      dispose() {
        this.disposed = true;
      },
    };
    const text = 'You are editing src/login.ts at line 32, column 5.';
    const sink = new VscodeResponseSink(channel as never);

    sink.send(text);

    expect(channel.lines).toEqual([text]);
    expect(channel.showCalls).toEqual([true]);
    expect(vscodeMockState.notifications).toEqual([text]);
    expect(channel.disposed).toBe(false);
  });
});
