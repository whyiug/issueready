import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  createEvidenceSpan,
  createTextSpan,
  isUtf16Boundary,
  matchIssueFormTemplates,
  normalizeIssueFormSubmission,
  normalizeMarkdown,
  parseIssueFormTemplate,
  utf16PointAt,
} from "../src/index.js";

const SNAPSHOT_DIGEST = `sha256:${"a".repeat(64)}` as const;

function fixture(relativePath: string): string {
  return readFileSync(
    new URL(`../../../fixtures/${relativePath}`, import.meta.url),
    "utf8",
  );
}

function schema(relativePath: string): object {
  return JSON.parse(
    readFileSync(
      new URL(`../../../schemas/${relativePath}`, import.meta.url),
      "utf8",
    ),
  ) as object;
}

describe("UTF-16 evidence spans", () => {
  it("uses half-open JavaScript offsets across emoji, combining marks, CJK, and CRLF", () => {
    const source = "标题 😀\r\ne\u0301 与汉字\nfinish";
    const start = source.indexOf("😀");
    const end = source.indexOf("finish");
    const span = createEvidenceSpan(
      "issue.body",
      source,
      start,
      end,
      SNAPSHOT_DIGEST,
    );

    expect(span.quote).toBe("😀\r\ne\u0301 与汉字\n");
    expect(source.slice(span.startUtf16, span.endUtf16)).toBe(span.quote);
    expect(span.lineStart).toBe(1);
    expect(span.lineEnd).toBe(2);
    expect(utf16PointAt(source, end)).toMatchObject({
      line: 3,
      columnUtf16: 1,
    });
    expect(() => createTextSpan("issue.body", source, start + 1, end)).toThrow(
      /surrogate pair/u,
    );
  });

  it("round-trips every safe span in generated multilingual text", () => {
    const token = fc.constantFrom(
      "a",
      "Z",
      "汉",
      "😀",
      "🧑🏽‍💻",
      "e\u0301",
      "\n",
      "\r\n",
      " ",
    );
    fc.assert(
      fc.property(fc.array(token, { maxLength: 40 }), (tokens) => {
        const source = tokens.join("");
        const boundaries = Array.from(
          { length: source.length + 1 },
          (_, index) => index,
        ).filter((offset) => isUtf16Boundary(source, offset));
        for (let index = 0; index < boundaries.length; index += 1) {
          const start = boundaries[index];
          const end = boundaries[boundaries.length - 1 - index];
          if (start === undefined || end === undefined || start > end) continue;
          const span = createEvidenceSpan(
            "issue.body",
            source,
            start,
            end,
            SNAPSHOT_DIGEST,
            source.length,
          );
          expect(source.slice(span.startUtf16, span.endUtf16)).toBe(span.quote);
        }
      }),
      { numRuns: 250 },
    );
  });

  it("omits, rather than fabricates or truncates, an oversized quote", () => {
    const source = "x".repeat(513);
    const span = createEvidenceSpan(
      "issue.body",
      source,
      0,
      source.length,
      SNAPSHOT_DIGEST,
    );
    expect(span).not.toHaveProperty("quote");
  });
});

describe("Markdown normalization", () => {
  it("extracts headings, checklist items, code fences, and links with exact spans", () => {
    const source = [
      "# 功能 😀",
      "",
      "## Acceptance criteria",
      "- [x] 支持 emoji",
      "- [ ] preserves [a reference][spec]",
      "",
      "```ts",
      "const value = '汉字';",
      "```",
      "",
      "[spec]: https://example.invalid/spec",
    ].join("\n");
    const normalized = normalizeMarkdown(source);

    expect(
      normalized.headings.map(({ depth, text }) => ({ depth, text })),
    ).toEqual([
      { depth: 1, text: "功能 😀" },
      { depth: 2, text: "Acceptance criteria" },
    ]);
    expect(normalized.checklistItems.map(({ checked }) => checked)).toEqual([
      true,
      false,
    ]);
    expect(normalized.codeFences).toHaveLength(1);
    expect(normalized.codeFences[0]).toMatchObject({
      language: "ts",
      value: "const value = '汉字';",
    });
    expect(normalized.links.map(({ kind }) => kind)).toEqual([
      "REFERENCE",
      "DEFINITION",
    ]);
    for (const heading of normalized.headings) {
      expect(
        source.slice(heading.span.startUtf16, heading.span.endUtf16),
      ).toContain(heading.text);
    }
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.headings)).toBe(true);
  });
});

describe("Issue Form normalization and conservative matching", () => {
  const bug = parseIssueFormTemplate(
    fixture("issue-forms/bug.yml"),
    ".github/ISSUE_TEMPLATE/bug.yml",
  );
  const feature = parseIssueFormTemplate(
    fixture("issue-forms/feature.yml"),
    ".github/ISSUE_TEMPLATE/feature.yml",
  );

  it("extracts required field states without inventing evidence for a missing field", () => {
    const submission = normalizeIssueFormSubmission(
      fixture("issue-forms/rendered-bug.md"),
      bug,
    );
    expect(
      submission.fields.map(({ fieldId, status }) => ({ fieldId, status })),
    ).toEqual([
      { fieldId: "observed", status: "PRESENT" },
      { fieldId: "expected", status: "PLACEHOLDER" },
      { fieldId: "reproduction", status: "EMPTY" },
    ]);
    const expected = submission.fields.find(
      (field) => field.fieldId === "expected",
    );
    expect(expected?.value).toBe("What should happen?");
    expect(expected?.valueSpan).not.toBeNull();
  });

  it("selects a unique strongest match", () => {
    const result = matchIssueFormTemplates({
      issueTitle: "[Bug] Emoji rendering regressed",
      issueLabels: ["bug", "triage"],
      issueBody: fixture("issue-forms/rendered-bug.md"),
      templates: [feature, bug],
    });
    expect(result.status).toBe("MATCHED");
    expect(result.templatePath).toBe(".github/ISSUE_TEMPLATE/bug.yml");
  });

  it("returns AMBIGUOUS when two templates share the strongest evidence", () => {
    const clone = parseIssueFormTemplate(
      fixture("issue-forms/bug.yml"),
      ".github/ISSUE_TEMPLATE/bug-copy.yml",
    );
    const result = matchIssueFormTemplates({
      issueTitle: "[Bug] Emoji rendering regressed",
      issueLabels: ["bug", "triage"],
      issueBody: fixture("issue-forms/rendered-bug.md"),
      templates: [bug, clone],
    });
    expect(result.status).toBe("AMBIGUOUS");
    expect(result.templatePath).toBeNull();
  });

  it("returns NONE when only weak or absent signals exist", () => {
    const result = matchIssueFormTemplates({
      issueTitle: "Unstructured request",
      issueLabels: [],
      issueBody: "Please consider this change.",
      templates: [bug, feature],
    });
    expect(result.status).toBe("NONE");
  });

  it("rejects aliases and duplicate field IDs", () => {
    expect(() =>
      parseIssueFormTemplate(
        "name: Test\ndescription: Test\nbody:\n  - &field\n    type: input\n    id: same\n    attributes: { label: One }\n  - *field\n",
      ),
    ).toThrow(/aliases|alias/iu);
    expect(() =>
      parseIssueFormTemplate(
        "name: Test\ndescription: Test\nbody:\n  - type: input\n    id: same\n    attributes: { label: One }\n  - type: input\n    id: same\n    attributes: { label: Two }\n",
      ),
    ).toThrow(/unique/iu);
  });

  it("keeps Markdown and Issue Form projections inside the JSON Schema contract", () => {
    const validate = new Ajv2020({ strict: true }).compile(
      schema("v1alpha1/normalization.schema.json"),
    );
    const markdown = normalizeMarkdown(fixture("issue-forms/rendered-bug.md"));
    const submission = normalizeIssueFormSubmission(
      fixture("issue-forms/rendered-bug.md"),
      bug,
    );
    expect(validate(markdown), validate.errors?.map(String).join("\n")).toBe(
      true,
    );
    expect(validate(submission), validate.errors?.map(String).join("\n")).toBe(
      true,
    );
  });
});
