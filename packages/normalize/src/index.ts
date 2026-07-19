import { createHash } from "node:crypto";

import type { EvidenceSpan, Sha256Digest } from "@issueready/domain";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parseDocument } from "yaml";

interface AstPoint {
  readonly line: number;
  readonly column: number;
  readonly offset?: number;
}

interface AstPosition {
  readonly start: AstPoint;
  readonly end: AstPoint;
}

interface AstNode {
  readonly type: string;
  readonly position?: AstPosition;
  readonly children?: readonly AstNode[];
  readonly value?: string;
  readonly depth?: number;
  readonly lang?: string | null;
  readonly url?: string;
  readonly title?: string | null;
  readonly identifier?: string;
}

type UnknownRecord = Record<string, unknown>;

export interface Utf16Point {
  readonly offsetUtf16: number;
  readonly line: number;
  readonly columnUtf16: number;
}

export interface TextSpan {
  readonly document: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface MarkdownHeading {
  readonly depth: number;
  readonly text: string;
  readonly span: TextSpan;
  readonly sectionSpan: TextSpan;
}

export interface MarkdownChecklistItem {
  readonly checked: boolean;
  readonly text: string;
  readonly span: TextSpan;
}

export interface MarkdownCodeFence {
  readonly language: string | null;
  readonly value: string;
  readonly span: TextSpan;
}

export interface MarkdownLink {
  readonly kind: "INLINE" | "REFERENCE" | "DEFINITION";
  readonly text: string;
  readonly url: string | null;
  readonly identifier: string | null;
  readonly span: TextSpan;
}

export interface NormalizedMarkdown {
  readonly document: string;
  readonly source: string;
  readonly sourceDigest: Sha256Digest;
  readonly headings: readonly MarkdownHeading[];
  readonly checklistItems: readonly MarkdownChecklistItem[];
  readonly codeFences: readonly MarkdownCodeFence[];
  readonly links: readonly MarkdownLink[];
}

export type IssueFormFieldKind =
  "MARKDOWN" | "INPUT" | "TEXTAREA" | "DROPDOWN" | "CHECKBOXES";

export interface IssueFormOption {
  readonly label: string;
  readonly required: boolean;
}

export interface IssueFormField {
  readonly kind: IssueFormFieldKind;
  readonly id: string | null;
  readonly label: string | null;
  readonly required: boolean;
  readonly placeholder: string | null;
  readonly defaultValue: string | null;
  readonly options: readonly IssueFormOption[];
  readonly markdown: string | null;
}

export interface IssueFormTemplate {
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly titlePrefix: string;
  readonly labels: readonly string[];
  readonly fields: readonly IssueFormField[];
}

export type IssueFormFieldStatus =
  "PRESENT" | "EMPTY" | "PLACEHOLDER" | "MISSING" | "AMBIGUOUS";

export interface NormalizedIssueFormField {
  readonly fieldId: string;
  readonly kind: Exclude<IssueFormFieldKind, "MARKDOWN">;
  readonly label: string;
  readonly required: boolean;
  readonly status: IssueFormFieldStatus;
  readonly value: string | null;
  readonly headingSpan: TextSpan | null;
  readonly valueSpan: TextSpan | null;
}

export interface NormalizedIssueFormSubmission {
  readonly templatePath: string;
  readonly markdown: NormalizedMarkdown;
  readonly fields: readonly NormalizedIssueFormField[];
}

export interface IssueFormMatchCandidate {
  readonly templatePath: string;
  readonly score: number;
  readonly eligible: boolean;
  readonly renderedHeadingSequenceMatch: boolean;
  readonly matchedFieldCount: number;
  readonly requiredFieldHeadingCount: number;
  readonly titlePrefixMatch: boolean;
  readonly defaultLabelsMatch: boolean;
  readonly placeholderSignatureCount: number;
}

export type IssueFormMatch =
  | Readonly<{
      status: "MATCHED";
      templatePath: string;
      candidates: readonly IssueFormMatchCandidate[];
    }>
  | Readonly<{
      status: "AMBIGUOUS" | "NONE";
      templatePath: null;
      candidates: readonly IssueFormMatchCandidate[];
    }>;

export interface MatchIssueFormInput {
  readonly issueTitle: string;
  readonly issueLabels: readonly string[];
  readonly issueBody: string;
  readonly templates: readonly IssueFormTemplate[];
  readonly document?: string;
}

export class IssueFormParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueFormParseError";
  }
}

function sha256(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, context: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new IssueFormParseError(`${context} must be an object`);
  }
  return value;
}

function requiredString(
  value: unknown,
  context: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new IssueFormParseError(`${context} must be a string`);
  }
  return value;
}

function optionalString(value: unknown, context: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, context, true);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

export function isUtf16Boundary(source: string, offsetUtf16: number): boolean {
  if (!Number.isInteger(offsetUtf16)) return false;
  if (offsetUtf16 < 0 || offsetUtf16 > source.length) return false;
  if (offsetUtf16 === 0 || offsetUtf16 === source.length) return true;
  return !(
    isHighSurrogate(source.charCodeAt(offsetUtf16 - 1)) &&
    isLowSurrogate(source.charCodeAt(offsetUtf16))
  );
}

function assertUtf16Boundary(source: string, offsetUtf16: number): void {
  if (!isUtf16Boundary(source, offsetUtf16)) {
    throw new RangeError(
      `Offset ${offsetUtf16} is outside the source or splits a UTF-16 surrogate pair`,
    );
  }
}

function lineStarts(source: string): readonly number[] {
  const starts: number[] = [0];
  for (let index = 0; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index);
    if (codeUnit === 0x0d && source.charCodeAt(index + 1) === 0x0a) {
      starts.push(index + 2);
      index += 1;
    } else if (codeUnit === 0x0a || codeUnit === 0x0d) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function findLineIndex(starts: readonly number[], offsetUtf16: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = starts[middle];
    if (value === undefined) break;
    if (value <= offsetUtf16) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, high);
}

export function utf16PointAt(source: string, offsetUtf16: number): Utf16Point {
  assertUtf16Boundary(source, offsetUtf16);
  const starts = lineStarts(source);
  const lineIndex = findLineIndex(starts, offsetUtf16);
  const start = starts[lineIndex] ?? 0;
  return {
    offsetUtf16,
    line: lineIndex + 1,
    columnUtf16: offsetUtf16 - start + 1,
  };
}

export function createTextSpan(
  document: string,
  source: string,
  startUtf16: number,
  endUtf16: number,
): TextSpan {
  if (document.trim() === "") throw new TypeError("document must not be empty");
  assertUtf16Boundary(source, startUtf16);
  assertUtf16Boundary(source, endUtf16);
  if (endUtf16 < startUtf16) {
    throw new RangeError(
      "endUtf16 must be greater than or equal to startUtf16",
    );
  }
  const starts = lineStarts(source);
  const startLineIndex = findLineIndex(starts, startUtf16);
  const endLineOffset = endUtf16 > startUtf16 ? endUtf16 - 1 : startUtf16;
  return {
    document,
    startUtf16,
    endUtf16,
    lineStart: startLineIndex + 1,
    lineEnd: findLineIndex(starts, endLineOffset) + 1,
  };
}

export function createEvidenceSpan(
  document: string,
  source: string,
  startUtf16: number,
  endUtf16: number,
  snapshotDigest: Sha256Digest,
  maxQuoteUtf16 = 512,
): EvidenceSpan {
  if (!/^sha256:[a-f0-9]{64}$/.test(snapshotDigest)) {
    throw new TypeError("snapshotDigest must be a lowercase SHA-256 digest");
  }
  if (!Number.isInteger(maxQuoteUtf16) || maxQuoteUtf16 < 0) {
    throw new RangeError("maxQuoteUtf16 must be a non-negative integer");
  }
  const span = createTextSpan(document, source, startUtf16, endUtf16);
  const quote = source.slice(startUtf16, endUtf16);
  return Object.freeze({
    ...span,
    snapshotDigest,
    ...(quote.length <= maxQuoteUtf16 ? { quote } : {}),
  });
}

function nodeSpan(
  document: string,
  source: string,
  node: AstNode,
): TextSpan | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  return createTextSpan(document, source, start, end);
}

function textContent(node: AstNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textContent).join("");
}

function trimSpan(
  document: string,
  source: string,
  startUtf16: number,
  endUtf16: number,
): TextSpan {
  let start = startUtf16;
  let end = endUtf16;
  while (start < end && /\s/u.test(source[start] ?? "")) start += 1;
  while (end > start && /\s/u.test(source[end - 1] ?? "")) end -= 1;
  return createTextSpan(document, source, start, end);
}

function freezeArray<T>(values: T[]): readonly T[] {
  values.forEach((value) => {
    if (typeof value === "object" && value !== null) Object.freeze(value);
  });
  return Object.freeze(values);
}

export function normalizeMarkdown(
  source: string,
  document = "issue.body",
): NormalizedMarkdown {
  const root = fromMarkdown(source) as AstNode;
  const rawHeadings: Array<{
    depth: number;
    text: string;
    span: TextSpan;
  }> = [];
  const checklistItems: MarkdownChecklistItem[] = [];
  const codeFences: MarkdownCodeFence[] = [];
  const links: MarkdownLink[] = [];

  const visit = (node: AstNode): void => {
    const span = nodeSpan(document, source, node);
    if (node.type === "heading" && span !== null) {
      rawHeadings.push({
        depth: node.depth ?? 1,
        text: textContent(node).trim(),
        span,
      });
    } else if (node.type === "listItem" && span !== null) {
      const raw = source.slice(span.startUtf16, span.endUtf16);
      const marker = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\][ \t]*/u.exec(
        raw,
      );
      if (marker !== null) {
        checklistItems.push({
          checked: marker[1]?.toLowerCase() === "x",
          text: textContent(node)
            .replace(/^\[[ xX]\][ \t]*/u, "")
            .trim(),
          span,
        });
      }
    } else if (node.type === "code" && span !== null) {
      const raw = source.slice(span.startUtf16, span.endUtf16);
      if (/^ {0,3}(?:`{3,}|~{3,})/u.test(raw)) {
        codeFences.push({
          language: node.lang ?? null,
          value: node.value ?? "",
          span,
        });
      }
    } else if (node.type === "link" && span !== null) {
      links.push({
        kind: "INLINE",
        text: textContent(node),
        url: node.url ?? null,
        identifier: null,
        span,
      });
    } else if (node.type === "linkReference" && span !== null) {
      links.push({
        kind: "REFERENCE",
        text: textContent(node),
        url: null,
        identifier: node.identifier ?? null,
        span,
      });
    } else if (node.type === "definition" && span !== null) {
      links.push({
        kind: "DEFINITION",
        text: "",
        url: node.url ?? null,
        identifier: node.identifier ?? null,
        span,
      });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);

  const headings: MarkdownHeading[] = rawHeadings.map((heading, index) => {
    let sectionEnd = source.length;
    for (
      let nextIndex = index + 1;
      nextIndex < rawHeadings.length;
      nextIndex += 1
    ) {
      const next = rawHeadings[nextIndex];
      if (next !== undefined && next.depth <= heading.depth) {
        sectionEnd = next.span.startUtf16;
        break;
      }
    }
    return {
      ...heading,
      sectionSpan: createTextSpan(
        document,
        source,
        heading.span.endUtf16,
        sectionEnd,
      ),
    };
  });

  return Object.freeze({
    document,
    source,
    sourceDigest: sha256(source),
    headings: freezeArray(headings),
    checklistItems: freezeArray(checklistItems),
    codeFences: freezeArray(codeFences),
    links: freezeArray(links),
  });
}

function parseLabels(value: unknown): readonly string[] {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  return freezeArray(
    values.map((label, index) =>
      requiredString(label, `labels[${index}]`).trim(),
    ),
  );
}

function parseOptions(
  kind: IssueFormFieldKind,
  value: unknown,
  context: string,
): readonly IssueFormOption[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new IssueFormParseError(`${context} must be an array`);
  }
  return freezeArray(
    value.map((option, index) => {
      if (typeof option === "string") {
        return {
          label: requiredString(option, `${context}[${index}]`),
          required: false,
        };
      }
      const optionRecord = record(option, `${context}[${index}]`);
      const label = requiredString(
        optionRecord["label"],
        `${context}[${index}].label`,
      );
      const required =
        kind === "CHECKBOXES" && optionRecord["required"] === true;
      return { label, required };
    }),
  );
}

function parseField(value: unknown, index: number): IssueFormField {
  const item = record(value, `body[${index}]`);
  const rawType = requiredString(item["type"], `body[${index}].type`);
  const kindMap: Readonly<Record<string, IssueFormFieldKind>> = {
    markdown: "MARKDOWN",
    input: "INPUT",
    textarea: "TEXTAREA",
    dropdown: "DROPDOWN",
    checkboxes: "CHECKBOXES",
  };
  const kind = kindMap[rawType];
  if (kind === undefined) {
    throw new IssueFormParseError(`body[${index}].type is not supported`);
  }
  const attributes = record(item["attributes"], `body[${index}].attributes`);
  if (kind === "MARKDOWN") {
    return Object.freeze({
      kind,
      id: null,
      label: null,
      required: false,
      placeholder: null,
      defaultValue: null,
      options: [],
      markdown: requiredString(
        attributes["value"],
        `body[${index}].attributes.value`,
        true,
      ),
    });
  }

  const id = requiredString(item["id"], `body[${index}].id`);
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) {
    throw new IssueFormParseError(`body[${index}].id has invalid characters`);
  }
  const validations =
    item["validations"] === undefined
      ? {}
      : record(item["validations"], `body[${index}].validations`);
  return Object.freeze({
    kind,
    id,
    label: requiredString(
      attributes["label"],
      `body[${index}].attributes.label`,
    ).trim(),
    required: validations["required"] === true,
    placeholder: optionalString(
      attributes["placeholder"],
      `body[${index}].attributes.placeholder`,
    ),
    defaultValue: optionalString(
      attributes["value"],
      `body[${index}].attributes.value`,
    ),
    options: parseOptions(
      kind,
      attributes["options"],
      `body[${index}].attributes.options`,
    ),
    markdown: null,
  });
}

export function parseIssueFormTemplate(
  yamlSource: string,
  path = ".github/ISSUE_TEMPLATE/unknown.yml",
): IssueFormTemplate {
  const parsed = parseDocument(yamlSource, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (parsed.errors.length > 0) {
    throw new IssueFormParseError(
      `Invalid Issue Form YAML: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  }
  let value: unknown;
  try {
    value = parsed.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new IssueFormParseError(
      `Issue Form aliases are not accepted: ${error instanceof Error ? error.message : "invalid alias"}`,
    );
  }
  const form = record(value, "Issue Form");
  if (!Array.isArray(form["body"])) {
    throw new IssueFormParseError("Issue Form body must be an array");
  }
  const fields = form["body"].map(parseField);
  const ids = fields
    .map((field) => field.id)
    .filter((id): id is string => id !== null);
  if (new Set(ids).size !== ids.length) {
    throw new IssueFormParseError("Issue Form field IDs must be unique");
  }
  return Object.freeze({
    path,
    name: requiredString(form["name"], "name").trim(),
    description: requiredString(form["description"], "description", true),
    titlePrefix: optionalString(form["title"], "title") ?? "",
    labels: parseLabels(form["labels"]),
    fields: freezeArray(fields),
  });
}

function normalizedLabel(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

type InteractiveIssueFormField = Omit<
  IssueFormField,
  "kind" | "id" | "label"
> & {
  readonly kind: Exclude<IssueFormFieldKind, "MARKDOWN">;
  readonly id: string;
  readonly label: string;
};

function interactiveFields(
  template: IssueFormTemplate,
): ReadonlyArray<InteractiveIssueFormField> {
  return template.fields.filter(
    (field): field is InteractiveIssueFormField =>
      field.kind !== "MARKDOWN" && field.id !== null && field.label !== null,
  );
}

function isSubsequence(
  needles: readonly string[],
  haystack: readonly string[],
): boolean {
  if (needles.length === 0) return false;
  let needleIndex = 0;
  for (const value of haystack) {
    if (value === needles[needleIndex]) needleIndex += 1;
    if (needleIndex === needles.length) return true;
  }
  return false;
}

function fieldValue(
  markdown: NormalizedMarkdown,
  heading: MarkdownHeading,
): Readonly<{ value: string; span: TextSpan }> {
  const span = trimSpan(
    markdown.document,
    markdown.source,
    heading.sectionSpan.startUtf16,
    heading.sectionSpan.endUtf16,
  );
  return {
    value: markdown.source.slice(span.startUtf16, span.endUtf16),
    span,
  };
}

function fieldStatus(
  field: IssueFormField,
  value: string,
): IssueFormFieldStatus {
  const normalized = value.trim();
  if (normalized === "" || normalized === "_No response_") return "EMPTY";
  if (field.kind === "CHECKBOXES" && !/^\s*[-+*]\s+\[[xX]\]/mu.test(value)) {
    return "EMPTY";
  }
  const signatures = [field.placeholder, field.defaultValue].filter(
    (signature): signature is string => signature !== null && signature !== "",
  );
  if (signatures.some((signature) => normalized === signature.trim())) {
    return "PLACEHOLDER";
  }
  return "PRESENT";
}

export function normalizeIssueFormSubmission(
  issueBody: string,
  template: IssueFormTemplate,
  document = "issue.body",
): NormalizedIssueFormSubmission {
  const markdown = normalizeMarkdown(issueBody, document);
  const headingGroups = new Map<string, MarkdownHeading[]>();
  for (const heading of markdown.headings) {
    const key = normalizedLabel(heading.text);
    const group = headingGroups.get(key) ?? [];
    group.push(heading);
    headingGroups.set(key, group);
  }
  const fields: NormalizedIssueFormField[] = interactiveFields(template).map(
    (field) => {
      const matches = headingGroups.get(normalizedLabel(field.label)) ?? [];
      if (matches.length === 0) {
        return {
          fieldId: field.id,
          kind: field.kind,
          label: field.label,
          required: field.required,
          status: "MISSING",
          value: null,
          headingSpan: null,
          valueSpan: null,
        };
      }
      if (matches.length > 1) {
        return {
          fieldId: field.id,
          kind: field.kind,
          label: field.label,
          required: field.required,
          status: "AMBIGUOUS",
          value: null,
          headingSpan: null,
          valueSpan: null,
        };
      }
      const heading = matches[0];
      if (heading === undefined)
        throw new TypeError("unreachable heading state");
      const extracted = fieldValue(markdown, heading);
      return {
        fieldId: field.id,
        kind: field.kind,
        label: field.label,
        required: field.required,
        status: fieldStatus(field, extracted.value),
        value: extracted.value,
        headingSpan: heading.span,
        valueSpan: extracted.span,
      };
    },
  );
  return Object.freeze({
    templatePath: template.path,
    markdown,
    fields: freezeArray(fields),
  });
}

function matchCandidate(
  issueTitle: string,
  issueLabels: readonly string[],
  markdown: NormalizedMarkdown,
  template: IssueFormTemplate,
): IssueFormMatchCandidate {
  const fields = interactiveFields(template);
  const expectedHeadings = fields.map((field) => normalizedLabel(field.label));
  const actualHeadings = markdown.headings.map((heading) =>
    normalizedLabel(heading.text),
  );
  const submission = normalizeIssueFormSubmission(
    markdown.source,
    template,
    markdown.document,
  );
  const matchedFields = submission.fields.filter(
    (field) => field.status !== "MISSING" && field.status !== "AMBIGUOUS",
  );
  const requiredFieldHeadingCount = matchedFields.filter(
    (field) => field.required,
  ).length;
  const placeholderSignatureCount = matchedFields.filter(
    (field) => field.status === "PLACEHOLDER",
  ).length;
  const renderedHeadingSequenceMatch = isSubsequence(
    expectedHeadings,
    actualHeadings,
  );
  const titlePrefixMatch =
    template.titlePrefix !== "" && issueTitle.startsWith(template.titlePrefix);
  const labelSet = new Set(issueLabels.map(normalizedLabel));
  const defaultLabelsMatch =
    template.labels.length > 0 &&
    template.labels.every((label) => labelSet.has(normalizedLabel(label)));
  const independentSignals =
    Number(renderedHeadingSequenceMatch) +
    Number(titlePrefixMatch) +
    Number(defaultLabelsMatch) +
    Number(placeholderSignatureCount > 0);
  const eligible =
    renderedHeadingSequenceMatch ||
    (matchedFields.length > 0 && independentSignals >= 2) ||
    (titlePrefixMatch && defaultLabelsMatch);
  const score =
    matchedFields.length * 10 +
    requiredFieldHeadingCount * 3 +
    Number(renderedHeadingSequenceMatch) * 20 +
    Number(titlePrefixMatch) * 3 +
    Number(defaultLabelsMatch) * 2 +
    placeholderSignatureCount;
  return Object.freeze({
    templatePath: template.path,
    score,
    eligible,
    renderedHeadingSequenceMatch,
    matchedFieldCount: matchedFields.length,
    requiredFieldHeadingCount,
    titlePrefixMatch,
    defaultLabelsMatch,
    placeholderSignatureCount,
  });
}

export function matchIssueFormTemplates(
  input: MatchIssueFormInput,
): IssueFormMatch {
  const markdown = normalizeMarkdown(
    input.issueBody,
    input.document ?? "issue.body",
  );
  const candidates = input.templates
    .map((template) =>
      matchCandidate(input.issueTitle, input.issueLabels, markdown, template),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.templatePath.localeCompare(right.templatePath),
    );
  const eligible = candidates.filter((candidate) => candidate.eligible);
  if (eligible.length === 0) {
    return Object.freeze({
      status: "NONE",
      templatePath: null,
      candidates: freezeArray(candidates),
    });
  }
  const topScore = eligible[0]?.score;
  const top = eligible.filter((candidate) => candidate.score === topScore);
  if (top.length !== 1) {
    return Object.freeze({
      status: "AMBIGUOUS",
      templatePath: null,
      candidates: freezeArray(candidates),
    });
  }
  const selected = top[0];
  if (selected === undefined) throw new TypeError("unreachable match state");
  return Object.freeze({
    status: "MATCHED",
    templatePath: selected.templatePath,
    candidates: freezeArray(candidates),
  });
}
