import { createHash } from "node:crypto";

import type { Sha256Digest } from "@issueready/domain";
import {
  evaluatePolicyDisposition,
  mergePolicies,
  type MergedPolicy,
  type PolicyLayerSource,
  type TaskTypeSelection,
} from "@issueready/policy";
import { buildReport, type ReportUsageInput } from "@issueready/report";
import {
  executeDeterministicSnapshot,
  type RuleSignal,
} from "@issueready/rules";
import type {
  IssueReadyPolicyV1Alpha1,
  IssueReadyReportV1Alpha1,
  IssueSnapshotV1Alpha1,
  LocaleBundleV1Alpha1,
  RuleManifestV1Alpha1,
  TaskPackManifestV1Alpha1,
} from "@issueready/schema";
import {
  buildSnapshot,
  prepareEvaluation,
  verifySnapshot,
  type ImmutableIssueSnapshot,
} from "@issueready/snapshot";

export { renderReport } from "@issueready/report";
export type { ReportFormat, RenderReportOptions } from "@issueready/report";

export interface NormalizeIssueInput {
  readonly source: IssueSnapshotV1Alpha1["source"];
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
  readonly comments?: readonly Readonly<Record<string, unknown>>[];
  readonly native?: IssueSnapshotV1Alpha1["native"];
  readonly accessContext?: Readonly<{
    authorAssociation?: string | null;
    includedCommentIds?: readonly string[];
  }>;
}

export interface NormalizeIssueOptions {
  readonly evaluatedAt: string;
  readonly truncated?: boolean;
  readonly omittedBytes?: number;
}

export interface PolicySourceLayer {
  readonly source: PolicyLayerSource;
  readonly policy: IssueReadyPolicyV1Alpha1;
}

export interface EvaluationAssets {
  readonly rules: readonly RuleManifestV1Alpha1[];
  readonly taskPacks: readonly TaskPackManifestV1Alpha1[];
  readonly localeBundle: LocaleBundleV1Alpha1;
}

export interface EvaluateIssueAdapters {
  readonly semanticRuleSignals?: readonly RuleSignal[];
  readonly semanticProfileDigest?: Sha256Digest | null;
}

export interface EvaluateIssueOptions {
  readonly assets: EvaluationAssets;
  readonly coreVersion: string;
  readonly agentCapabilityProfile: string;
  readonly supervisionProfile: string;
  readonly generatedAt: string;
  readonly explicitTaskType?: string | null;
  readonly issueFormTemplatePath?: string | null;
  readonly deterministicTaskHint?: string | null;
  readonly semanticTaskHint?: string | null;
  readonly changedPaths?: readonly string[];
  readonly includeEvidenceQuotes?: boolean;
  readonly usage?: ReportUsageInput;
  readonly adapters?: EvaluateIssueAdapters;
}

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
      throw new TypeError("Core values must be finite");
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
  throw new TypeError("Core values must be JSON-compatible");
}

function digest(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function defaultNative(): IssueSnapshotV1Alpha1["native"] {
  const unavailable = () => ({
    availability: "UNAVAILABLE" as const,
    checkedBy: "LOCAL_SOURCE" as const,
    reason: "SOURCE_NOT_APPLICABLE" as const,
  });
  return {
    issueType: null,
    fields: [],
    parent: null,
    subIssues: [],
    blockedBy: [],
    blocking: [],
    capabilities: {
      issueTypes: unavailable(),
      fields: unavailable(),
      parent: unavailable(),
      subIssues: unavailable(),
      dependencies: unavailable(),
      references: unavailable(),
    },
    references: [],
  };
}

function nativeIssueTypeName(snapshot: ImmutableIssueSnapshot): string | null {
  const issueType = snapshot.native.issueType;
  if (!isRecord(issueType)) return null;
  const name = issueType["name"];
  return typeof name === "string" ? name : null;
}

function validateLocaleCoverage(
  assets: EvaluationAssets,
  locale: string,
): void {
  if (assets.localeBundle.locale !== locale) {
    throw new TypeError(
      `Policy locale ${locale} does not match bundle ${assets.localeBundle.locale}`,
    );
  }
  const requiredKeys = new Set([
    ...assets.rules.map((rule) => rule.messageKey),
    ...assets.taskPacks.flatMap((pack) => [
      pack.displayNameKey,
      ...pack.nonRequirements,
    ]),
  ]);
  const missing = [...requiredKeys]
    .filter((key) => assets.localeBundle.messages[key] === undefined)
    .sort();
  if (missing.length > 0) {
    throw new TypeError(`Locale bundle is missing keys: ${missing.join(",")}`);
  }
}

function validateSemanticLock(options: EvaluateIssueOptions): void {
  const semanticSignals = options.adapters?.semanticRuleSignals ?? [];
  const invalidSignal = semanticSignals.find(
    (signal) => !signal.source.startsWith("semantic-criterion:"),
  );
  if (invalidSignal !== undefined) {
    throw new TypeError(
      `Public adapters cannot inject deterministic source ${invalidSignal.source}`,
    );
  }
  const hasSemanticInput =
    semanticSignals.length > 0 || options.semanticTaskHint != null;
  if (
    hasSemanticInput &&
    (options.adapters?.semanticProfileDigest === undefined ||
      options.adapters.semanticProfileDigest === null)
  ) {
    throw new TypeError(
      "Semantic rule signals require an immutable semanticProfileDigest",
    );
  }
}

export function normalizeIssue(
  input: NormalizeIssueInput,
  options: NormalizeIssueOptions,
): ImmutableIssueSnapshot {
  return buildSnapshot({
    source: input.source,
    title: input.title,
    body: input.body,
    labels: input.labels ?? [],
    comments: input.comments ?? [],
    native: input.native ?? defaultNative(),
    ...(input.accessContext === undefined
      ? {}
      : { accessContext: input.accessContext }),
    evaluatedAt: options.evaluatedAt,
    truncated: options.truncated ?? false,
    omittedBytes: options.omittedBytes ?? 0,
  });
}

export function loadPolicy(layers: readonly PolicySourceLayer[]): MergedPolicy {
  return mergePolicies(
    layers.map((layer) => ({
      source: layer.source,
      digest: digest(layer.policy),
      policy: layer.policy,
    })),
  );
}

export function evaluateIssue(
  snapshot: ImmutableIssueSnapshot,
  policy: MergedPolicy,
  options: EvaluateIssueOptions,
): IssueReadyReportV1Alpha1 {
  validateLocaleCoverage(options.assets, policy.policy.spec.locale);
  validateSemanticLock(options);
  const snapshotValid = verifySnapshot(snapshot);
  const taskType: TaskTypeSelection = snapshotValid
    ? prepareEvaluation({
        snapshot,
        policy: policy.policy,
        policyDigest: policy.digest,
        explicitTaskType: options.explicitTaskType ?? null,
        issueFormTemplatePath: options.issueFormTemplatePath ?? null,
        deterministicHint: options.deterministicTaskHint ?? null,
        semanticHint: options.semanticTaskHint ?? null,
      }).taskType
    : {
        taskType: "generic",
        source: "FALLBACK",
        attempts: [
          {
            source: "FALLBACK",
            status: "MATCHED",
            taskType: "generic",
            evidence: [],
          },
        ],
      };
  const nativeIssueType = snapshotValid ? nativeIssueTypeName(snapshot) : null;
  const policyDisposition = evaluatePolicyDisposition({
    policy: policy.policy,
    nativeIssueType,
    labels: snapshotValid ? snapshot.content.labels : [],
    changedPaths: snapshotValid ? (options.changedPaths ?? []) : [],
  });
  const execution = executeDeterministicSnapshot({
    snapshot,
    taskType: taskType.taskType,
    rules: options.assets.rules,
    taskPacks: options.assets.taskPacks,
    policyDisposition,
    ...(!snapshotValid || options.adapters?.semanticRuleSignals === undefined
      ? {}
      : { additionalSignals: options.adapters.semanticRuleSignals }),
  });
  const selectedTaskPack = options.assets.taskPacks.find(
    (pack) => pack.id === taskType.taskType,
  );
  if (selectedTaskPack === undefined) {
    throw new TypeError(`Missing task pack asset: ${taskType.taskType}`);
  }
  return buildReport({
    snapshot,
    policyDigest: policy.digest,
    taskType,
    execution,
    engineLock: {
      coreVersion: options.coreVersion,
      ruleCatalogDigest: digest(
        [...options.assets.rules].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      ),
      taskPackDigest: digest(selectedTaskPack),
      localeBundleDigest: digest(options.assets.localeBundle),
      semanticProfileDigest: options.adapters?.semanticProfileDigest ?? null,
    },
    agentCapabilityProfile: options.agentCapabilityProfile,
    supervisionProfile: options.supervisionProfile,
    generatedAt: options.generatedAt,
    ...(options.includeEvidenceQuotes === undefined
      ? {}
      : { includeEvidenceQuotes: options.includeEvidenceQuotes }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  });
}
