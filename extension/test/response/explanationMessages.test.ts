import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../../src/protocol/constants';
import {
  INVALID_REASONING_RESPONSE_TEXT,
  REASONING_FAILED_TEXT,
  describeReasoningFailure,
  noFunctionOrSelectionText,
  noMatchingDiagnosticText,
} from '../../src/response/explanationMessages';

describe('describeReasoningFailure (Req 12.3, design F2 and F6)', () => {
  it('states that the explanation could not be generated because the reasoning service failed', () => {
    expect(REASONING_FAILED_TEXT).toBe("The explanation couldn't be generated because the reasoning service failed.");
    for (const code of ['BEDROCK_UNAVAILABLE', 'CREDENTIAL_MISSING'] as const) {
      expect(describeReasoningFailure(code, true)).toContain(REASONING_FAILED_TEXT);
    }
  });

  it('offers a retry only for a recoverable failure', () => {
    expect(describeReasoningFailure('BEDROCK_UNAVAILABLE', true)).toContain('You can try again.');
    expect(describeReasoningFailure('BEDROCK_UNAVAILABLE', undefined)).toContain('You can try again.');
    expect(describeReasoningFailure('BEDROCK_UNAVAILABLE', false)).not.toContain('try again');
  });

  it('keeps missing credentials distinct from an unavailable service, and never claims Bedrock works', () => {
    const missing = describeReasoningFailure('CREDENTIAL_MISSING', false)!;
    const down = describeReasoningFailure('BEDROCK_UNAVAILABLE', true)!;
    expect(missing).toContain('no Amazon Bedrock credentials configured');
    expect(down).not.toContain('credentials');
    expect(down).toContain('did not complete the request');
    for (const text of [missing, down]) {
      expect(text).not.toMatch(/\b(?:connected|working|operational|available)\b/i);
      expect(text).toContain('Local commands');
    }
  });

  it('uses the design F6 text for an invalid response', () => {
    expect(INVALID_REASONING_RESPONSE_TEXT)
      .toBe("I couldn't understand the reasoning service's answer, so I did nothing. Please try rephrasing.");
    expect(describeReasoningFailure('BEDROCK_INVALID_RESPONSE', true)).toContain(INVALID_REASONING_RESPONSE_TEXT);
  });

  it('is null for every code that is not a reasoning failure, and never mentions another provider', () => {
    const reasoning = new Set(['BEDROCK_UNAVAILABLE', 'CREDENTIAL_MISSING', 'BEDROCK_INVALID_RESPONSE']);
    for (const code of ERROR_CODES) {
      const text = describeReasoningFailure(code, true);
      if (reasoning.has(code)) {
        expect(text).not.toBeNull();
        expect(text).not.toMatch(/openai|gemini|anthropic|fallback|another provider/i);
      } else {
        expect(text).toBeNull();
      }
    }
  });
});

describe('local report texts', () => {
  it('states the matching-diagnostic report with a concrete reason', () => {
    expect(noMatchingDiagnosticText(null)).toBe('No matching diagnostic was found because no file is open.');
    expect(noMatchingDiagnosticText('src/a.ts'))
      .toBe('No matching diagnostic was found. There are no errors, warnings or hints in src/a.ts.');
  });

  it('always opens with the Req 12.5 statement and then gives a specific reason', () => {
    const head = 'No function or selection is available to explain.';
    const base = { relativePath: 'src/a.ts', line: 7, symbolStatus: 'none_enclosing', hasSelection: false } as const;
    for (const text of [
      noFunctionOrSelectionText({ ...base, target: 'function' }),
      noFunctionOrSelectionText({ ...base, target: 'selection' }),
      noFunctionOrSelectionText({ ...base, target: 'function', symbolStatus: 'provider_unavailable' }),
      noFunctionOrSelectionText({ ...base, target: 'function', line: null }),
      noFunctionOrSelectionText({ ...base, target: 'function', relativePath: null }),
    ]) {
      expect(text.startsWith(head)).toBe(true);
      expect(text.length).toBeGreaterThan(head.length + 10);
    }
  });
});
