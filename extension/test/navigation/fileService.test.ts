import { describe, expect, it } from 'vitest';

import { FileService } from '../../src/navigation/fileService';
import { FakeEditorAdapter } from '../context/fakeEditorAdapter';

describe('FileService', () => {
  it('returns not_found for zero matches without navigation side effects', async () => {
    const adapter = new FakeEditorAdapter({ files: [] });
    const result = await new FileService(adapter).resolve('missing.ts');

    expect(result).toEqual({ status: 'not_found' });
    expect(adapter.opened).toEqual([]);
    expect(adapter.revealed).toEqual([]);
    expect(adapter.focusCount).toBe(0);
  });

  it('returns the unique workspace-relative match', async () => {
    const adapter = new FakeEditorAdapter({ files: ['src/auth.ts'] });
    const result = await new FileService(adapter).resolve('auth.ts');

    expect(result).toEqual({
      status: 'found',
      fsPath: 'C:/workspace/src/auth.ts',
      relativePath: 'src/auth.ts',
    });
    expect(adapter.opened).toEqual([]);
    expect(adapter.revealed).toEqual([]);
    expect(adapter.focusCount).toBe(0);
  });

  it('returns ambiguity without selecting either match', async () => {
    const adapter = new FakeEditorAdapter({ files: ['src/auth.ts', 'test/auth.ts'] });
    const result = await new FileService(adapter).resolve('auth.ts');

    expect(result).toEqual({
      status: 'ambiguous',
      matches: ['src/auth.ts', 'test/auth.ts'],
      totalCount: 2,
    });
    expect(adapter.opened).toEqual([]);
    expect(adapter.revealed).toEqual([]);
    expect(adapter.focusCount).toBe(0);
  });

  it('limits displayed ambiguity paths to 10 while retaining the complete count', async () => {
    const files = Array.from({ length: 15 }, (_, index) => `src/candidate-${index}.ts`);
    const adapter = new FakeEditorAdapter({ files });
    const result = await new FileService(adapter).resolve('candidate.ts');

    expect(result).toEqual({
      status: 'ambiguous',
      matches: files.slice(0, 10),
      totalCount: 15,
    });
    if (result.status === 'ambiguous') {
      expect(result.matches).toHaveLength(10);
      expect(result.totalCount).toBe(15);
      expect(result.matches.every((path) => !/^(?:[A-Za-z]:[\\/]|[\\]{2}|\/)/.test(path))).toBe(true);
    }
    expect(adapter.opened).toEqual([]);
    expect(adapter.revealed).toEqual([]);
    expect(adapter.focusCount).toBe(0);
  });

  it('preserves adapter-reported ambiguity order and relative paths', async () => {
    const files = ['z/auth.ts', 'a/auth.ts', 'nested/auth.ts'];
    const adapter = new FakeEditorAdapter({ files });
    const result = await new FileService(adapter).resolve('auth.ts');

    expect(result).toEqual({ status: 'ambiguous', matches: files, totalCount: 3 });
    if (result.status === 'ambiguous') {
      expect(result.matches).toEqual(files);
      expect(result.matches).not.toContain('C:\\workspace\\auth.ts');
    }
  });

  it('preserves duplicate adapter matches rather than inventing deduplication', async () => {
    const files = ['src/auth.ts', 'src/auth.ts', 'test/auth.ts'];
    const result = await new FileService(new FakeEditorAdapter({ files })).resolve('auth.ts');

    expect(result).toEqual({ status: 'ambiguous', matches: files, totalCount: 3 });
  });

  it('passes the query to the adapter and performs no open, reveal, or focus operation', async () => {
    const adapter = new FakeEditorAdapter({ files: ['src/main.ts'] });
    const result = await new FileService(adapter).resolve('src/main.ts');

    expect(result).toEqual({
      status: 'found',
      fsPath: 'C:/workspace/src/main.ts',
      relativePath: 'src/main.ts',
    });
    expect(adapter.opened).toHaveLength(0);
    expect(adapter.revealed).toHaveLength(0);
    expect(adapter.focusCount).toBe(0);
  });
});
