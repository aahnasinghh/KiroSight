import type { CodeExcerpt, EditorSnapshot } from './editorAdapter';

export const MAX_EXCERPT_LINES = 80;
export const MAX_EXCERPT_CHARS = 6000;
export const CURSOR_WINDOW_RADIUS = 10;
export const DIAGNOSTIC_WINDOW_RADIUS = 5;
export const MAX_DIAGNOSTICS_SENT = 25;
export const MAX_DIAGNOSTIC_MESSAGE_CHARS = 500;

type LineRange = {
  startLine: number;
  endLine: number;
};

type LineEntry = {
  line: number;
  text: string;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizeRange(range: LineRange, lineCount: number): LineRange {
  const startLine = clamp(Math.min(range.startLine, range.endLine), 1, lineCount);
  const endLine = clamp(Math.max(range.startLine, range.endLine), 1, lineCount);
  return { startLine, endLine };
}

function chooseAnchor(
  range: LineRange,
  diagnosticLine: number | null,
  cursorLine: number | null,
  fallbackLine: number,
): number {
  for (const candidate of [diagnosticLine, cursorLine, fallbackLine]) {
    if (candidate !== null && candidate >= range.startLine && candidate <= range.endLine) {
      return candidate;
    }
  }
  return range.startLine;
}

function limitLines(range: LineRange, anchorLine: number): { range: LineRange; truncated: boolean } {
  if (range.endLine - range.startLine + 1 <= MAX_EXCERPT_LINES) {
    return { range, truncated: false };
  }

  let startLine = Math.max(range.startLine, anchorLine - Math.floor(MAX_EXCERPT_LINES / 2));
  let endLine = startLine + MAX_EXCERPT_LINES - 1;

  if (endLine > range.endLine) {
    endLine = range.endLine;
    startLine = endLine - MAX_EXCERPT_LINES + 1;
  }

  return {
    range: { startLine, endLine },
    truncated: true,
  };
}

function textLength(entries: readonly LineEntry[]): number {
  return entries.reduce((length, entry, index) => length + entry.text.length + (index === 0 ? 0 : 1), 0);
}

function trimToCharacters(
  entries: readonly LineEntry[],
  anchorLine: number,
): { entries: LineEntry[]; truncated: boolean } {
  if (textLength(entries) <= MAX_EXCERPT_CHARS) {
    return { entries: [...entries], truncated: false };
  }

  const anchorIndex = Math.max(
    0,
    entries.findIndex((entry) => entry.line === anchorLine),
  );
  const selected: LineEntry[] = [entries[anchorIndex]];
  let truncated = true;

  if (selected[0].text.length > MAX_EXCERPT_CHARS) {
    selected[0] = {
      ...selected[0],
      text: selected[0].text.slice(0, MAX_EXCERPT_CHARS),
    };
    return { entries: selected, truncated };
  }

  let left = anchorIndex - 1;
  let right = anchorIndex + 1;

  while (left >= 0 || right < entries.length) {
    let changed = false;

    if (left >= 0 && textLength(selected) < MAX_EXCERPT_CHARS) {
      const available = MAX_EXCERPT_CHARS - textLength(selected) - 1;
      if (available > 0) {
        const entry = entries[left];
        selected.unshift({
          line: entry.line,
          text: entry.text.length <= available ? entry.text : entry.text.slice(-available),
        });
        left -= 1;
        changed = true;
        if (entry.text.length > available) {
          break;
        }
      }
    }

    if (right < entries.length && textLength(selected) < MAX_EXCERPT_CHARS) {
      const available = MAX_EXCERPT_CHARS - textLength(selected) - 1;
      if (available > 0) {
        const entry = entries[right];
        selected.push({
          line: entry.line,
          text: entry.text.length <= available ? entry.text : entry.text.slice(0, available),
        });
        right += 1;
        changed = true;
        if (entry.text.length > available) {
          break;
        }
      }
    }

    if (!changed) {
      break;
    }
  }

  return {
    entries: selected.sort((leftEntry, rightEntry) => leftEntry.line - rightEntry.line),
    truncated,
  };
}

/**
 * Selects a bounded excerpt using selection, symbol, then cursor-window precedence.
 * All line values are 1-indexed. A null snapshot produces no excerpt.
 */
export function selectExcerpt(
  snapshot: EditorSnapshot | null,
  enclosingSymbol: LineRange | null = null,
  diagnosticLine: number | null = null,
): CodeExcerpt | null {
  if (snapshot === null || snapshot.file === null || snapshot.file.lineCount < 1) {
    return null;
  }

  const lineCount = snapshot.file.lineCount;
  const cursorLine = snapshot.cursor?.line ?? null;
  let source: CodeExcerpt['source'];
  let requestedRange: LineRange;
  let fallbackLine: number;

  if (snapshot.selection !== null) {
    source = 'selection';
    requestedRange = {
      startLine: snapshot.selection.start.line,
      endLine: snapshot.selection.end.line,
    };
    fallbackLine = requestedRange.startLine;
  } else if (enclosingSymbol !== null) {
    source = 'symbol';
    requestedRange = enclosingSymbol;
    fallbackLine = requestedRange.startLine;
  } else {
    source = 'cursor_window';
    const anchorLine = diagnosticLine ?? cursorLine;
    if (anchorLine === null) {
      return null;
    }
    requestedRange = {
      startLine: anchorLine - (diagnosticLine === null ? CURSOR_WINDOW_RADIUS : DIAGNOSTIC_WINDOW_RADIUS),
      endLine: anchorLine + (diagnosticLine === null ? CURSOR_WINDOW_RADIUS : DIAGNOSTIC_WINDOW_RADIUS),
    };
    fallbackLine = anchorLine;
  }

  const normalizedRange = normalizeRange(requestedRange, lineCount);
  const anchorLine = chooseAnchor(normalizedRange, diagnosticLine, cursorLine, fallbackLine);
  const lineLimited = limitLines(normalizedRange, anchorLine);
  const lines = snapshot.getLines(lineLimited.range.startLine, lineLimited.range.endLine)
    .map((text, index) => ({ line: lineLimited.range.startLine + index, text }));
  const charLimited = trimToCharacters(lines, anchorLine);

  return {
    source,
    startLine: charLimited.entries[0]?.line ?? lineLimited.range.startLine,
    endLine: charLimited.entries.at(-1)?.line ?? lineLimited.range.endLine,
    text: charLimited.entries.map((entry) => entry.text).join('\n').slice(0, MAX_EXCERPT_CHARS),
    truncated: lineLimited.truncated || charLimited.truncated || textLength(lines) !== textLength(charLimited.entries),
  };
}
