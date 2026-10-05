import { redact } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogMetadataValue = string | number | boolean | null;
export type LogMetadata = Readonly<Record<string, LogMetadataValue | undefined>>;

export interface LogOutput {
  appendLine(line: string): void;
}

/**
 * Logs event summaries and primitive metadata through one redacting output path.
 * Callers must pass metadata, not raw audio, source files, request payloads, or stacks.
 */
export class KiroSightLogger {
  private readonly explicitSecrets: readonly string[];

  public constructor(
    private readonly output: LogOutput,
    explicitSecrets: readonly string[] = [],
  ) {
    this.explicitSecrets = [...explicitSecrets];
  }

  public debug(message: string, metadata?: LogMetadata): void {
    this.write('debug', message, metadata);
  }

  public info(message: string, metadata?: LogMetadata): void {
    this.write('info', message, metadata);
  }

  public warn(message: string, metadata?: LogMetadata): void {
    this.write('warn', message, metadata);
  }

  public error(message: string, metadata?: LogMetadata): void {
    this.write('error', message, metadata);
  }

  private write(level: LogLevel, message: string, metadata?: LogMetadata): void {
    const metadataText = metadata === undefined ? '' : ` ${this.formatMetadata(metadata)}`;
    const sanitized = redact(`[${level.toUpperCase()}] ${message}${metadataText}`, this.explicitSecrets);

    for (const line of sanitized.split(/\r?\n/)) {
      this.output.appendLine(line);
    }
  }

  private formatMetadata(metadata: LogMetadata): string {
    const sanitized: Record<string, LogMetadataValue> = {};

    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string') {
        sanitized[key] = redact(value, this.explicitSecrets);
      } else if (value !== undefined) {
        sanitized[key] = value;
      }
    }

    return JSON.stringify(sanitized);
  }
}
