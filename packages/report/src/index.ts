import { createHash } from "node:crypto";

import { decide } from "@issueready/decision";
import type { Finding, RuleOutcome, Sha256Digest } from "@issueready/domain";
import type { TaskTypeSelection } from "@issueready/policy";
import type { RuleExecutionResult } from "@issueready/rules";
import type {
  IssueReadyReportV1Alpha1,
  LocaleBundleV1Alpha1,
} from "@issueready/schema";
import {
  verifySnapshot,
  type ImmutableIssueSnapshot,
} from "@issueready/snapshot";

import { redactSensitiveText } from "./redaction.js";

export interface ReportEngineLockInput {
  readonly coreVersion: string;
  readonly ruleCatalogDigest: Sha256Digest;
  readonly taskPackDigest: Sha256Digest;
  readonly localeBundleDigest: Sha256Digest;
  readonly semanticProfileDigest: Sha256Digest | null;
}

export interface ReportUsageInput {
  readonly providerCalls: number;
  readonly semanticInputTokens?: number;
  readonly semanticOutputTokens?: number;
}

export interface BuildReportInput {
  readonly snapshot: ImmutableIssueSnapshot;
  readonly policyDigest: Sha256Digest;
  readonly taskType: TaskTypeSelection;
  readonly execution: RuleExecutionResult;
  readonly engineLock: ReportEngineLockInput;
  readonly agentCapabilityProfile: string;
  readonly supervisionProfile: string;
  readonly generatedAt: string;
  readonly usage?: ReportUsageInput;
  readonly includeEvidenceQuotes?: boolean;
}

export type ReportFormat = "json" | "markdown";

export interface RenderReportOptions {
  readonly localeBundle?: LocaleBundleV1Alpha1;
  readonly includeEvidenceQuotes?: boolean;
  readonly prettyJson?: boolean;
}

type ReportFinding = IssueReadyReportV1Alpha1["canonicalFindings"][number];
type ReportDimension = IssueReadyReportV1Alpha1["dimensions"][number];

const OUTCOME_PRIORITY: Readonly<Record<RuleOutcome, number>> = {
  NOT_APPLICABLE: 0,
  PASS: 1,
  UNKNOWN: 2,
  FAIL: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Report values must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  throw new TypeError("Report values must be JSON-compatible");
}

function sha256(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function assertDigest(
  value: string,
  name: string,
): asserts value is Sha256Digest {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreeze(entry));
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    Object.values(value).forEach((entry) => deepFreeze(entry));
    return Object.freeze(value);
  }
  return value;
}

function compareFindings(left: Finding, right: Finding): number {
  return (
    left.ruleId.localeCompare(right.ruleId) ||
    left.outcome.localeCompare(right.outcome) ||
    left.source.localeCompare(right.source) ||
    left.messageKey.localeCompare(right.messageKey)
  );
}

function reportFinding(
  finding: Finding,
  includeQuotes: boolean,
): ReportFinding {
  return {
    ruleId: finding.ruleId,
    outcome: finding.outcome,
    source: finding.source,
    messageKey: finding.messageKey,
    evidence: finding.evidence.map((span) => ({
      document: span.document,
      startUtf16: span.startUtf16,
      endUtf16: span.endUtf16,
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      ...(includeQuotes && span.quote !== undefined
        ? { quote: redactSensitiveText(span.quote) }
        : {}),
      snapshotDigest: span.snapshotDigest,
    })),
    ...(finding.remediation === undefined
      ? {}
      : { remediation: structuredClone(finding.remediation) }),
  };
}

function strongestOutcome(outcomes: readonly RuleOutcome[]): RuleOutcome {
  let selected: RuleOutcome = "NOT_APPLICABLE";
  for (const outcome of outcomes) {
    if (OUTCOME_PRIORITY[outcome] > OUTCOME_PRIORITY[selected])
      selected = outcome;
  }
  return selected;
}

function dimensions(
  execution: RuleExecutionResult,
): readonly ReportDimension[] {
  const byDimension = new Map<
    string,
    { outcomes: RuleOutcome[]; applicableRuleIds: string[] }
  >();
  for (const rule of execution.rules) {
    if (rule.bucket === "disposition") continue;
    const aggregate = byDimension.get(rule.dimension) ?? {
      outcomes: [],
      applicableRuleIds: [],
    };
    aggregate.outcomes.push(rule.outcome);
    if (rule.outcome !== "NOT_APPLICABLE") {
      aggregate.applicableRuleIds.push(rule.ruleId);
    }
    byDimension.set(rule.dimension, aggregate);
  }
  return [...byDimension.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dimension, aggregate]) => ({
      dimension,
      outcome: strongestOutcome(aggregate.outcomes),
      applicableRuleIds: [...new Set(aggregate.applicableRuleIds)].sort(),
    }));
}

function findingsWithoutQuotes(
  findings: readonly ReportFinding[],
): readonly ReportFinding[] {
  return findings.map((finding) => ({
    ...finding,
    evidence: finding.evidence.map(({ quote: _quote, ...span }) => span),
  }));
}

export function deterministicReportProjection(
  report: IssueReadyReportV1Alpha1,
): unknown {
  return {
    projectionSchemaVersion: "1.0.0-alpha.1",
    source: report.source,
    snapshot: report.snapshot,
    policy: report.policy,
    engineLock: report.engineLock,
    evaluationStatus: report.evaluationStatus,
    specVerdict: report.specVerdict,
    delegationDisposition: report.delegationDisposition,
    agentCapabilityProfile: report.agentCapabilityProfile,
    supervisionProfile: report.supervisionProfile,
    taskType: {
      id: report.taskType.id,
      source: report.taskType.source,
    },
    dimensions: report.dimensions,
    canonicalFindings: findingsWithoutQuotes(report.canonicalFindings),
    policyFindings: findingsWithoutQuotes(report.policyFindings),
    evaluationReasons: report.evaluationReasons,
    questions: report.questions,
    splitDraft: report.splitDraft,
  };
}

export function calculateReportProjectionDigest(
  report: IssueReadyReportV1Alpha1,
): Sha256Digest {
  return sha256(canonicalJson(deterministicReportProjection(report)));
}

export function renderDeterministicReportProjection(
  report: IssueReadyReportV1Alpha1,
): string {
  return `${canonicalJson(deterministicReportProjection(report))}\n`;
}

function isUtf16Boundary(source: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    return false;
  }
  if (offset === 0 || offset === source.length) return true;
  const previous = source.charCodeAt(offset - 1);
  const current = source.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function validateEvidenceBindings(
  findings: readonly Finding[],
  snapshot: ImmutableIssueSnapshot,
): void {
  for (const finding of findings) {
    for (const span of finding.evidence) {
      if (span.snapshotDigest !== snapshot.integrity.snapshotDigest) {
        throw new TypeError(
          `${finding.ruleId} evidence is bound to a different snapshot`,
        );
      }
      if (
        !Number.isInteger(span.startUtf16) ||
        !Number.isInteger(span.endUtf16) ||
        span.startUtf16 < 0 ||
        span.endUtf16 < span.startUtf16 ||
        !Number.isInteger(span.lineStart) ||
        !Number.isInteger(span.lineEnd) ||
        span.lineStart < 1 ||
        span.lineEnd < span.lineStart
      ) {
        throw new TypeError(
          `${finding.ruleId} evidence coordinates are invalid`,
        );
      }
      const source =
        span.document === snapshot.content.normalization.document
          ? snapshot.content.body
          : span.document === "issue.title"
            ? snapshot.content.title
            : null;
      if (source === null) {
        if (span.quote !== undefined) {
          throw new TypeError(
            `${finding.ruleId} evidence quote has no normalized source`,
          );
        }
        continue;
      }
      if (
        !isUtf16Boundary(source, span.startUtf16) ||
        !isUtf16Boundary(source, span.endUtf16)
      ) {
        throw new TypeError(
          `${finding.ruleId} evidence splits a UTF-16 boundary`,
        );
      }
      if (
        span.quote !== undefined &&
        source.slice(span.startUtf16, span.endUtf16) !== span.quote
      ) {
        throw new TypeError(
          `${finding.ruleId} evidence quote does not round-trip`,
        );
      }
    }
  }
}

export function buildReport(input: BuildReportInput): IssueReadyReportV1Alpha1 {
  assertDigest(input.policyDigest, "policyDigest");
  assertDigest(input.engineLock.ruleCatalogDigest, "ruleCatalogDigest");
  assertDigest(input.engineLock.taskPackDigest, "taskPackDigest");
  assertDigest(input.engineLock.localeBundleDigest, "localeBundleDigest");
  if (input.engineLock.semanticProfileDigest !== null) {
    assertDigest(
      input.engineLock.semanticProfileDigest,
      "semanticProfileDigest",
    );
  }
  if (input.engineLock.coreVersion.trim() === "") {
    throw new TypeError("coreVersion must not be empty");
  }
  if (input.agentCapabilityProfile.trim() === "") {
    throw new TypeError("agentCapabilityProfile must not be empty");
  }
  if (input.supervisionProfile.trim() === "") {
    throw new TypeError("supervisionProfile must not be empty");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      input.generatedAt,
    ) ||
    Number.isNaN(Date.parse(input.generatedAt))
  ) {
    throw new TypeError("generatedAt must be a date-time string");
  }
  if (input.execution.taskType !== input.taskType.taskType) {
    throw new TypeError("Task selection and execution task packs do not match");
  }
  const snapshotValid = verifySnapshot(input.snapshot);
  if (input.execution.decisionInput.snapshotValid !== snapshotValid) {
    throw new TypeError(
      "Rule execution snapshot validity does not match snapshot",
    );
  }
  const allFindings = [
    ...input.execution.canonicalFindings,
    ...input.execution.evaluationFindings,
    ...input.execution.policyFindings,
  ];
  validateEvidenceBindings(allFindings, input.snapshot);
  const usage = input.usage ?? { providerCalls: 0 };
  assertNonNegativeInteger(usage.providerCalls, "providerCalls");
  if (usage.semanticInputTokens !== undefined) {
    assertNonNegativeInteger(usage.semanticInputTokens, "semanticInputTokens");
  }
  if (usage.semanticOutputTokens !== undefined) {
    assertNonNegativeInteger(
      usage.semanticOutputTokens,
      "semanticOutputTokens",
    );
  }
  const includeQuotes = (input.includeEvidenceQuotes ?? false) && snapshotValid;
  const canonicalFindings = [
    ...input.execution.canonicalFindings,
    ...input.execution.evaluationFindings,
  ]
    .sort(compareFindings)
    .map((finding) => reportFinding(finding, includeQuotes));
  const policyFindings = [...input.execution.policyFindings]
    .sort(compareFindings)
    .map((finding) => reportFinding(finding, includeQuotes));
  const decision = decide(input.execution.decisionInput);
  const draft: IssueReadyReportV1Alpha1 = {
    schemaVersion: "1.0.0-alpha.1",
    evaluationId: "ir_pending",
    source: structuredClone(input.snapshot.source),
    snapshot: {
      digest: input.snapshot.integrity.snapshotDigest,
      truncated: input.snapshot.integrity.truncated,
      omittedBytes: input.snapshot.integrity.omittedBytes,
    },
    policy: { digest: input.policyDigest },
    engineLock: {
      coreVersion: input.engineLock.coreVersion,
      ruleCatalogDigest: input.engineLock.ruleCatalogDigest,
      taskPackDigest: input.engineLock.taskPackDigest,
      policyDigest: input.policyDigest,
      localeBundleDigest: input.engineLock.localeBundleDigest,
      semanticProfileDigest: input.engineLock.semanticProfileDigest,
      taskPackRevision: input.execution.taskPackRevision,
    },
    evaluationStatus: decision.evaluationStatus,
    specVerdict: decision.specVerdict,
    delegationDisposition: decision.delegationDisposition,
    agentCapabilityProfile: input.agentCapabilityProfile,
    supervisionProfile: input.supervisionProfile,
    taskType: {
      id: input.taskType.taskType,
      source: input.taskType.source,
      attempts: input.taskType.attempts.map((attempt) => ({
        source: attempt.source,
        status: attempt.status,
        taskType: attempt.taskType,
        evidence: [...attempt.evidence].sort(),
      })),
    },
    dimensions: [...dimensions(input.execution)],
    canonicalFindings,
    policyFindings,
    evaluationReasons: [...new Set(input.execution.evaluationReasons)].sort(),
    questions: [],
    splitDraft: null,
    usage: {
      providerCalls: usage.providerCalls,
      ...(usage.semanticInputTokens === undefined
        ? {}
        : { semanticInputTokens: usage.semanticInputTokens }),
      ...(usage.semanticOutputTokens === undefined
        ? {}
        : { semanticOutputTokens: usage.semanticOutputTokens }),
    },
    privacy: {
      quotesIncluded: includeQuotes,
      redacted: true,
    },
    generatedAt: input.generatedAt,
  };
  draft.evaluationId = `ir_${calculateReportProjectionDigest(draft).slice(7)}`;
  return deepFreeze(draft) as IssueReadyReportV1Alpha1;
}

function replaceUnsafeControls(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    output +=
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 8) ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        codePoint === 127)
        ? " "
        : character;
  }
  return output;
}

function escapeMarkdownText(value: string): string {
  const withoutControls = replaceUnsafeControls(value);
  const escapedHtml = withoutControls
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return escapedHtml.replaceAll(/([\\`*_[\]{}()#+.!|~-])/gu, "\\$1");
}

function escapeMarkdownInline(value: string): string {
  return escapeMarkdownText(value.replaceAll(/\s+/gu, " ").trim());
}

function localeMessage(
  bundle: LocaleBundleV1Alpha1,
  key: string,
  required: boolean,
): string | null {
  const message = bundle.messages[key];
  if (message === undefined) {
    if (required) throw new TypeError(`Locale bundle is missing key: ${key}`);
    return null;
  }
  if (message.trim() === "") {
    throw new TypeError(`Locale bundle message is empty: ${key}`);
  }
  return escapeMarkdownInline(message);
}

function assertLocaleBundleBound(
  report: IssueReadyReportV1Alpha1,
  bundle: LocaleBundleV1Alpha1,
): void {
  if (
    bundle.kind !== "LocaleBundle" ||
    bundle.locale.trim() === "" ||
    !isRecord(bundle.messages)
  ) {
    throw new TypeError("Markdown rendering requires a valid locale bundle");
  }
  const actualDigest = sha256(canonicalJson(bundle));
  if (actualDigest !== report.engineLock.localeBundleDigest) {
    throw new TypeError(
      "Locale bundle digest does not match the report engine lock",
    );
  }
}

function renderEvidenceQuote(quote: string): readonly string[] {
  return quote
    .replaceAll(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${escapeMarkdownText(line)}`));
}

function renderMarkdownFindings(
  heading: string,
  findings: readonly ReportFinding[],
  bundle: LocaleBundleV1Alpha1,
  includeEvidenceQuotes: boolean,
  requireMessages: boolean,
): readonly string[] {
  const lines = [`## ${heading}`, ""];
  if (findings.length === 0) return [...lines, "None.", ""];

  for (const finding of findings) {
    const message = localeMessage(bundle, finding.messageKey, requireMessages);
    lines.push(
      `### ${escapeMarkdownInline(finding.ruleId)} — ${escapeMarkdownInline(finding.outcome)}`,
      "",
      message ?? `Locale key: ${escapeMarkdownInline(finding.messageKey)}`,
      "",
      `- Source: ${escapeMarkdownInline(finding.source)}`,
    );
    if (finding.evidence.length === 0) {
      lines.push("- Evidence: none");
    } else {
      lines.push("- Evidence:");
      finding.evidence.forEach((span, index) => {
        lines.push(
          `  - ${index + 1}. ${escapeMarkdownInline(span.document)}; lines ${span.lineStart}-${span.lineEnd}; UTF-16 ${span.startUtf16}-${span.endUtf16}; snapshot ${escapeMarkdownInline(span.snapshotDigest)}`,
        );
        if (includeEvidenceQuotes && span.quote !== undefined) {
          lines.push("", ...renderEvidenceQuote(span.quote), "");
        }
      });
    }
    lines.push("");
  }
  return lines;
}

function renderMarkdownReport(
  report: IssueReadyReportV1Alpha1,
  options: RenderReportOptions,
): string {
  const bundle = options.localeBundle;
  if (bundle === undefined) {
    throw new TypeError("Markdown rendering requires a localeBundle");
  }
  assertLocaleBundleBound(report, bundle);
  const includeEvidenceQuotes =
    (options.includeEvidenceQuotes ?? false) && report.privacy.quotesIncluded;
  if (includeEvidenceQuotes && report.privacy.redacted !== true) {
    throw new TypeError("Unredacted evidence quotes cannot be rendered");
  }
  const taskName = localeMessage(
    bundle,
    `task-packs.${report.taskType.id}.name`,
    true,
  );
  const lines: string[] = [
    "# IssueReady report",
    "",
    `- Evaluation: ${escapeMarkdownInline(report.evaluationId)}`,
    `- Generated: ${escapeMarkdownInline(report.generatedAt)}`,
    `- Source kind: ${escapeMarkdownInline(report.source.kind)}`,
    `- Task: ${taskName ?? escapeMarkdownInline(report.taskType.id)} (${escapeMarkdownInline(report.taskType.id)}, ${escapeMarkdownInline(report.taskType.source)})`,
    `- Evaluation status: ${escapeMarkdownInline(report.evaluationStatus)}`,
    `- Spec verdict: ${escapeMarkdownInline(report.specVerdict ?? "null")}`,
    `- Delegation disposition: ${escapeMarkdownInline(report.delegationDisposition)}`,
    "",
    "## Dimensions",
    "",
    "| Dimension | Outcome | Applicable rules |",
    "| --- | --- | --- |",
    ...report.dimensions.map(
      (dimension) =>
        `| ${escapeMarkdownInline(dimension.dimension)} | ${escapeMarkdownInline(dimension.outcome)} | ${escapeMarkdownInline(dimension.applicableRuleIds.join(", ") || "none")} |`,
    ),
    "",
    ...renderMarkdownFindings(
      "Canonical findings",
      report.canonicalFindings,
      bundle,
      includeEvidenceQuotes,
      true,
    ),
    ...renderMarkdownFindings(
      "Policy findings",
      report.policyFindings,
      bundle,
      includeEvidenceQuotes,
      false,
    ),
    "## Evaluation reasons",
    "",
    ...(report.evaluationReasons.length === 0
      ? ["None."]
      : report.evaluationReasons.map(
          (reason) => `- ${escapeMarkdownInline(reason)}`,
        )),
    "",
    "## Provenance",
    "",
    `- Snapshot digest: ${escapeMarkdownInline(report.snapshot.digest)}`,
    `- Policy digest: ${escapeMarkdownInline(report.policy.digest)}`,
    `- Rule catalog digest: ${escapeMarkdownInline(report.engineLock.ruleCatalogDigest)}`,
    `- Task pack digest: ${escapeMarkdownInline(report.engineLock.taskPackDigest)}`,
    `- Locale bundle digest: ${escapeMarkdownInline(report.engineLock.localeBundleDigest)}`,
    `- Core version: ${escapeMarkdownInline(report.engineLock.coreVersion)}`,
    `- Quotes included in report: ${report.privacy.quotesIncluded ? "yes" : "no"}`,
    `- Quotes expanded in this rendering: ${includeEvidenceQuotes ? "yes" : "no"}`,
    "",
  ];
  return lines.join("\n");
}

export function renderReport(
  report: IssueReadyReportV1Alpha1,
  format: ReportFormat,
  options: RenderReportOptions = {},
): string {
  switch (format) {
    case "json": {
      const stable = canonicalJson(report);
      return options.prettyJson === false
        ? `${stable}\n`
        : `${JSON.stringify(JSON.parse(stable) as unknown, null, 2)}\n`;
    }
    case "markdown":
      return renderMarkdownReport(report, options);
  }
  throw new TypeError(`Unsupported report format: ${String(format)}`);
}
