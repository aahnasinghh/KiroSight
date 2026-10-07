import type { EditorAdapter } from '../context/editorAdapter';

export type FileResolution =
  | { status: 'not_found' }
  | { status: 'found'; fsPath: string; relativePath: string }
  | { status: 'ambiguous'; matches: string[]; totalCount: number };

const MAX_DISPLAYED_MATCHES = 10;

export class FileService {
  public constructor(private readonly adapter: EditorAdapter) {}

  public async resolve(nameOrPath: string): Promise<FileResolution> {
    const matches = await this.adapter.findFiles(nameOrPath);

    if (matches.length === 0) {
      return { status: 'not_found' };
    }

    if (matches.length === 1) {
      return {
        status: 'found',
        fsPath: matches[0]!.fsPath,
        relativePath: matches[0]!.relativePath,
      };
    }

    return {
      status: 'ambiguous',
      matches: matches.slice(0, MAX_DISPLAYED_MATCHES).map(({ relativePath }) => relativePath),
      totalCount: matches.length,
    };
  }
}
