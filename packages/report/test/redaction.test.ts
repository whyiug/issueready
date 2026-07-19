import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "../src/redaction.js";

function githubToken(kind: "p" | "o" | "u" | "s" | "r"): string {
  return `gh${kind}_${"A1".repeat(10)}`;
}

describe("credential redaction", () => {
  it.each([
    [githubToken("p"), "[REDACTED_GITHUB_TOKEN]"],
    [githubToken("o"), "[REDACTED_GITHUB_TOKEN]"],
    [githubToken("u"), "[REDACTED_GITHUB_TOKEN]"],
    [githubToken("s"), "[REDACTED_GITHUB_TOKEN]"],
    [githubToken("r"), "[REDACTED_GITHUB_TOKEN]"],
    [`sk-${"aB_9".repeat(4)}`, "[REDACTED_API_TOKEN]"],
    [`AKIA${"A1".repeat(8)}`, "[REDACTED_AWS_ACCESS_KEY]"],
    [
      "Authorization: Bearer synthetic-token",
      "Authorization: Bearer [REDACTED]",
    ],
    [
      "Authorization:Bearer synthetic-token",
      "Authorization: Bearer [REDACTED]",
    ],
    [
      "Authorization:  Bearer   synthetic-token",
      "Authorization: Bearer [REDACTED]",
    ],
    [
      "authorization : bearer synthetic-token",
      "Authorization: Bearer [REDACTED]",
    ],
    ["ARK_API_KEY=synthetic-key", "[REDACTED_API_KEY]"],
    ["OPENAI_API_KEY: 'synthetic-key'", "[REDACTED_API_KEY]'"],
    ['anthropic_api_key = "synthetic-key"', '[REDACTED_API_KEY]"'],
  ])("redacts a supported credential form", (input, expected) => {
    expect(redactSensitiveText(input)).toBe(expected);
  });

  it.each([
    "ghp_too_short",
    `x${githubToken("p")}`,
    `AKIA${"A1".repeat(7)}`,
    `AKIA${"a1".repeat(8)}`,
    "Authorization: Basic synthetic-token",
    "ARK_API_KEY=short",
    "SOME_API_KEY=synthetic-key",
    "-----BEGIN PUBLIC KEY-----synthetic",
  ])("preserves a near miss instead of over-redacting", (input) => {
    expect(redactSensitiveText(input)).toBe(input);
  });

  it("redacts all supported credentials in one pass", () => {
    const input = [
      `prefix ${githubToken("p")} suffix`,
      `sk-${"z-9_".repeat(4)}`,
      `AKIA${"Z9".repeat(8)}`,
      "Authorization:\tBearer synthetic-token",
      "ANTHROPIC_API_KEY=synthetic-key",
    ].join("\n");
    const redacted = redactSensitiveText(input);

    expect(redacted).toBe(
      [
        "prefix [REDACTED_GITHUB_TOKEN] suffix",
        "[REDACTED_API_TOKEN]",
        "[REDACTED_AWS_ACCESS_KEY]",
        "Authorization: Bearer [REDACTED]",
        "[REDACTED_API_KEY]",
      ].join("\n"),
    );
    expect(redactSensitiveText(redacted)).toBe(redacted);
  });

  it.each(["", "ordinary text", "emoji 😀 and 汉字"])(
    "leaves non-sensitive text byte-for-byte stable",
    (input) => {
      expect(redactSensitiveText(input)).toBe(input);
    },
  );

  it.each(["", "RSA ", "EC ", "OPENSSH "])(
    "redacts a %sprivate-key block and everything after its header",
    (kind) => {
      expect(
        redactSensitiveText(
          `before\n-----BEGIN ${kind}PRIVATE KEY-----\nsynthetic\nafter`,
        ),
      ).toBe("before\n[REDACTED_PRIVATE_KEY]");
    },
  );
});
