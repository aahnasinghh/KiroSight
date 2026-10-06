import { describe, expect, it } from 'vitest';

import { formatDiagnostics } from '../../src/context/contextFormatter';
import type { DiagnosticInfo, EditorSnapshot, SymbolNode } from '../../src/context/editorAdapter';
import { SymbolService } from '../../src/context/symbolService';
import { FakeEditorAdapter } from './fakeEditorAdapter';

const currentFsPath = 'C:/workspace/src/current.ts';
const currentRelativePath = 'src/current.ts';

function snapshot(): EditorSnapshot {
  return {
    workspaceName: 'formatter-test',
    rootCount: 1,
    file: {
      fsPath: currentFsPath,
      relativePath: currentRelativePath,
      languageId: 'typescript',
      lineCount: 20,
    },
    cursor: { line: 3, column: 2 },
    selection: null,
    getLines: () => ['const current = true;'],
  };
}

function diagnostic(
  severity: DiagnosticInfo['severity'] = 'error',
  relativePath = currentRelativePath,
  line = 3,
): DiagnosticInfo {
  return {
    severity,
    relativePath,
    line,
    column: 5,
    message: 'Type mismatch.',
  };
}

function symbol(name: string): SymbolNode {
  return {
    name,
    kind: 'Function',
    range: {
      start: { line: 1, column: 1 },
      end: { line: 10, column: 1 },
    },
    children: [],
  };
}

function resolver(relativePath: string): string {
  return `C:/workspace/${relativePath}`;
}

describe('formatDiagnostics', () => {
  it('includes the relative path, line, severity, message, and known enclosing symbol', async () => {
    const adapter = new FakeEditorAdapter({
      snapshot: snapshot(),
      symbolResult: { status: 'found', nodes: [symbol('validateToken')] },
    });
    const result = await formatDiagnostics(
      { status: 'ok', diagnostics: [diagnostic()] },
      new SymbolService(adapter),
      resolver,
    );

    expect(result).toBe(
      'Error in src/current.ts at line 3, in function validateToken: Type mismatch.',
    );
  });

  it('keeps a diagnostic concrete without inventing a symbol when none encloses it', async () => {
    const adapter = new FakeEditorAdapter({
      snapshot: snapshot(),
      symbolResult: { status: 'none_enclosing' },
    });
    const result = await formatDiagnostics(
      { status: 'ok', diagnostics: [diagnostic()] },
      new SymbolService(adapter),
      resolver,
    );

    expect(result).toBe('Error in src/current.ts at line 3: Type mismatch.');
    expect(result).not.toContain('function');
    expect(result).not.toContain('validateToken');
  });

  it('keeps a diagnostic concrete when the symbol provider is unavailable', async () => {
    const adapter = new FakeEditorAdapter({
      snapshot: snapshot(),
      symbolResult: { status: 'provider_unavailable' },
    });
    const result = await formatDiagnostics(
      { status: 'ok', diagnostics: [diagnostic('warning', 'src/other.ts', 8)] },
      new SymbolService(adapter),
      resolver,
    );

    expect(result).toBe('Warning in src/other.ts at line 8: Type mismatch.');
    expect(result).not.toContain('validateToken');
  });

  it('formats multiple diagnostics with concrete paths and lines', async () => {
    const adapter = new FakeEditorAdapter({
      snapshot: snapshot(),
      symbolResult: { status: 'none_enclosing' },
    });
    const result = await formatDiagnostics(
      {
        status: 'ok',
        diagnostics: [
          diagnostic('error', 'src/current.ts', 3),
          diagnostic('warning', 'src/other.ts', 8),
        ],
      },
      new SymbolService(adapter),
      resolver,
    );

    expect(result).toBe(
      'Diagnostics:\n' +
      '- Error in src/current.ts at line 3: Type mismatch.\n' +
      '- Warning in src/other.ts at line 8: Type mismatch.',
    );
  });

  it('reports empty and no-file diagnostic results with exact messages', async () => {
    const symbolService = new SymbolService(new FakeEditorAdapter());

    await expect(formatDiagnostics(
      { status: 'no_diagnostics', diagnostics: [] },
      symbolService,
      resolver,
    )).resolves.toBe('No diagnostics found.');

    await expect(formatDiagnostics(
      { status: 'no_file_open', diagnostics: [] },
      symbolService,
      resolver,
    )).resolves.toBe('No file is open.');
  });
});
