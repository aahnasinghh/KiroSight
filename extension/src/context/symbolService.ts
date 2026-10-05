import type {
  EditorAdapter,
  Pos,
  SymbolNode,
  SymbolQueryResult,
} from './editorAdapter';

export type SymbolLookupResult =
  | { status: 'found'; symbol: SymbolNode; nodes: SymbolNode[] }
  | { status: 'none_enclosing' }
  | { status: 'provider_unavailable' };

const TOTAL_LOOKUP_BUDGET_MS = 1500;
const MAX_ATTEMPTS = 2;

function comparePos(left: Pos, right: Pos): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.column - right.column;
}

function contains(range: SymbolNode['range'], position: Pos): boolean {
  return comparePos(range.start, position) <= 0 && comparePos(position, range.end) < 0;
}

function rangeSize(range: SymbolNode['range']): [number, number] {
  return [range.end.line - range.start.line, range.end.column - range.start.column];
}

function isSmallerRange(left: SymbolNode, right: SymbolNode): boolean {
  const [leftLines, leftColumns] = rangeSize(left.range);
  const [rightLines, rightColumns] = rangeSize(right.range);
  return leftLines < rightLines ||
    (leftLines === rightLines && leftColumns < rightColumns);
}

/** Recursively flattens nested provider results without changing symbol ranges. */
export function flattenSymbols(nodes: readonly SymbolNode[]): SymbolNode[] {
  return nodes.flatMap((node) => [
    { ...node, children: [] },
    ...flattenSymbols(node.children),
  ]);
}

/** Finds the innermost symbol containing a 1-indexed position. */
export function findEnclosingSymbol(
  nodes: readonly SymbolNode[],
  position: Pos,
): SymbolNode | null {
  let best: SymbolNode | null = null;

  const visit = (node: SymbolNode): void => {
    if (contains(node.range, position) && (best === null || isSmallerRange(node, best))) {
      best = node;
    }

    for (const child of node.children) {
      visit(child);
    }
  };

  for (const node of nodes) {
    visit(node);
  }

  return best;
}

function remainingBudget(deadline: number): number {
  return Math.max(0, deadline - performance.now());
}

export class SymbolService {
  public constructor(private readonly adapter: EditorAdapter) {}

  /**
   * Looks up the enclosing symbol without moving the editor or guessing from text.
   * The deadline covers both attempts combined.
   */
  public async lookup(fsPath: string, position: Pos): Promise<SymbolLookupResult> {
    const query = await this.query(fsPath);
    if (query.status === 'provider_unavailable' || query.status === 'none_enclosing') {
      return query;
    }

    const symbol = findEnclosingSymbol(query.nodes, position);
    return symbol === null
      ? { status: 'none_enclosing' }
      : { status: 'found', symbol, nodes: query.nodes };
  }

  /** Returns normalized flat symbols while preserving provider failure status. */
  public async query(fsPath: string): Promise<SymbolQueryResult> {
    const deadline = performance.now() + TOTAL_LOOKUP_BUDGET_MS;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const remaining = remainingBudget(deadline);
      if (remaining <= 0) {
        return { status: 'provider_unavailable' };
      }

      let result: SymbolQueryResult | 'timeout';
      try {
        result = await this.withTimeout(
          this.adapter.documentSymbols(fsPath),
          remaining,
        );
      } catch {
        result = { status: 'provider_unavailable' };
      }

      if (result === 'timeout') {
        return { status: 'provider_unavailable' };
      }
      if (result.status === 'found') {
        return { status: 'found', nodes: flattenSymbols(result.nodes) };
      }
      if (result.status !== 'provider_unavailable') {
        return result;
      }
    }

    return { status: 'provider_unavailable' };
  }

  private async withTimeout(
    request: Promise<SymbolQueryResult>,
    timeoutMs: number,
  ): Promise<SymbolQueryResult | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    try {
      return await Promise.race([request, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
