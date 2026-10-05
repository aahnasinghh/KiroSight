export const REDACTED = '[REDACTED]' as const;

const AUTHORIZATION_PATTERN =
  /((?:["']?)authorization(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)/gi;

const LABELED_SECRET_PATTERN =
  /((?:["']?)(?:(?:x[_-]?)?api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|token|password|client[_-]?secret|deepgram[_-]?(?:api[_-]?)?key|aws[_-]?access[_-]?key[_-]?id|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&#]+)/gi;

const BEARER_PATTERN = /\bbearer\s+[a-z0-9._~+\/-]+=*/gi;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AIDA|AKIA|AROA|ASIA)[A-Z0-9]{16}\b/g;
const JWT_PATTERN = /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi;
const PREFIXED_TOKEN_PATTERN =
  /\b(?:dg[_-][a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{16,}|sk-[a-z0-9_-]{16,})\b/gi;

/**
 * Redacts common credential shapes and exact secret values from text.
 * Explicit values are treated as literal strings; empty values are ignored.
 */
export function redact(text: string, explicitSecrets: readonly string[] = []): string {
  let sanitized = text;
  const secrets = [...new Set(explicitSecrets)]
    .filter((secret) => secret.length > 0 && secret !== REDACTED)
    .sort((left, right) => right.length - left.length);

  for (const secret of secrets) {
    sanitized = sanitized.split(secret).join(REDACTED);
  }

  sanitized = sanitized.replace(AUTHORIZATION_PATTERN, `$1${REDACTED}`);
  sanitized = sanitized.replace(LABELED_SECRET_PATTERN, `$1${REDACTED}`);
  sanitized = sanitized.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
  sanitized = sanitized.replace(AWS_ACCESS_KEY_PATTERN, REDACTED);
  sanitized = sanitized.replace(JWT_PATTERN, REDACTED);
  sanitized = sanitized.replace(PREFIXED_TOKEN_PATTERN, REDACTED);

  return sanitized;
}
