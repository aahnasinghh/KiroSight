import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { FileMatch } from '../../src/context/editorAdapter';
import { FileService } from '../../src/navigation/fileService';
import { FakeEditorAdapter } from '../context/fakeEditorAdapter';

const DIRECTORIES = ['src', 'test', 'lib/shared', 'packages/core'] as const;
const BASENAMES = ['auth.ts', 'main.ts', 'index.ts', 'fixture.test.ts'] as const;
const QUERIES = ['auth.ts', 'src/auth.ts', 'index.ts', 'fixture.test.ts'] as const;
const NO_MATCH = { status: 'not_found' } as const;

const relativePathArb = fc.record({
  directory: fc.constantFrom(...DIRECTORIES),
  basename: fc.constantFrom(...BASENAMES),
}).map(({ directory, basename }) => `${directory}/${basename}`);

const fileMatchArb: fc.Arbitrary<FileMatch> = relativePathArb.map((relativePath) => ({
  fsPath: `C:/workspace/${relativePath}`,
  relativePath,
}));

const queryArb = fc.constantFrom(...QUERIES);
const matchListArb = fc.array(fileMatchArb, { minLength: 0, maxLength: 20 });
const nonEmptyMatchListArb = fc.array(fileMatchArb, { minLength: 1, maxLength: 20 });
const multipleMatchListArb = fc.array(fileMatchArb, { minLength: 2, maxLength: 20 });
const largeMatchListArb = fc.array(fileMatchArb, { minLength: 11, maxLength: 20 });

class QueryTrackingAdapter extends FakeEditorAdapter {
  public readonly queries: string[] = [];

  public override async findFiles(name: string): Promise<FileMatch[]> {
    this.queries.push(name);
    return super.findFiles(name);
  }
}

function adapterFor(matches: readonly FileMatch[]): QueryTrackingAdapter {
  return new QueryTrackingAdapter({ files: matches.map((match) => ({ ...match })) });
}

function expectNoNavigationSideEffects(adapter: QueryTrackingAdapter): void {
  expect(adapter.opened).toEqual([]);
  expect(adapter.revealed).toEqual([]);
  expect(adapter.focusCount).toBe(0);
}

function expectRelativePath(path: string): void {
  expect(path).not.toMatch(/^(?:[A-Za-z]:[\\/]|[\\]{2}|\/)/);
}

describe('Property 17: file resolution opens only unambiguous matches', () => {
  it('returns not_found for every empty match list without navigation side effects', async () => {
    await fc.assert(
      fc.asyncProperty(queryArb, async (query) => {
        const adapter = adapterFor([]);
        const result = await new FileService(adapter).resolve(query);

        expect(result).toEqual(NO_MATCH);
        expectNoNavigationSideEffects(adapter);
      }),
      { numRuns: 100 },
    );
  });

  it('returns the exact same fsPath and relativePath for every unique match', async () => {
    await fc.assert(
      fc.asyncProperty(fileMatchArb, queryArb, async (match, query) => {
        const adapter = adapterFor([match]);
        const result = await new FileService(adapter).resolve(query);

        expect(result).toEqual({
          status: 'found',
          fsPath: match.fsPath,
          relativePath: match.relativePath,
        });
        expectNoNavigationSideEffects(adapter);
      }),
      { numRuns: 100 },
    );
  });

  it('classifies zero, one, and multiple matches without selecting an ambiguous match', async () => {
    await fc.assert(
      fc.asyncProperty(matchListArb, queryArb, async (matches, query) => {
        const adapter = adapterFor(matches);
        const result = await new FileService(adapter).resolve(query);

        if (matches.length === 0) {
          expect(result).toEqual(NO_MATCH);
        } else if (matches.length === 1) {
          expect(result).toEqual({
            status: 'found',
            fsPath: matches[0]!.fsPath,
            relativePath: matches[0]!.relativePath,
          });
        } else {
          expect(result).toEqual({
            status: 'ambiguous',
            matches: matches.slice(0, 10).map(({ relativePath }) => relativePath),
            totalCount: matches.length,
          });
          expect(result.status).not.toBe('found');
        }
        expectNoNavigationSideEffects(adapter);
      }),
      { numRuns: 100 },
    );
  });

  it('preserves adapter order and caps ambiguity display at ten paths', async () => {
    await fc.assert(
      fc.asyncProperty(multipleMatchListArb, async (matches) => {
        const adapter = adapterFor(matches);
        const result = await new FileService(adapter).resolve('auth.ts');

        expect(result.status).toBe('ambiguous');
        if (result.status === 'ambiguous') {
          expect(result.matches).toEqual(matches.slice(0, 10).map(({ relativePath }) => relativePath));
          expect(result.totalCount).toBe(matches.length);
          expect(result.matches.length).toBe(Math.min(matches.length, 10));
        }
        expectNoNavigationSideEffects(adapter);
      }),
      { numRuns: 100 },
    );
  });

  it('retains the complete count for every generated list larger than ten', async () => {
    await fc.assert(
      fc.asyncProperty(largeMatchListArb, async (matches) => {
        const adapter = adapterFor(matches);
        const result = await new FileService(adapter).resolve('index.ts');

        expect(result.status).toBe('ambiguous');
        if (result.status === 'ambiguous') {
          expect(result.matches).toHaveLength(10);
          expect(result.totalCount).toBe(matches.length);
        }
        expectNoNavigationSideEffects(adapter);
      }),
      { numRuns: 100 },
    );
  });

  it('exposes only generated workspace-relative paths in ambiguity results', async () => {
    await fc.assert(
      fc.asyncProperty(multipleMatchListArb, async (matches) => {
        const adapter = adapterFor(matches);
        const result = await new FileService(adapter).resolve('main.ts');

        expect(result.status).toBe('ambiguous');
        if (result.status === 'ambiguous') {
          const relativePaths = new Set(matches.map(({ relativePath }) => relativePath));
          for (const displayedPath of result.matches) {
            expect(relativePaths).toContain(displayedPath);
            expectRelativePath(displayedPath);
            expect(displayedPath).not.toMatch(/C:\\workspace/);
          }
          expect(result).not.toHaveProperty('fsPath');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('preserves duplicate adapter entries and counts them as separate matches', async () => {
    await fc.assert(
      fc.asyncProperty(fileMatchArb, fc.integer({ min: 2, max: 20 }), async (match, count) => {
        const matches = Array.from({ length: count }, () => ({ ...match }));
        const adapter = adapterFor(matches);
        const result = await new FileService(adapter).resolve('auth.ts');

        expect(result).toEqual({
          status: 'ambiguous',
          matches: matches.slice(0, 10).map(({ relativePath }) => relativePath),
          totalCount: count,
        });
        expectNoNavigationSideEffects(adapter);
      }),
      { numRuns: 100 },
    );
  });

  it('forwards the exact query without rewriting it', async () => {
    await fc.assert(
      fc.asyncProperty(matchListArb, queryArb, async (matches, query) => {
        const adapter = adapterFor(matches);
        await new FileService(adapter).resolve(query);

        expect(adapter.queries).toEqual([query]);
        expectNoNavigationSideEffects(adapter);
      }),
      { numRuns: 100 },
    );
  });

  it('keeps fsPath and relativePath paired from the same unique match', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fileMatchArb, { minLength: 2, maxLength: 10 }),
        fileMatchArb,
        queryArb,
        async (otherMatches, target, query) => {
          const matches = [...otherMatches, target];
          const adapter = adapterFor([target]);
          const result = await new FileService(adapter).resolve(query);

          expect(result).toEqual({
            status: 'found',
            fsPath: target.fsPath,
            relativePath: target.relativePath,
          });
          expect(result.status).toBe('found');
          if (result.status === 'found') {
            expect(result.fsPath).toBe(target.fsPath);
            expect(result.relativePath).toBe(target.relativePath);
          }
          expect(matches).toContain(target);
          expectNoNavigationSideEffects(adapter);
        },
      ),
      { numRuns: 100 },
    );
  });
});
