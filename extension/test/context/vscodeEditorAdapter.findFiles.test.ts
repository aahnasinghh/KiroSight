import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import {
  VscodeEditorAdapter,
  escapeGlobLiteral,
  toFileQuery,
} from '../../src/context/editorAdapter';
import { resetVscodeMock, setMockWorkspace, vscodeMockState, workspaceMockState } from '../mocks/vscode';

const ROOT = '/ws/KiroSight';
const FILES = [
  `${ROOT}/extension/src/extension.ts`,
  `${ROOT}/extension/src/util/logger.ts`,
  `${ROOT}/extension/test/extension.ts`,
  `${ROOT}/extension/node_modules/pkg/extension.ts`,
  `${ROOT}/extension/dist/extension.ts`,
  `${ROOT}/.git/extension.ts`,
  `${ROOT}/docs/a*b.md`,
  `${ROOT}/docs/aXXb.md`,
  `${ROOT}/docs/x{1}.md`,
  `${ROOT}/docs/x1.md`,
  `${ROOT}/docs/q[1].md`,
  `${ROOT}/docs/q1.md`,
  `${ROOT}/docs/what?.md`,
  `${ROOT}/docs/whatX.md`,
];

describe('VscodeEditorAdapter.findFiles', () => {
  const adapter = new VscodeEditorAdapter();

  beforeEach(() => {
    resetVscodeMock();
    setMockWorkspace([ROOT], FILES);
  });

  it('searches a bare file name recursively, skipping build and dependency directories', async () => {
    const matches = await adapter.findFiles('extension.ts');

    expect(matches.map((m) => m.relativePath)).toEqual([
      'extension/src/extension.ts',
      'extension/test/extension.ts',
    ]);
    const call = workspaceMockState.findFilesCalls[0]!;
    expect((call.include as vscode.RelativePattern).pattern).toBe('**/extension.ts');
    expect(call.exclude).toBe('**/{node_modules,.git,dist,out,build}/**');
  });

  it('returns exactly one match with fsPath and relativePath for a unique nested basename', async () => {
    const matches = await adapter.findFiles('logger.ts');

    expect(matches).toEqual([
      { fsPath: `${ROOT}/extension/src/util/logger.ts`, relativePath: 'extension/src/util/logger.ts' },
    ]);
  });

  it('returns every basename match so FileService can report ambiguity', async () => {
    expect(await adapter.findFiles('extension.ts')).toHaveLength(2);
  });

  it('resolves an exact workspace-relative path to one match', async () => {
    const matches = await adapter.findFiles('extension/src/extension.ts');

    expect(matches).toEqual([
      { fsPath: `${ROOT}/extension/src/extension.ts`, relativePath: 'extension/src/extension.ts' },
    ]);
    const call = workspaceMockState.findFilesCalls[0]!;
    expect((call.include as vscode.RelativePattern).pattern).toBe('extension/src/extension.ts');
  });

  it('does not match unrelated files for a relative path', async () => {
    expect(await adapter.findFiles('src/extension.ts')).toEqual([]);
    expect(await adapter.findFiles('extension/src/missing.ts')).toEqual([]);
  });

  it('normalizes Windows separators', async () => {
    const matches = await adapter.findFiles('extension\\src\\extension.ts');

    expect(matches.map((m) => m.relativePath)).toEqual(['extension/src/extension.ts']);
  });

  it('returns [] when there is no workspace folder', async () => {
    setMockWorkspace(undefined, FILES);
    expect(await adapter.findFiles('extension.ts')).toEqual([]);

    setMockWorkspace([], FILES);
    expect(await adapter.findFiles('extension.ts')).toEqual([]);
    expect(workspaceMockState.findFilesCalls).toHaveLength(0);
  });

  it('searches every workspace folder in order and combines results', async () => {
    setMockWorkspace(['/ws/B', '/ws/A'], ['/ws/A/src/app.ts', '/ws/B/lib/app.ts']);

    const matches = await adapter.findFiles('app.ts');

    expect(matches).toEqual([
      { fsPath: '/ws/B/lib/app.ts', relativePath: 'lib/app.ts' },
      { fsPath: '/ws/A/src/app.ts', relativePath: 'src/app.ts' },
    ]);
    expect(workspaceMockState.findFilesCalls).toHaveLength(2);
  });

  it('treats glob metacharacters in the name as literal text', async () => {
    expect((await adapter.findFiles('a*b.md')).map((m) => m.relativePath)).toEqual(['docs/a*b.md']);
    expect((await adapter.findFiles('x{1}.md')).map((m) => m.relativePath)).toEqual(['docs/x{1}.md']);
    expect((await adapter.findFiles('q[1].md')).map((m) => m.relativePath)).toEqual(['docs/q[1].md']);
    expect((await adapter.findFiles('what?.md')).map((m) => m.relativePath)).toEqual(['docs/what?.md']);
    expect(await adapter.findFiles('*')).toEqual([]);
    expect(await adapter.findFiles('**')).toEqual([]);
  });

  it('rejects traversal, absolute and empty input without searching', async () => {
    for (const input of ['', '  ', '../x.ts', 'a/../x.ts', '/etc/passwd', 'a//b.ts']) {
      expect(await adapter.findFiles(input)).toEqual([]);
    }
    expect(workspaceMockState.findFilesCalls).toHaveLength(0);
  });

  it('only searches: it never opens, reveals, or focuses anything', async () => {
    await adapter.findFiles('extension.ts');

    expect(vscodeMockState.executedCommands).toEqual([]);
    expect(vscodeMockState.webviewPanels).toEqual([]);
  });
});

describe('file query helpers', () => {
  it('escapes glob metacharacters with character classes', () => {
    expect(escapeGlobLiteral('a*b?[c]{d}')).toBe('a[*]b[?][[]c[]][{]d[}]');
  });

  it('builds recursive and exact queries', () => {
    expect(toFileQuery('extension.ts')?.glob).toBe('**/extension.ts');
    expect(toFileQuery('./a/b.ts')?.glob).toBe('a/b.ts');
    expect(toFileQuery('a/b.ts')?.exclude).toBeUndefined();
    expect(toFileQuery('..')).toBeNull();
  });
});
