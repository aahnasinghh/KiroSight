import type { EditorAdapter, Pos } from '../context/editorAdapter';
import type { FileResolution } from './fileService';

export type NavigationResult =
  | { status: 'ok'; relativePath?: string; line?: number }
  | { status: 'not_found' }
  | { status: 'ambiguous'; matches: string[]; totalCount: number }
  | { status: 'failed'; message: 'The requested location could not be found' };

const INVALID_LOCATION: NavigationResult = {
  status: 'failed',
  message: 'The requested location could not be found',
};

export function isValidLine(line: number, lineCount: number): boolean {
  return Number.isInteger(line) && line >= 1 && line <= lineCount;
}

export class NavigationService {
  public constructor(private readonly adapter: EditorAdapter) {}

  public async reveal(fsPath: string, position: Pos): Promise<NavigationResult> {
    await this.adapter.reveal(fsPath, position);
    return { status: 'ok' };
  }

  public async openFile(resolution: FileResolution): Promise<NavigationResult> {
    if (resolution.status === 'not_found') {
      return { status: 'not_found' };
    }

    if (resolution.status === 'ambiguous') {
      return resolution;
    }

    await this.adapter.openFile(resolution.fsPath);
    return { status: 'ok', relativePath: resolution.relativePath };
  }

  public async focusEditor(): Promise<NavigationResult> {
    await this.adapter.focusEditor();
    return { status: 'ok' };
  }

  public async goToLine(line: number): Promise<NavigationResult> {
    const snapshot = this.adapter.snapshot();
    if (snapshot === null || snapshot.file === null || !isValidLine(line, snapshot.file.lineCount)) {
      return INVALID_LOCATION;
    }

    await this.adapter.reveal(snapshot.file.fsPath, { line, column: 1 });
    return {
      status: 'ok',
      relativePath: snapshot.file.relativePath,
      line,
    };
  }
}
