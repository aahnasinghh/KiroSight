import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Action } from '../../src/actions/actionTypes';
import {
  ConfirmationManager,
  type ConfirmationRequestInput,
} from '../../src/confirmation/confirmationManager';
import { formatConfirmation, formatConfirmationReprompt } from '../../src/response/responseFormatter';

const RUN_TESTS: Action = { type: 'RUN_TESTS' };

function req(id: string, target = 'npm.cmd test', origin: 'local' | 'agent' = 'local'): ConfirmationRequestInput {
  return { action: RUN_TESTS, target, origin, correlationId: id };
}

function ids(manager: ConfirmationManager): string[] {
  return manager.queued().map((r) => r.correlationId);
}

describe('ConfirmationManager requests', () => {
  it('makes the first request the sole pending request with its stored full prompt', () => {
    const manager = new ConfirmationManager();
    const outcome = manager.request(req('A'));

    expect(outcome.kind).toBe('pending');
    expect(manager.pending()?.correlationId).toBe('A');
    expect(manager.pending()?.prompt).toBe(formatConfirmation(RUN_TESTS, 'npm.cmd test'));
    expect(manager.queued()).toEqual([]);
  });

  it('holds later requests in FIFO order without replacing the pending one', () => {
    const manager = new ConfirmationManager();
    manager.request(req('A'));
    const b = manager.request(req('B'));
    const c = manager.request(req('C'));

    expect(b).toMatchObject({ kind: 'queued', position: 1 });
    expect(c).toMatchObject({ kind: 'queued', position: 2 });
    expect(manager.pending()?.correlationId).toBe('A');
    expect(ids(manager)).toEqual(['B', 'C']);
  });

  it('preserves origin, correlation id and resolved target on every request', () => {
    const manager = new ConfirmationManager();
    manager.request(req('A', 'npm.cmd test', 'agent'));
    manager.request(req('B', 'pytest -q', 'local'));

    expect(manager.pending()).toMatchObject({ origin: 'agent', correlationId: 'A', target: 'npm.cmd test' });
    expect(manager.queued()[0]).toMatchObject({ origin: 'local', correlationId: 'B', target: 'pytest -q' });
  });
});

describe('ConfirmationManager replies', () => {
  it('CONFIRM resolves exactly the pending request and promotes the next one FIFO', () => {
    const manager = new ConfirmationManager();
    manager.request(req('A', 'cmd A', 'agent'));
    manager.request(req('B'));
    manager.request(req('C'));

    const outcome = manager.handleReply('confirm');

    expect(outcome).toMatchObject({ kind: 'confirmed', request: { correlationId: 'A', target: 'cmd A', origin: 'agent' } });
    expect(outcome.kind === 'confirmed' && outcome.next?.correlationId).toBe('B');
    expect(manager.pending()?.correlationId).toBe('B');
    expect(ids(manager)).toEqual(['C']);
  });

  it('DECLINE resolves negatively, runs nothing and promotes the next', () => {
    const manager = new ConfirmationManager();
    manager.request(req('A'));
    manager.request(req('B'));

    const outcome = manager.handleReply('no');

    expect(outcome).toMatchObject({ kind: 'declined', reason: 'declined', request: { correlationId: 'A' } });
    expect(manager.pending()?.correlationId).toBe('B');
  });

  it('CANCEL has the same state transition as DECLINE and differs only in the reason', () => {
    const run = (reply: string) => {
      const manager = new ConfirmationManager();
      manager.request(req('A'));
      manager.request(req('B'));
      manager.request(req('C'));
      const outcome = manager.handleReply(reply);
      return { outcome, pending: manager.pending()?.correlationId, queue: ids(manager) };
    };
    const declined = run('decline');
    const cancelled = run('cancel');

    expect(cancelled.pending).toBe(declined.pending);
    expect(cancelled.queue).toEqual(declined.queue);
    expect(cancelled.outcome).toMatchObject({ kind: 'declined', reason: 'cancelled', request: { correlationId: 'A' } });
    expect(declined.outcome).toMatchObject({ kind: 'declined', reason: 'declined' });
    expect(cancelled.pending).toBe('B');
    expect(cancelled.queue).toEqual(['C']);
  });

  it('leaves the manager idle after the last request resolves', () => {
    const manager = new ConfirmationManager();
    manager.request(req('A'));
    const outcome = manager.handleReply('confirm');

    expect(outcome).toMatchObject({ kind: 'confirmed', next: null });
    expect(manager.pending()).toBeNull();
  });

  it('REPEAT returns the exact stored prompt and changes nothing', () => {
    const manager = new ConfirmationManager();
    manager.request(req('A'));
    manager.request(req('B'));
    manager.request(req('C'));
    const storedPrompt = manager.pending()!.prompt;

    for (const phrase of ['repeat', 'say that again', 'what is waiting']) {
      const outcome = manager.handleReply(phrase);
      expect(outcome).toMatchObject({ kind: 'repeated', text: storedPrompt });
      expect(manager.pending()?.correlationId).toBe('A');
      expect(ids(manager)).toEqual(['B', 'C']);
    }
  });

  it('answers any other text with the concise re-prompt and resolves nothing', () => {
    const manager = new ConfirmationManager();
    manager.request(req('A'));
    manager.request(req('B'));

    for (const text of ['go to line 10', 'what errors are there', 'please confirm', '']) {
      const outcome = manager.handleReply(text);
      expect(outcome).toMatchObject({ kind: 'reprompt', text: formatConfirmationReprompt(RUN_TESTS) });
    }
    expect(manager.pending()?.correlationId).toBe('A');
    expect(ids(manager)).toEqual(['B']);
  });

  it('ignores every reply when nothing is pending', () => {
    const manager = new ConfirmationManager();

    for (const text of ['confirm', 'yes', 'ok', 'just do it', 'decline', 'cancel', 'repeat', 'go to line 3', '']) {
      expect(manager.handleReply(text)).toEqual({ kind: 'ignored' });
    }
    expect(manager.confirm()).toEqual({ kind: 'ignored' });
    expect(manager.decline()).toEqual({ kind: 'ignored' });
    expect(manager.pending()).toBeNull();
    expect(manager.queued()).toEqual([]);
  });

  it('does not remember an idle affirmative for a later request', () => {
    const manager = new ConfirmationManager();
    manager.handleReply('confirm');
    manager.handleReply('yes');
    manager.request(req('A'));

    expect(manager.pending()?.correlationId).toBe('A');
    expect(manager.handleReply('go to line 1').kind).toBe('reprompt');
    expect(manager.pending()?.correlationId).toBe('A');
  });

  it('requires a fresh CONFIRM for a later request after an earlier one was confirmed', () => {
    const manager = new ConfirmationManager();
    manager.request(req('A'));
    manager.handleReply('confirm');
    manager.request(req('B'));

    expect(manager.pending()?.correlationId).toBe('B');
  });
});

describe('ConfirmationManager direct entry points', () => {
  it('confirm() and decline() match the text transitions', () => {
    const build = () => {
      const manager = new ConfirmationManager();
      manager.request(req('A'));
      manager.request(req('B'));
      return manager;
    };

    const viaText = build();
    const viaButton = build();
    expect(viaButton.confirm()).toEqual(viaText.handleReply('confirm'));
    expect(viaButton.pending()).toEqual(viaText.pending());

    const declineText = build();
    const declineButton = build();
    expect(declineButton.decline()).toEqual(declineText.handleReply('decline'));
    expect(declineButton.pending()).toEqual(declineText.pending());
  });
});

describe('ConfirmationManager target changes', () => {
  function withTarget(initial: string) {
    const state = { target: initial };
    const manager = new ConfirmationManager((action) => (action.type === 'RUN_TESTS' ? state.target : undefined));
    return { manager, state };
  }

  it('never confirms a stale target and presents the new one for a fresh CONFIRM', () => {
    const { manager, state } = withTarget('npm.cmd test');
    manager.request(req('A', 'npm.cmd test', 'agent'));
    state.target = 'npm.cmd test -- --coverage';

    const first = manager.handleReply('confirm');

    expect(first.kind).toBe('retargeted');
    expect(first.kind === 'retargeted' && first.text).toBe(
      formatConfirmation(RUN_TESTS, 'npm.cmd test -- --coverage'),
    );
    expect(manager.pending()).toMatchObject({
      target: 'npm.cmd test -- --coverage', origin: 'agent', correlationId: 'A',
    });

    const second = manager.handleReply('confirm');
    expect(second).toMatchObject({ kind: 'confirmed', request: { target: 'npm.cmd test -- --coverage' } });
  });

  it('also refreshes on button confirm', () => {
    const { manager, state } = withTarget('npm.cmd test');
    manager.request(req('A'));
    state.target = 'npm.cmd run ci';

    expect(manager.confirm()).toMatchObject({
      kind: 'retargeted', text: formatConfirmation(RUN_TESTS, 'npm.cmd run ci'),
    });
  });

  it('repeat with an unchanged target returns the exact stored prompt and changes nothing', () => {
    const { manager } = withTarget('npm.cmd test');
    manager.request(req('A', 'npm.cmd test', 'agent'));
    manager.request(req('B'));
    const before = manager.pending()!;

    const outcome = manager.handleReply('repeat');

    expect(outcome.kind === 'repeated' && outcome.text).toBe(before.prompt);
    expect(manager.pending()).toBe(before);
    expect(ids(manager)).toEqual(['B']);
  });

  it('repeat after the live target changes still returns the original stored prompt', () => {
    let resolverCalls = 0;
    const state = { target: 'npm.cmd test' };
    const manager = new ConfirmationManager((action) => {
      resolverCalls += 1;
      return action.type === 'RUN_TESTS' ? state.target : undefined;
    });
    manager.request(req('A', 'npm.cmd test', 'agent'));
    manager.request(req('B'));
    manager.request(req('C'));
    const before = manager.pending()!;
    const originalPrompt = formatConfirmation(RUN_TESTS, 'npm.cmd test');
    state.target = 'npm.cmd test -- --coverage';
    resolverCalls = 0;

    for (const phrase of ['repeat', 'say that again', 'what is waiting']) {
      const outcome = manager.handleReply(phrase);
      expect(outcome.kind).toBe('repeated');
      expect(outcome.kind === 'repeated' && outcome.text).toBe(originalPrompt);
    }

    expect(resolverCalls).toBe(0);
    expect(manager.pending()).toBe(before);
    expect(manager.pending()).toMatchObject({
      target: 'npm.cmd test', prompt: originalPrompt, origin: 'agent', correlationId: 'A',
    });
    expect(ids(manager)).toEqual(['B', 'C']);
  });

  it('confirm after that repeat retargets, and only a second confirm resolves', () => {
    const { manager, state } = withTarget('npm.cmd test');
    manager.request(req('A', 'npm.cmd test', 'agent'));
    manager.request(req('B'));
    state.target = 'npm.cmd test -- --coverage';
    manager.handleReply('repeat');

    const first = manager.handleReply('confirm');

    expect(first.kind).toBe('retargeted');
    expect(first.kind === 'retargeted' && first.text).toBe(
      formatConfirmation(RUN_TESTS, 'npm.cmd test -- --coverage'),
    );
    expect(manager.pending()).toMatchObject({
      target: 'npm.cmd test -- --coverage', origin: 'agent', correlationId: 'A',
    });
    expect(ids(manager)).toEqual(['B']);

    const second = manager.handleReply('confirm');

    expect(second).toMatchObject({
      kind: 'confirmed', request: { correlationId: 'A', target: 'npm.cmd test -- --coverage' },
    });
    expect(manager.pending()?.correlationId).toBe('B');
  });

  it('repeat never changes FIFO order, with or without a target change', () => {
    const { manager, state } = withTarget('npm.cmd test');
    manager.request(req('A'));
    manager.request(req('B'));
    manager.request(req('C'));
    manager.request(req('D'));

    manager.handleReply('repeat');
    state.target = 'changed';
    manager.handleReply('repeat');
    manager.handleReply('repeat');

    expect(manager.pending()?.correlationId).toBe('A');
    expect(ids(manager)).toEqual(['B', 'C', 'D']);
  });

  it('does not reorder the queue when the pending target changes', () => {
    const { manager, state } = withTarget('npm.cmd test');
    manager.request(req('A'));
    manager.request(req('B'));
    manager.request(req('C'));
    state.target = 'npm.cmd run other';

    manager.handleReply('confirm');

    expect(manager.pending()?.correlationId).toBe('A');
    expect(ids(manager)).toEqual(['B', 'C']);
  });

  it('presents a queued request with the live target when it is promoted', () => {
    const { manager, state } = withTarget('npm.cmd test');
    manager.request(req('A'));
    manager.request(req('B'));
    state.target = 'npm.cmd run later';

    const outcome = manager.handleReply('decline');

    expect(outcome.kind === 'declined' && outcome.next).toMatchObject({
      correlationId: 'B', target: 'npm.cmd run later',
      prompt: formatConfirmation(RUN_TESTS, 'npm.cmd run later'),
    });
  });

  it('lets decline and cancel resolve even when the target changed', () => {
    const { manager, state } = withTarget('npm.cmd test');
    manager.request(req('A'));
    state.target = 'changed';

    expect(manager.handleReply('cancel')).toMatchObject({ kind: 'declined', reason: 'cancelled' });
    expect(manager.pending()).toBeNull();
  });
});

describe('ConfirmationManager ownership and timing', () => {
  it('does not let callers mutate internal state', () => {
    const manager = new ConfirmationManager();
    const action: Action = { type: 'RUN_TESTS' };
    manager.request({ action, target: 'npm.cmd test', origin: 'local', correlationId: 'A' });
    manager.request(req('B'));
    manager.request(req('C'));

    const view = manager.queued() as unknown as unknown[];
    expect(() => view.reverse()).toThrow();
    expect(() => view.push(1)).toThrow();
    expect(() => { (manager.pending() as { target: string }).target = 'hacked'; }).toThrow();
    expect(() => { (manager.pending()!.action as { type: string }).type = 'NO_ACTION'; }).toThrow();
    expect(ids(manager)).toEqual(['B', 'C']);
    expect(manager.pending()?.target).toBe('npm.cmd test');
    expect(Object.isFrozen(action)).toBe(false);
  });

  it('uses no timers, clocks or expiry', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['confirmationManager.ts', 'replyClassifier.ts']) {
      const source = readFileSync(resolve(here, '../../src/confirmation', file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/setTimeout|setInterval|Date\.now|new Date|performance\.now|\bexpir|\bttl\b/i);
    }
  });

  it('stays pending no matter how many unrelated replies arrive', () => {
    const manager = new ConfirmationManager();
    manager.request(req('A'));
    for (let i = 0; i < 1000; i += 1) {
      manager.handleReply(`unrelated ${i}`);
    }
    expect(manager.pending()?.correlationId).toBe('A');
  });
});
