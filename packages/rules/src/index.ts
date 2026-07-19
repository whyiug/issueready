import { TASK_TYPES, type TaskType } from "@issueready/domain";
import type {
  RuleManifestV1Alpha1,
  TaskPackManifestV1Alpha1,
} from "@issueready/schema";

export type CatalogIssueCode =
  | "DUPLICATE_RULE_ID"
  | "DUPLICATE_TASK_PACK_ID"
  | "MISSING_REGISTERED_TASK_PACK"
  | "RESERVED_EVALUATION_REASON_AS_RULE"
  | "UNKNOWN_RULE_ID"
  | "RULE_NOT_APPLICABLE"
  | "DUPLICATE_RULE_ASSIGNMENT"
  | "MISSING_APPLICABLE_RULE_ASSIGNMENT"
  | "INVALID_RULE_BUCKET"
  | "INVALID_HARD_PREDICATE_SOURCE"
  | "INVALID_EFFECT_BOUNDARY";

export interface CatalogIssue {
  readonly code: CatalogIssueCode;
  readonly subject: string;
  readonly message: string;
}

export interface CatalogInput {
  readonly rules: readonly RuleManifestV1Alpha1[];
  readonly taskPacks: readonly TaskPackManifestV1Alpha1[];
}

export type CatalogValidation =
  | Readonly<{ valid: true; issues: readonly [] }>
  | Readonly<{ valid: false; issues: readonly CatalogIssue[] }>;

const CRITERIA_BUCKETS = [
  "mandatory",
  "conditional",
  "advisory",
  "evaluation",
  "disposition",
] as const;

type CriteriaBucket = (typeof CRITERIA_BUCKETS)[number];

function issue(
  issues: CatalogIssue[],
  code: CatalogIssueCode,
  subject: string,
  message: string,
): void {
  issues.push({ code, subject, message });
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function validateEffectBoundary(
  manifest: RuleManifestV1Alpha1,
  issues: CatalogIssue[],
): void {
  const fail = manifest.onFail;
  const unknown = manifest.onUnknown;
  if (manifest.hardPredicate !== "none") {
    const sourceKinds = new Set(
      manifest.evidenceSources.map((source) => source.split(":", 1)[0]),
    );
    for (const allowedSource of manifest.hardPredicate.allowedSources) {
      if (!sourceKinds.has(allowedSource)) {
        issue(
          issues,
          "INVALID_HARD_PREDICATE_SOURCE",
          manifest.id,
          `hard predicate source ${allowedSource} is not declared by evidenceSources`,
        );
      }
    }
  }
  if (
    fail.specEffect === "TOO_BROAD" &&
    (manifest.hardPredicate === "none" ||
      manifest.hardPredicate.kind !==
        "independent-goals-with-separate-acceptance")
  ) {
    issue(
      issues,
      "INVALID_EFFECT_BOUNDARY",
      manifest.id,
      "TOO_BROAD requires a mechanical independent-goals hard predicate",
    );
  }
  if (manifest.canonicalLevel === "disposition-only") {
    if (
      fail.evaluationEffect !== "NONE" ||
      fail.specEffect !== "NONE" ||
      fail.dispositionEffect !== "POLICY_DEFINED" ||
      unknown.specEffect !== "NONE" ||
      unknown.dispositionEffect !== "UNKNOWN"
    ) {
      issue(
        issues,
        "INVALID_EFFECT_BOUNDARY",
        manifest.id,
        "disposition-only rules may affect only delegation disposition",
      );
    }
    return;
  }
  if (manifest.canonicalLevel === "evaluation-only") {
    if (
      fail.evaluationEffect !== "ERROR" ||
      fail.specEffect !== "NONE" ||
      fail.dispositionEffect !== "UNKNOWN" ||
      unknown.evaluationEffect !== "DEGRADED" ||
      unknown.specEffect !== "NULL" ||
      unknown.dispositionEffect !== "UNKNOWN"
    ) {
      issue(
        issues,
        "INVALID_EFFECT_BOUNDARY",
        manifest.id,
        "evaluation-only rules must fail closed without producing a spec verdict",
      );
    }
    return;
  }
  if (
    fail.evaluationEffect !== "NONE" ||
    fail.dispositionEffect !== "NONE" ||
    unknown.dispositionEffect !== "NONE"
  ) {
    issue(
      issues,
      "INVALID_EFFECT_BOUNDARY",
      manifest.id,
      "canonical spec rules cannot write evaluation failures or disposition effects",
    );
  }
}

function expectedBucket(
  level: RuleManifestV1Alpha1["canonicalLevel"],
): CriteriaBucket | null {
  if (level === "evaluation-only") return "evaluation";
  if (level === "disposition-only") return "disposition";
  return null;
}

function validateTaskPack(
  pack: TaskPackManifestV1Alpha1,
  rulesById: ReadonlyMap<string, RuleManifestV1Alpha1>,
  issues: CatalogIssue[],
): void {
  const assignments = new Map<string, CriteriaBucket[]>();
  for (const bucket of CRITERIA_BUCKETS) {
    for (const ruleId of pack.criteria[bucket]) {
      const buckets = assignments.get(ruleId) ?? [];
      buckets.push(bucket);
      assignments.set(ruleId, buckets);
      const manifest = rulesById.get(ruleId);
      if (manifest === undefined) {
        issue(
          issues,
          "UNKNOWN_RULE_ID",
          `${pack.id}:${ruleId}`,
          "task pack references an unknown rule",
        );
        continue;
      }
      if (!manifest.appliesTo.includes(pack.id)) {
        issue(
          issues,
          "RULE_NOT_APPLICABLE",
          `${pack.id}:${ruleId}`,
          "rule does not declare this task pack in appliesTo",
        );
      }
      const fixedBucket = expectedBucket(manifest.canonicalLevel);
      if (
        (fixedBucket !== null && bucket !== fixedBucket) ||
        (fixedBucket === null &&
          (bucket === "evaluation" || bucket === "disposition"))
      ) {
        issue(
          issues,
          "INVALID_RULE_BUCKET",
          `${pack.id}:${ruleId}`,
          `rule cannot be assigned to ${bucket}`,
        );
      }
    }
  }
  for (const [ruleId, buckets] of assignments) {
    if (buckets.length > 1) {
      issue(
        issues,
        "DUPLICATE_RULE_ASSIGNMENT",
        `${pack.id}:${ruleId}`,
        `rule assigned to ${buckets.join(",")}`,
      );
    }
  }
  for (const manifest of rulesById.values()) {
    if (manifest.appliesTo.includes(pack.id) && !assignments.has(manifest.id)) {
      issue(
        issues,
        "MISSING_APPLICABLE_RULE_ASSIGNMENT",
        `${pack.id}:${manifest.id}`,
        "every applicable rule must have exactly one registered task-pack bucket",
      );
    }
  }
}

export function validateCatalog(input: CatalogInput): CatalogValidation {
  const issues: CatalogIssue[] = [];
  const duplicateRuleIds = duplicateValues(input.rules.map((rule) => rule.id));
  for (const ruleId of duplicateRuleIds) {
    issue(
      issues,
      "DUPLICATE_RULE_ID",
      ruleId,
      "rule IDs are immutable and unique",
    );
  }
  const duplicatePackIds = duplicateValues(
    input.taskPacks.map((pack) => pack.id),
  );
  for (const packId of duplicatePackIds) {
    issue(
      issues,
      "DUPLICATE_TASK_PACK_ID",
      packId,
      "task-pack IDs must be unique",
    );
  }
  const rulesById = new Map(input.rules.map((rule) => [rule.id, rule]));
  for (const manifest of input.rules) {
    if (manifest.id === "IR-SEM-000") {
      issue(
        issues,
        "RESERVED_EVALUATION_REASON_AS_RULE",
        manifest.id,
        "IR-SEM-000 is an evaluation reason code, not a finding rule",
      );
    }
    validateEffectBoundary(manifest, issues);
  }
  const taskPacksById = new Map(input.taskPacks.map((pack) => [pack.id, pack]));
  for (const taskType of TASK_TYPES) {
    if (!taskPacksById.has(taskType)) {
      issue(
        issues,
        "MISSING_REGISTERED_TASK_PACK",
        taskType,
        "all registered task packs must be present",
      );
    }
  }
  for (const pack of input.taskPacks) validateTaskPack(pack, rulesById, issues);
  if (issues.length === 0) return { valid: true, issues: [] };
  return {
    valid: false,
    issues: Object.freeze(
      issues.sort(
        (left, right) =>
          left.code.localeCompare(right.code) ||
          left.subject.localeCompare(right.subject),
      ),
    ),
  };
}

export function isRegisteredTaskType(value: string): value is TaskType {
  return (TASK_TYPES as readonly string[]).includes(value);
}

export * from "./execution.js";
