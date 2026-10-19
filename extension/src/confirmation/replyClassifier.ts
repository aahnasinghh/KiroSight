/** The four accepted pending-confirmation replies, or anything else. */
export type ConfirmationReply = 'confirm' | 'decline' | 'cancel' | 'repeat' | 'unrecognized';

/**
 * The documented whole-utterance phrases from the approved design
 * (design.md, ConfirmationManager): confirm, yes, go ahead, approve; decline, no;
 * cancel, stop, never mind; repeat, say that again, what is waiting.
 */
const PHRASES: ReadonlyMap<string, Exclude<ConfirmationReply, 'unrecognized'>> = new Map([
  ['confirm', 'confirm'],
  ['yes', 'confirm'],
  ['go ahead', 'confirm'],
  ['approve', 'confirm'],
  ['decline', 'decline'],
  ['no', 'decline'],
  ['cancel', 'cancel'],
  ['stop', 'cancel'],
  ['never mind', 'cancel'],
  ['repeat', 'repeat'],
  ['say that again', 'repeat'],
  ['what is waiting', 'repeat'],
]);

/**
 * Sentence-boundary punctuation that may surround an otherwise exact phrase. Speech-to-text with
 * smart formatting punctuates what it hears ("Confirm.", "Yes!", "Repeat."), so a spoken reply
 * would never match if these were kept. Only these characters, and only at the two ends, are
 * removed: punctuation inside the utterance, other characters, extra words and filler are not.
 */
const BOUNDARY_PUNCTUATION = /^[\s.,!?;]+|[\s.,!?;]+$/g;

/** Case, whitespace, and sentence-boundary punctuation at the ends. No filler removal or fuzzy matching. */
function normalizeReply(text: string): string {
  return text.toLocaleLowerCase().replace(BOUNDARY_PUNCTUATION, '').replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic and pure: the complete normalized utterance must equal an approved
 * phrase. Substrings, prefixes and suffixes never match.
 *
 * A confirmation written as a question ("Confirm?", "Yes?") is not an approval: it asks, it does
 * not answer. It stays unrecognized, so the action keeps waiting. Questions are accepted for
 * decline, cancel and repeat ("Say that again?"), which approve nothing.
 */
export function classifyReply(text: string): ConfirmationReply {
  const reply = PHRASES.get(normalizeReply(text)) ?? 'unrecognized';
  if (reply === 'confirm' && text.includes('?')) return 'unrecognized';
  return reply;
}
