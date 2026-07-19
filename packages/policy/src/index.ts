import { createHash } from "node:crypto";

import {
  TASK_TYPES,
  type DelegationDisposition,
  type Sha256Digest,
  type TaskType,
} from "@issueready/domain";
import type { IssueReadyPolicyV1Alpha1 } from "@issueready/schema";

export type PolicyLayerSource =
  "BUILT_IN" | "DEPLOYMENT_ADMIN" | "DEFAULT_BRANCH" | "CLI_POLICY";

export interface PolicyLayer {
  readonly source: PolicyLayerSource;
  readonly digest: Sha256Digest;
  readonly policy: IssueReadyPolicyV1Alpha1;
}

export interface PolicyProvenance {
  readonly source: PolicyLayerSource;
  readonly digest: Sha256Digest;
}

export interface MergedPolicy {
  readonly policy: IssueReadyPolicyV1Alpha1;
  readonly digest: Sha256Digest;
  readonly provenance: Readonly<Record<string, PolicyProvenance>>;
}

export type TaskTypeSource =
  | "NATIVE_ISSUE_TYPE"
  | "EXPLICIT_CONFIG"
  | "ISSUE_FORM"
  | "TRUSTED_LABEL"
  | "DETERMINISTIC_HINT"
  | "SEMANTIC_CLASSIFIER"
  | "FALLBACK";

export type SelectionAttemptStatus =
  "MATCHED" | "ABSENT" | "UNMAPPED" | "AMBIGUOUS" | "INVALID" | "DISABLED";

export interface TaskTypeSelectionAttempt {
  readonly source: TaskTypeSource;
  readonly status: SelectionAttemptStatus;
  readonly taskType: TaskType | null;
  readonly evidence: readonly string[];
}

export interface AccessContext {
  readonly authorAssociation?: string | null;
}

export interface TaskTypeSelectionInput {
  readonly policy: IssueReadyPolicyV1Alpha1;
  readonly nativeIssueType: string | null;
  readonly explicitTaskType: string | null;
  readonly issueFormTemplatePath: string | null;
  readonly labels: readonly string[];
  readonly deterministicHint: string | null;
  readonly semanticHint: string | null;
  readonly accessContext?: AccessContext;
}

export interface TaskTypeSelection {
  readonly taskType: TaskType;
  readonly source: TaskTypeSource;
  readonly attempts: readonly TaskTypeSelectionAttempt[];
}

export interface DispositionInput {
  readonly policy: IssueReadyPolicyV1Alpha1;
  readonly nativeIssueType: string | null;
  readonly labels: readonly string[];
  readonly changedPaths: readonly string[];
  readonly accessContext?: AccessContext;
}

export interface DispositionReason {
  readonly source:
    "DEFAULT" | "NATIVE_ISSUE_TYPE" | "TRUSTED_LABEL" | "LOCAL_FINDING";
  readonly key: string;
  readonly disposition: Exclude<DelegationDisposition, "UNKNOWN">;
}

export interface PolicyDisposition {
  readonly disposition: Exclude<DelegationDisposition, "UNKNOWN">;
  readonly reasons: readonly DispositionReason[];
  readonly localFindingIds: readonly string[];
}

const POLICY_PRECEDENCE: Readonly<Record<PolicyLayerSource, number>> = {
  BUILT_IN: 0,
  DEPLOYMENT_ADMIN: 1,
  DEFAULT_BRANCH: 2,
  CLI_POLICY: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreeze(entry));
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    Object.values(value).forEach((entry) => deepFreeze(entry));
    return Object.freeze(value) as Readonly<T>;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function calculatePolicyDigest(
  policy: IssueReadyPolicyV1Alpha1,
): Sha256Digest {
  return digest(policy);
}

function flattenLeaves(value: unknown, path: string, output: string[]): void {
  if (
    Array.isArray(value) ||
    !isRecord(value) ||
    Object.keys(value).length === 0
  ) {
    output.push(path);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
    flattenLeaves(child, `${path}/${escaped}`, output);
  }
}

function mergeMappings<Value>(
  lower: Readonly<Record<string, Value>> | undefined,
  higher: Readonly<Record<string, Value>> | undefined,
): Record<string, Value> | undefined {
  if (lower === undefined && higher === undefined) return undefined;
  return { ...(lower ?? {}), ...(higher ?? {}) };
}

function mergeLocalFindings(
  lower: IssueReadyPolicyV1Alpha1["spec"]["localFindings"],
  higher: IssueReadyPolicyV1Alpha1["spec"]["localFindings"],
): IssueReadyPolicyV1Alpha1["spec"]["localFindings"] {
  if (higher === undefined) return lower;
  const byId = new Map((lower ?? []).map((finding) => [finding.id, finding]));
  for (const finding of higher) byId.set(finding.id, finding);
  return [...byId.values()];
}

function mergeTwo(
  lower: IssueReadyPolicyV1Alpha1,
  higher: IssueReadyPolicyV1Alpha1,
): IssueReadyPolicyV1Alpha1 {
  const nativeTaskTypeMappings = mergeMappings(
    lower.spec.taskTypes?.nativeTypeMappings,
    higher.spec.taskTypes?.nativeTypeMappings,
  );
  const issueFormMappings = mergeMappings(
    lower.spec.taskTypes?.issueFormMappings,
    higher.spec.taskTypes?.issueFormMappings,
  );
  const trustedLabelTaskTypeMappings = mergeMappings(
    lower.spec.taskTypes?.trustedLabelMappings,
    higher.spec.taskTypes?.trustedLabelMappings,
  );
  const taskTypes =
    lower.spec.taskTypes === undefined && higher.spec.taskTypes === undefined
      ? undefined
      : {
          ...(nativeTaskTypeMappings === undefined
            ? {}
            : { nativeTypeMappings: nativeTaskTypeMappings }),
          ...(issueFormMappings === undefined ? {} : { issueFormMappings }),
          ...(trustedLabelTaskTypeMappings === undefined
            ? {}
            : { trustedLabelMappings: trustedLabelTaskTypeMappings }),
        };
  const nativeDispositionMappings = mergeMappings(
    lower.spec.delegation?.nativeTypeMappings,
    higher.spec.delegation?.nativeTypeMappings,
  );
  const trustedLabelDispositionMappings = mergeMappings(
    lower.spec.delegation?.trustedLabelMappings,
    higher.spec.delegation?.trustedLabelMappings,
  );
  const defaultDisposition =
    higher.spec.delegation?.default ?? lower.spec.delegation?.default;
  const delegation =
    lower.spec.delegation === undefined && higher.spec.delegation === undefined
      ? undefined
      : {
          ...(defaultDisposition === undefined
            ? {}
            : { default: defaultDisposition }),
          ...(nativeDispositionMappings === undefined
            ? {}
            : { nativeTypeMappings: nativeDispositionMappings }),
          ...(trustedLabelDispositionMappings === undefined
            ? {}
            : { trustedLabelMappings: trustedLabelDispositionMappings }),
        };
  const suggestions =
    lower.spec.suggestions === undefined &&
    higher.spec.suggestions === undefined
      ? undefined
      : { ...lower.spec.suggestions, ...higher.spec.suggestions };
  return {
    apiVersion: higher.apiVersion,
    kind: higher.kind,
    metadata: { name: higher.metadata.name },
    spec: {
      evaluationProfile: higher.spec.evaluationProfile,
      locale: higher.spec.locale,
      ...(taskTypes === undefined ? {} : { taskTypes }),
      ...(() => {
        const localFindings = mergeLocalFindings(
          lower.spec.localFindings,
          higher.spec.localFindings,
        );
        return localFindings === undefined ? {} : { localFindings };
      })(),
      ...(delegation === undefined ? {} : { delegation }),
      context: structuredClone(higher.spec.context),
      ...((higher.spec.semantic ?? lower.spec.semantic) === undefined
        ? {}
        : {
            semantic: structuredClone(
              higher.spec.semantic ?? lower.spec.semantic,
            ),
          }),
      ...(suggestions === undefined ? {} : { suggestions }),
      githubWrite: { mode: "disabled" },
    },
  };
}

export function mergePolicies(layers: readonly PolicyLayer[]): MergedPolicy {
  if (layers.length === 0 || layers[0]?.source !== "BUILT_IN") {
    throw new TypeError("The first policy layer must be BUILT_IN");
  }
  let previousRank = -1;
  const seen = new Set<PolicyLayerSource>();
  for (const layer of layers) {
    if (!/^sha256:[a-f0-9]{64}$/.test(layer.digest)) {
      throw new TypeError(`Invalid policy layer digest for ${layer.source}`);
    }
    if (calculatePolicyDigest(layer.policy) !== layer.digest) {
      throw new TypeError(`Policy layer digest mismatch for ${layer.source}`);
    }
    const rank = POLICY_PRECEDENCE[layer.source];
    if (rank <= previousRank || seen.has(layer.source)) {
      throw new TypeError(
        "Policy layers must be unique and in precedence order",
      );
    }
    seen.add(layer.source);
    previousRank = rank;
  }
  let merged = structuredClone(layers[0].policy);
  const provenance: Record<string, PolicyProvenance> = {};
  for (const layer of layers) {
    if (layer !== layers[0]) merged = mergeTwo(merged, layer.policy);
    const leaves: string[] = [];
    flattenLeaves(layer.policy, "", leaves);
    for (const path of leaves) {
      provenance[path || "/"] = { source: layer.source, digest: layer.digest };
    }
  }
  const frozenPolicy = deepFreeze(merged) as IssueReadyPolicyV1Alpha1;
  return Object.freeze({
    policy: frozenPolicy,
    digest: calculatePolicyDigest(frozenPolicy),
    provenance: deepFreeze(provenance),
  });
}

function isTaskType(value: string): value is TaskType {
  return (TASK_TYPES as readonly string[]).includes(value);
}

function normalizedKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function mappingAttempt(
  source: TaskTypeSource,
  key: string | null,
  mappings: Readonly<Record<string, TaskType>> | undefined,
  normalize: boolean,
): TaskTypeSelectionAttempt {
  if (key === null)
    return { source, status: "ABSENT", taskType: null, evidence: [] };
  if (mappings === undefined) {
    return { source, status: "UNMAPPED", taskType: null, evidence: [key] };
  }
  const matches = Object.entries(mappings).filter(([candidate]) =>
    normalize
      ? normalizedKey(candidate) === normalizedKey(key)
      : candidate === key,
  );
  const values = [...new Set(matches.map(([, value]) => value))];
  if (values.length === 0) {
    return { source, status: "UNMAPPED", taskType: null, evidence: [key] };
  }
  if (values.length > 1) {
    return {
      source,
      status: "AMBIGUOUS",
      taskType: null,
      evidence: matches.map(([candidate]) => candidate).sort(),
    };
  }
  return {
    source,
    status: "MATCHED",
    taskType: values[0] ?? null,
    evidence: matches.map(([candidate]) => candidate).sort(),
  };
}

function directAttempt(
  source: TaskTypeSource,
  value: string | null,
  enabled = true,
): TaskTypeSelectionAttempt {
  if (!enabled)
    return { source, status: "DISABLED", taskType: null, evidence: [] };
  if (value === null)
    return { source, status: "ABSENT", taskType: null, evidence: [] };
  if (!isTaskType(value)) {
    return { source, status: "INVALID", taskType: null, evidence: [value] };
  }
  return { source, status: "MATCHED", taskType: value, evidence: [value] };
}

function labelAttempt(
  labels: readonly string[],
  mappings: Readonly<Record<string, TaskType>> | undefined,
): TaskTypeSelectionAttempt {
  if (labels.length === 0) {
    return {
      source: "TRUSTED_LABEL",
      status: "ABSENT",
      taskType: null,
      evidence: [],
    };
  }
  const mapped = labels.flatMap((label) => {
    const match = mappingAttempt("TRUSTED_LABEL", label, mappings, true);
    return match.status === "MATCHED" && match.taskType !== null
      ? [{ label, taskType: match.taskType }]
      : [];
  });
  const taskTypes = [...new Set(mapped.map((entry) => entry.taskType))];
  if (taskTypes.length === 0) {
    return {
      source: "TRUSTED_LABEL",
      status: "UNMAPPED",
      taskType: null,
      evidence: [...labels],
    };
  }
  if (taskTypes.length > 1) {
    return {
      source: "TRUSTED_LABEL",
      status: "AMBIGUOUS",
      taskType: null,
      evidence: mapped
        .map((entry) => `${entry.label}:${entry.taskType}`)
        .sort(),
    };
  }
  return {
    source: "TRUSTED_LABEL",
    status: "MATCHED",
    taskType: taskTypes[0] ?? null,
    evidence: mapped.map((entry) => entry.label).sort(),
  };
}

export function selectTaskType(
  input: TaskTypeSelectionInput,
): TaskTypeSelection {
  void input.accessContext;
  const mappings = input.policy.spec.taskTypes;
  const attempts: TaskTypeSelectionAttempt[] = [
    mappingAttempt(
      "NATIVE_ISSUE_TYPE",
      input.nativeIssueType,
      mappings?.nativeTypeMappings,
      true,
    ),
    directAttempt("EXPLICIT_CONFIG", input.explicitTaskType),
    mappingAttempt(
      "ISSUE_FORM",
      input.issueFormTemplatePath,
      mappings?.issueFormMappings,
      false,
    ),
    labelAttempt(input.labels, mappings?.trustedLabelMappings),
    directAttempt("DETERMINISTIC_HINT", input.deterministicHint),
    directAttempt(
      "SEMANTIC_CLASSIFIER",
      input.semanticHint,
      input.policy.spec.semantic?.enabled === true,
    ),
    {
      source: "FALLBACK",
      status: "MATCHED",
      taskType: "generic",
      evidence: [],
    },
  ];
  const selected = attempts.find(
    (attempt) => attempt.status === "MATCHED" && attempt.taskType !== null,
  );
  if (selected?.taskType === null || selected === undefined) {
    throw new TypeError("Task type fallback invariant failed");
  }
  return Object.freeze({
    taskType: selected.taskType,
    source: selected.source,
    attempts: deepFreeze(attempts),
  });
}

function strongerDisposition(
  left: Exclude<DelegationDisposition, "UNKNOWN">,
  right: Exclude<DelegationDisposition, "UNKNOWN">,
): Exclude<DelegationDisposition, "UNKNOWN"> {
  const rank = { CANDIDATE: 0, SUPERVISED: 1, HUMAN_ONLY: 2 } as const;
  return rank[right] > rank[left] ? right : left;
}

function normalizedMappingMatches<Value>(
  key: string,
  mappings: Readonly<Record<string, Value>> | undefined,
): readonly [string, Value][] {
  if (mappings === undefined) return [];
  return Object.entries(mappings).filter(
    ([candidate]) => normalizedKey(candidate) === normalizedKey(key),
  );
}

export function evaluatePolicyDisposition(
  input: DispositionInput,
): PolicyDisposition {
  void input.accessContext;
  const reasons: DispositionReason[] = [];
  let disposition = input.policy.spec.delegation?.default ?? "CANDIDATE";
  reasons.push({ source: "DEFAULT", key: "default", disposition });
  if (input.nativeIssueType !== null) {
    for (const [key, effect] of normalizedMappingMatches(
      input.nativeIssueType,
      input.policy.spec.delegation?.nativeTypeMappings,
    )) {
      disposition = strongerDisposition(disposition, effect);
      reasons.push({ source: "NATIVE_ISSUE_TYPE", key, disposition: effect });
    }
  }
  for (const label of input.labels) {
    for (const [key, effect] of normalizedMappingMatches(
      label,
      input.policy.spec.delegation?.trustedLabelMappings,
    )) {
      disposition = strongerDisposition(disposition, effect);
      reasons.push({ source: "TRUSTED_LABEL", key, disposition: effect });
    }
  }
  const localFindingIds: string[] = [];
  for (const finding of input.policy.spec.localFindings ?? []) {
    const labelMatch =
      finding.match.labelsAny?.some((expected) =>
        input.labels.some(
          (label) => normalizedKey(label) === normalizedKey(expected),
        ),
      ) ?? false;
    const nativeTypeMatch =
      input.nativeIssueType !== null &&
      (finding.match.nativeTypesAny?.some(
        (expected) =>
          normalizedKey(expected) ===
          normalizedKey(input.nativeIssueType ?? ""),
      ) ??
        false);
    const pathMatch =
      finding.match.pathPrefixesAny?.some((prefix) =>
        input.changedPaths.some((path) => path.startsWith(prefix)),
      ) ?? false;
    if (!labelMatch && !nativeTypeMatch && !pathMatch) continue;
    disposition = strongerDisposition(disposition, finding.dispositionEffect);
    localFindingIds.push(finding.id);
    reasons.push({
      source: "LOCAL_FINDING",
      key: finding.id,
      disposition: finding.dispositionEffect,
    });
  }
  return Object.freeze({
    disposition,
    reasons: deepFreeze(reasons),
    localFindingIds: Object.freeze(localFindingIds),
  });
}
