import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { classifyReply } from '../../src/confirmation/replyClassifier';

/**
 * Speech-to-text with smart formatting punctuates what it hears: "Confirm.", "Yes!", "Repeat.".
 * Sentence-boundary punctuation around an otherwise exact phrase is accepted. Nothing else changes:
 * the vocabulary is the same twelve phrases, extra words never match, and a confirmation phrased as
 * a question is not an approval.
 *
 * Defects these would catch: a spoken reply never recognized; the vocabulary quietly growing; an
 * embedded or negated instruction counting as consent; a question approving an action.
 */
const VOCABULARY = [
  'confirm', 'yes', 'go ahead', 'approve', 'decline', 'no', 'cancel', 'stop', 'never mind',
  'repeat', 'say that again', 'what is waiting',
];

describe('classifyReply: punctuation at the ends of an exact phrase', () => {
  it.each([
    ['Confirm.', 'confirm'],
    ['Yes!', 'confirm'],
    ['Go ahead.', 'confirm'],
    ['Approve!', 'confirm'],
    ['  Yes,  ', 'confirm'],
    ['... yes', 'confirm'],
    ['Decline.', 'decline'],
    ['No.', 'decline'],
    ['Cancel.', 'cancel'],
    ['Stop!', 'cancel'],
    ['Never mind.', 'cancel'],
    ['Repeat.', 'repeat'],
    ['Say that again?', 'repeat'],
    ['What is waiting?', 'repeat'],
    ['Say that again.', 'repeat'],
  ] as const)('classifies %j as %s', (text, expected) => {
    expect(classifyReply(text)).toBe(expected);
  });

  it('every approved phrase still classifies the same without punctuation', () => {
    const expected: Record<string, string> = {
      confirm: 'confirm', yes: 'confirm', 'go ahead': 'confirm', approve: 'confirm', decline: 'decline',
      no: 'decline', cancel: 'cancel', stop: 'cancel', 'never mind': 'cancel', repeat: 'repeat',
      'say that again': 'repeat', 'what is waiting': 'repeat',
    };
    for (const phrase of VOCABULARY) {
      expect(classifyReply(phrase)).toBe(expected[phrase]);
      expect(classifyReply(`${phrase}.`)).toBe(expected[phrase]);
    }
  });
});

describe('classifyReply: unsafe or unrelated speech is not a reply', () => {
  it.each([
    'yes please run something else',
    'Yes, please run something else.',
    "don't confirm",
    "Don't confirm.",
    'do not confirm!',
    'not confirm',
    'confirm and delete files',
    'Confirm and delete files.',
    'Confirm. Delete files.',
    'Confirm. Confirm.',
    'Confirm, then run it.',
    'Yes, run it.',
    'please confirm',
    'unconfirm.',
    'confirmed.',
    'okay.',
    'Just do it!',
    'no way.',
    'repeat that.',
    'do not cancel.',
    '',
    '   ',
    '.',
    '...',
    '!?',
  ])('%j is unrecognized', (text) => {
    expect(classifyReply(text)).toBe('unrecognized');
  });

  it('a confirmation written as a question does not approve anything', () => {
    for (const text of ['Confirm?', 'Yes?', 'Go ahead?', 'Approve?', 'yes ?', 'Confirm.?']) {
      expect(classifyReply(text)).toBe('unrecognized');
    }
  });

  it('a question is still fine for the replies that approve nothing', () => {
    expect(classifyReply('Decline?')).toBe('decline');
    expect(classifyReply('Cancel?')).toBe('cancel');
    expect(classifyReply('Repeat?')).toBe('repeat');
  });
});

describe('classifyReply: the vocabulary does not grow', () => {
  it('property: anything recognized is exactly an approved phrase once end punctuation is removed', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (text) => {
        const reply = classifyReply(text);
        if (reply === 'unrecognized') return;
        const core = text.toLocaleLowerCase().replace(/^[\s.,!?;]+|[\s.,!?;]+$/g, '').replace(/\s+/g, ' ');
        expect(VOCABULARY).toContain(core);
      }),
      { numRuns: 500 },
    );
  });

  it('property: an approved phrase with any extra word before or after it is never recognized', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VOCABULARY),
        fc.stringMatching(/^[a-z]{1,10}$/),
        fc.boolean(),
        fc.constantFrom('', '.', '!', ','),
        (phrase, word, before, mark) => {
          const text = before ? `${word} ${phrase}${mark}` : `${phrase} ${word}${mark}`;
          expect(classifyReply(text)).toBe('unrecognized');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('property: punctuation INSIDE an approved phrase is not stripped', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('go ahead', 'never mind', 'say that again', 'what is waiting'),
        fc.constantFrom('.', ',', '!', '?'),
        (phrase, mark) => {
          const index = phrase.indexOf(' ');
          const broken = `${phrase.slice(0, index)}${mark} ${phrase.slice(index + 1)}`;
          expect(classifyReply(broken)).toBe('unrecognized');
        },
      ),
    );
  });

  it('is deterministic', () => {
    expect(classifyReply('Confirm.')).toBe(classifyReply('Confirm.'));
  });
});
