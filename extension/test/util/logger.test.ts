import { describe, expect, it } from 'vitest';

import { KiroSightLogger, type LogOutput } from '../../src/util/logger';
import { REDACTED } from '../../src/util/redact';

describe('KiroSightLogger', () => {
  it('redacts messages and metadata before they reach the output target', () => {
    const lines: string[] = [];
    const output: LogOutput = {
      appendLine(line) {
        lines.push(line);
      },
    };
    const explicitSecret = 'example-explicit-secret';
    const bearerToken = 'example-bearer-token';
    const logger = new KiroSightLogger(output, [explicitSecret]);

    logger.info(`Backend token: ${explicitSecret}`, {
      authorization: `Bearer ${bearerToken}`,
      requestId: 'request-7',
      bytes: 128,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(explicitSecret);
    expect(lines[0]).not.toContain(bearerToken);
    expect(lines[0]).toContain(REDACTED);
    expect(lines[0]).toContain('request-7');
    expect(lines[0]).toContain('128');
  });
});
