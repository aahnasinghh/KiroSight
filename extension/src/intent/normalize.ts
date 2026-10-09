const LEADING_FILLERS = ['please', 'can you', 'could you', 'kirosight'] as const;

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
  fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
  first: '1', second: '2', third: '3',
};

/** Normalizes only the conservative transformations approved by the design. */
export function normalize(utterance: string): string {
  let value = utterance
    .toLocaleLowerCase()
    .trim()
    // Keep filename/path punctuation; normalize sentence punctuation to separators.
    .replace(/[!?;,:[\]{}()"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let changed = true;
  while (changed) {
    changed = false;
    for (const filler of LEADING_FILLERS) {
      if (value === filler) {
        value = '';
        changed = true;
      } else if (value.startsWith(`${filler} `)) {
        value = value.slice(filler.length + 1).trim();
        changed = true;
      }
    }
  }

  return value
    .split(' ')
    .map((token) => NUMBER_WORDS[token] ?? token)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
