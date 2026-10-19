import { describe, expect, it } from 'vitest';

import { classifyReply } from '../../src/confirmation/replyClassifier';

describe('classifyReply', () => {
  it.each([
    ['confirm', 'confirm'], ['yes', 'confirm'], ['go ahead', 'confirm'], ['approve', 'confirm'],
    ['decline', 'decline'], ['no', 'decline'],
    ['cancel', 'cancel'], ['stop', 'cancel'], ['never mind', 'cancel'],
    ['repeat', 'repeat'], ['say that again', 'repeat'], ['what is waiting', 'repeat'],
  ] as const)('classifies %j as %s', (text, expected) => {
    expect(classifyReply(text)).toBe(expected);
  });

  it('normalizes case, surrounding whitespace and inner whitespace only', () => {
    expect(classifyReply('  CONFIRM  ')).toBe('confirm');
    expect(classifyReply('Go   Ahead')).toBe('confirm');
    expect(classifyReply('\tNever\nMind ')).toBe('cancel');
  });

  it.each([
    'confirm this other thing', 'please confirm', 'confirmation', 'yes please', 'no way',
    // 'confirm.' and 'yes!' used to be listed here. Sentence-boundary punctuation around an exact
    // phrase is now accepted (see replyClassifierPunctuation.test.ts), because speech-to-text
    // punctuates what it hears. Extra words are still rejected.
    'do not cancel', 'repeat that', 'okay', 'ok', 'just do it', 'unconfirm',
    'go', 'ahead', 'never', 'mind', 'what is', 'say that',
  ])('does not match a partial or extended utterance: %j', (text) => {
    expect(classifyReply(text)).toBe('unrecognized');
  });

  it('treats empty, whitespace and ordinary commands as unrecognized', () => {
    for (const text of ['', '   ', '\n', 'go to line 10', 'what errors are there', 'run tests']) {
      expect(classifyReply(text)).toBe('unrecognized');
    }
  });

  it('is deterministic', () => {
    expect(classifyReply('Yes')).toBe(classifyReply('Yes'));
  });
});
