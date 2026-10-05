import { describe, expect, it } from 'vitest';

import { REDACTED, redact } from '../../src/util/redact';

describe('redact', () => {
  it('redacts every occurrence of an explicitly supplied secret literally', () => {
    const secret = 'example.$ecret[1]';
    const output = redact(`first=${secret}; second=${secret}`, [secret]);

    expect(output).toBe(`first=${REDACTED}; second=${REDACTED}`);
    expect(output).not.toContain(secret);
  });

  it('redacts common bearer, token, AWS, and Deepgram credential forms', () => {
    const bearer = 'example-access-token';
    const token = 'example-token-value';
    const deepgramKey = 'example-deepgram-key';
    const awsAccessKey = `AKIA${'A'.repeat(16)}`;
    const awsSecretKey = 'example-aws-secret';
    const input = [
      `Bearer ${bearer}`,
      `token=${token}`,
      `DEEPGRAM_API_KEY="${deepgramKey}"`,
      `AWS_ACCESS_KEY_ID=${awsAccessKey}`,
      `AWS_SECRET_ACCESS_KEY=${awsSecretKey}`,
    ].join('\n');

    const output = redact(input);

    for (const secret of [bearer, token, deepgramKey, awsAccessKey, awsSecretKey]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain(REDACTED);
  });
});
