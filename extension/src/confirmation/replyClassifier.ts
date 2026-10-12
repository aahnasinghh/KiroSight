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

/** Case and whitespace only. No filler removal, punctuation stripping or fuzzy matching. */
function normalizeReply(text: string): string {
  return text.toLocaleLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Deterministic and pure: the complete normalized utterance must equal an approved
 * phrase. Substrings, prefixes and suffixes never match.
 */
export function classifyReply(text: string): ConfirmationReply {
  return PHRASES.get(normalizeReply(text)) ?? 'unrecognized';
}
