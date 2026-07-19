interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const REDACTION_RULES: readonly RedactionRule[] = Object.freeze([
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*/gu,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
    replacement: "[REDACTED_API_TOKEN]",
  },
  {
    pattern: /\bAKIA[A-Z0-9]{16}\b/gu,
    replacement: "[REDACTED_AWS_ACCESS_KEY]",
  },
  {
    pattern: /\bAuthorization\s*:\s*Bearer\s+[^\s]+/giu,
    replacement: "Authorization: Bearer [REDACTED]",
  },
  {
    pattern: /\b(?:ARK|OPENAI|ANTHROPIC)_API_KEY\s*[:=]\s*["']?[^\s"']{8,}/giu,
    replacement: "[REDACTED_API_KEY]",
  },
]);

export function redactSensitiveText(value: string): string {
  return REDACTION_RULES.reduce(
    (redacted, rule) => redacted.replaceAll(rule.pattern, rule.replacement),
    value,
  );
}
