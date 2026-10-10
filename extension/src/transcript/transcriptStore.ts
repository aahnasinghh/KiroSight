export type TranscriptRole = 'user' | 'kirosight' | 'system';
export type TranscriptSource = 'typed' | 'voice';

export interface TranscriptEntry {
  readonly seq: number;
  readonly role: TranscriptRole;
  readonly text: string;
  readonly source?: TranscriptSource;
}

export class TranscriptStore {
  private readonly storedEntries: TranscriptEntry[] = [];
  private nextSequence = 1;

  public append(
    role: TranscriptRole,
    text: string,
    source?: TranscriptSource,
  ): TranscriptEntry {
    const entry: TranscriptEntry = Object.freeze({
      seq: this.nextSequence,
      role,
      text,
      ...(source === undefined ? {} : { source }),
    });
    this.nextSequence += 1;
    this.storedEntries.push(entry);
    return entry;
  }

  public getEntries(): readonly TranscriptEntry[] {
    return this.storedEntries.slice();
  }
}
