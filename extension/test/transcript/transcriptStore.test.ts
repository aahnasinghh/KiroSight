import { describe, expect, it } from 'vitest';

import {
  TranscriptStore,
  type TranscriptEntry,
} from '../../src/transcript/transcriptStore';

describe('TranscriptStore', () => {
  it('assigns the first sequence and preserves one appended entry', () => {
    const store = new TranscriptStore();

    const entry = store.append('user', 'Where am I?', 'typed');

    expect(entry).toEqual({
      seq: 1,
      role: 'user',
      text: 'Where am I?',
      source: 'typed',
    });
    expect(store.getEntries()).toEqual([entry]);
  });

  it('preserves insertion order with strictly increasing sequences', () => {
    const store = new TranscriptStore();

    store.append('user', 'first');
    store.append('kirosight', 'second');
    store.append('system', 'third');

    const entries = store.getEntries();
    expect(entries.map((entry) => entry.text)).toEqual(['first', 'second', 'third']);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(entries[1].seq).toBeGreaterThan(entries[0].seq);
    expect(entries[2].seq).toBeGreaterThan(entries[1].seq);
  });

  it('accepts all roles and preserves typed, voice, and omitted sources', () => {
    const store = new TranscriptStore();

    store.append('user', 'typed query', 'typed');
    store.append('user', 'voice query', 'voice');
    store.append('kirosight', 'response');
    store.append('system', 'system message');

    expect(store.getEntries()).toEqual([
      { seq: 1, role: 'user', text: 'typed query', source: 'typed' },
      { seq: 2, role: 'user', text: 'voice query', source: 'voice' },
      { seq: 3, role: 'kirosight', text: 'response' },
      { seq: 4, role: 'system', text: 'system message' },
    ]);
  });

  it('preserves text exactly, including empty and whitespace text', () => {
    const store = new TranscriptStore();
    const texts = ['', '  keep whitespace  ', 'line one\nline two'];

    for (const text of texts) {
      store.append('system', text);
    }

    expect(store.getEntries().map((entry) => entry.text)).toEqual(texts);
  });

  it('does not expose mutable internal entries or the internal array', () => {
    const store = new TranscriptStore();
    store.append('user', 'original');

    const snapshot = store.getEntries();
    const mutableSnapshot = snapshot as TranscriptEntry[];
    mutableSnapshot.pop();
    mutableSnapshot.push({ seq: 999, role: 'system', text: 'injected' });

    expect(store.getEntries()).toEqual([
      { seq: 1, role: 'user', text: 'original' },
    ]);
    expect(Object.isFrozen(store.getEntries()[0])).toBe(true);
  });

  it('does not change earlier entries after later appends', () => {
    const store = new TranscriptStore();
    store.append('user', 'earlier', 'typed');
    const beforeLaterAppend = store.getEntries();

    store.append('kirosight', 'later');

    expect(beforeLaterAppend).toEqual([
      { seq: 1, role: 'user', text: 'earlier', source: 'typed' },
    ]);
    expect(store.getEntries()[0]).toEqual(beforeLaterAppend[0]);
  });

  it('owns sequence assignment instead of accepting caller-provided sequence data', () => {
    const store = new TranscriptStore();

    const entry = store.append('user', 'caller cannot choose seq');

    expect(entry.seq).toBe(1);
    expect(entry).not.toHaveProperty('requestedSeq');
    expect(entry).not.toHaveProperty('seqOverride');
    expect(store.append('system', 'next').seq).toBe(2);
  });

  it('keeps sequence state independent between store instances', () => {
    const first = new TranscriptStore();
    const second = new TranscriptStore();

    expect(first.append('user', 'first').seq).toBe(1);
    expect(first.append('system', 'second').seq).toBe(2);
    expect(second.append('user', 'independent').seq).toBe(1);
    expect(second.getEntries()).toEqual([
      { seq: 1, role: 'user', text: 'independent' },
    ]);
  });
});
