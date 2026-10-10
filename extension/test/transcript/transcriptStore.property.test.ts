import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  TranscriptStore,
  type TranscriptEntry,
  type TranscriptRole,
  type TranscriptSource,
} from '../../src/transcript/transcriptStore';

interface AppendOperation {
  readonly role: TranscriptRole;
  readonly text: string;
  readonly source?: TranscriptSource;
}

const roleArb = fc.constantFrom<TranscriptRole>('user', 'kirosight', 'system');
const sourceArb = fc.option(
  fc.constantFrom<TranscriptSource>('typed', 'voice'),
  { nil: undefined },
);
const textArb = fc.oneof(
  fc.constant(''),
  fc.constant('   '),
  fc.constant('line one\nline two'),
  fc.constant('punctuation: !?.,;:'),
  fc.string({ maxLength: 80 }),
);
const operationArb: fc.Arbitrary<AppendOperation> = fc.record({
  role: roleArb,
  text: textArb,
  source: sourceArb,
});
const operationsArb = fc.array(operationArb, { minLength: 0, maxLength: 50 });
const nonEmptyOperationsArb = fc.array(operationArb, { minLength: 1, maxLength: 50 });

function appendOperations(store: TranscriptStore, operations: readonly AppendOperation[]): void {
  for (const operation of operations) {
    store.append(operation.role, operation.text, operation.source);
  }
}

function expectOperationContent(
  entry: TranscriptEntry,
  operation: AppendOperation,
): void {
  expect(entry.role).toBe(operation.role);
  expect(entry.text).toBe(operation.text);

  if (operation.source === undefined) {
    expect(entry).not.toHaveProperty('source');
  } else {
    expect(entry.source).toBe(operation.source);
  }

  if (entry.source !== undefined) {
    expect(['typed', 'voice']).toContain(entry.source);
  }
}

describe('TranscriptStore Property 24', () => {
  it('is append-only after every generated append', () => {
    fc.assert(
      fc.property(operationsArb, (operations) => {
        const store = new TranscriptStore();
        let previousEntries: readonly TranscriptEntry[] = [];

        for (const operation of operations) {
          const entryCountBefore = previousEntries.length;
          const appendedSnapshot = store.getEntries();
          const entry = store.append(operation.role, operation.text, operation.source);
          const currentEntries = store.getEntries();

          expect(currentEntries).toHaveLength(entryCountBefore + 1);
          expect(currentEntries.slice(0, entryCountBefore)).toEqual(appendedSnapshot);
          expect(currentEntries.slice(0, entryCountBefore)).toEqual(previousEntries);
          expect(currentEntries.at(-1)).toEqual(entry);
          previousEntries = currentEntries;
        }
      }),
      { numRuns: 100 },
    );
  });

  it('keeps sequences integral, unique, strictly increasing, and insertion-ordered', () => {
    fc.assert(
      fc.property(nonEmptyOperationsArb, (operations) => {
        const store = new TranscriptStore();
        appendOperations(store, operations);
        const entries = store.getEntries();
        const sequences = entries.map((entry) => entry.seq);

        expect(sequences.every((seq) => Number.isInteger(seq))).toBe(true);
        expect(new Set(sequences).size).toBe(sequences.length);
        for (let index = 1; index < sequences.length; index += 1) {
          expect(sequences[index]).toBeGreaterThan(sequences[index - 1]);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('preserves every generated role, text, and optional source exactly', () => {
    fc.assert(
      fc.property(operationsArb, (operations) => {
        const store = new TranscriptStore();
        appendOperations(store, operations);
        const entries = store.getEntries();

        expect(entries).toHaveLength(operations.length);
        entries.forEach((entry, index) => {
          expectOperationContent(entry, operations[index]);
        });
      }),
      { numRuns: 100 },
    );
  });

  it('keeps prior snapshots unchanged when later entries are appended', () => {
    fc.assert(
      fc.property(
        operationsArb,
        operationsArb,
        (initialOperations, laterOperations) => {
          const store = new TranscriptStore();
          appendOperations(store, initialOperations);
          const snapshot = store.getEntries();

          appendOperations(store, laterOperations);

          expect(snapshot).toHaveLength(initialOperations.length);
          snapshot.forEach((entry, index) => {
            expectOperationContent(entry, initialOperations[index]);
          });
          expect(store.getEntries().slice(0, snapshot.length)).toEqual(snapshot);
          expect(store.getEntries()).toHaveLength(
            initialOperations.length + laterOperations.length,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('isolates mutations to returned arrays and freezes stored entries', () => {
    fc.assert(
      fc.property(nonEmptyOperationsArb, (operations) => {
        const store = new TranscriptStore();
        appendOperations(store, operations);
        const before = store.getEntries();
        const expected = before.slice();
        const exposedArray = before as TranscriptEntry[];

        exposedArray.reverse();
        exposedArray.pop();
        exposedArray.push({ seq: 999, role: 'system', text: 'injected' });

        const after = store.getEntries();
        expect(after).toEqual(expected);
        expect(after).toHaveLength(operations.length);
        expect(after.every((entry) => Object.isFrozen(entry))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('keeps two stores independent with independent sequence state', () => {
    fc.assert(
      fc.property(operationsArb, operationsArb, (firstOperations, secondOperations) => {
        const first = new TranscriptStore();
        const second = new TranscriptStore();
        appendOperations(first, firstOperations);
        const secondBeforeFirstAppend = second.getEntries();
        appendOperations(second, secondOperations);
        const firstAfterSecondAppend = first.getEntries();

        expect(secondBeforeFirstAppend).toEqual([]);
        expect(firstAfterSecondAppend).toEqual(first.getEntries());
        expect(first.getEntries()).toHaveLength(firstOperations.length);
        expect(second.getEntries()).toHaveLength(secondOperations.length);
        if (firstOperations.length > 0) {
          expect(first.getEntries()[0].seq).toBe(1);
        }
        if (secondOperations.length > 0) {
          expect(second.getEntries()[0].seq).toBe(1);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('is deterministic for identical generated operation sequences', () => {
    fc.assert(
      fc.property(operationsArb, (operations) => {
        const first = new TranscriptStore();
        const second = new TranscriptStore();

        appendOperations(first, operations);
        appendOperations(second, operations);

        expect(second.getEntries()).toEqual(first.getEntries());
      }),
      { numRuns: 100 },
    );
  });

  it('keeps sequence ownership independent from generated content', () => {
    fc.assert(
      fc.property(operationsArb, (operations) => {
        const store = new TranscriptStore();
        appendOperations(store, operations);
        const entries = store.getEntries();

        entries.forEach((entry, index) => {
          expect(entry.seq).toBeGreaterThan(0);
          if (index > 0) {
            expect(entry.seq).toBeGreaterThan(entries[index - 1].seq);
          }
        });
      }),
      { numRuns: 100 },
    );
  });
});
