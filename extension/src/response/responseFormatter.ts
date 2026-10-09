import type { ActionResult, ActionResultDetails } from '../actions/actionResult';

function displayPath(path: string): string {
  return /^(?:[A-Za-z]:[\\/]|[\\]{2}|\/)/.test(path) ? 'the selected file' : path;
}

function formatDetails(details: ActionResultDetails): string {
  switch (details.kind) {
    case 'file_opened':
      return `Opened ${displayPath(details.relativePath)}.`;
    case 'diagnostic_reached': {
      const location = `${displayPath(details.relativePath)}, line ${details.line}`;
      const symbol = details.symbol === undefined ? '' : `, in ${details.symbol}`;
      const prefix = details.wrapped === true ? 'Wrapped to' : 'Moved to';
      return `${prefix} ${details.severity} diagnostic at ${location}${symbol}: ${details.message}`;
    }
    case 'location_reached':
      return `Moved to ${displayPath(details.relativePath)}, line ${details.line}.`;
    case 'ambiguous_files': {
      const paths = details.matches.map(displayPath).join('; ');
      const total = details.totalMatches > details.matches.length
        ? ` There are ${details.totalMatches} matches in total.`
        : '';
      return `The file request is ambiguous. Matches: ${paths}.${total}`;
    }
  }
}

/** Purely formats an ActionResult; it performs no I/O or execution. */
export function formatActionResult(result: ActionResult): string {
  if (result.status === 'ok' && result.details !== undefined) {
    return formatDetails(result.details);
  }

  if (result.status === 'ok') {
    return result.message;
  }

  if (result.status === 'needs_clarification' && result.details?.kind === 'ambiguous_files') {
    return formatDetails(result.details);
  }

  if (result.status === 'declined') {
    return `Action declined: ${result.message}`;
  }

  if (result.status === 'not_permitted') {
    return `Action not permitted: ${result.message}`;
  }

  if (result.status === 'not_configured') {
    return `Action is not configured: ${result.message}`;
  }

  return result.message;
}
