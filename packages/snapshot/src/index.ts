import { createHash } from "node:crypto";

import type { Sha256Digest } from "@issueready/domain";
import { normalizeMarkdown } from "@issueready/normalize";
import {
  selectTaskType,
  type AccessContext,
  type TaskTypeSelection,
} from "@issueready/policy";
import type {
  IssueReadyPolicyV1Alpha1,
  IssueSnapshotV1Alpha1,
} from "@issueready/schema";

export type DeepReadonly<Value> = Value extends (
  ...arguments_: never[]
) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export type ImmutableIssueSnapshot = DeepReadonly<IssueSnapshotV1Alpha1>;

export interface BuildSnapshotInput {
  readonly source: IssueSnapshotV1Alpha1["source"];
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly comments: readonly Readonly<Record<string, unknown>>[];
  readonly native: IssueSnapshotV1Alpha1["native"];
  readonly accessContext?: AccessContext & {
    readonly includedCommentIds?: readonly string[];
  };
  readonly evaluatedAt: string;
  readonly truncated: boolean;
  readonly omittedBytes: number;
}

export interface PrepareEvaluationInput {
  readonly snapshot: ImmutableIssueSnapshot;
  readonly policy: IssueReadyPolicyV1Alpha1;
  readonly policyDigest: Sha256Digest;
  readonly explicitTaskType: string | null;
  readonly issueFormTemplatePath: string | null;
  readonly deterministicHint: string | null;
  readonly semanticHint: string | null;
}

export interface EvaluationProjection {
  readonly snapshotDigest: Sha256Digest;
  readonly policyDigest: Sha256Digest;
  readonly taskType: TaskTypeSelection;
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
      throw new TypeError("Snapshot values must be finite");
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
  throw new TypeError("Snapshot values must be JSON-compatible");
}

function sha256(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreeze(entry));
    return Object.freeze(value) as DeepReadonly<Value>;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((entry) => deepFreeze(entry));
    return Object.freeze(value) as DeepReadonly<Value>;
  }
  return value as DeepReadonly<Value>;
}

function mutableClone<Value>(value: DeepReadonly<Value>): Value {
  return structuredClone(value) as Value;
}

function digestPayload(snapshot: ImmutableIssueSnapshot): unknown {
  return {
    apiVersion: snapshot.apiVersion,
    kind: snapshot.kind,
    source: snapshot.source,
    content: snapshot.content,
    native: snapshot.native,
    integrity: {
      truncated: snapshot.integrity.truncated,
      omittedBytes: snapshot.integrity.omittedBytes,
    },
  };
}

export function calculateSnapshotDigest(
  snapshot: ImmutableIssueSnapshot,
): Sha256Digest {
  return sha256(canonicalJson(digestPayload(snapshot)));
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

const NATIVE_COLLECTION_LIMIT = 100;
const NATIVE_CHECKS = new Set([
  "GITHUB_REST",
  "GITHUB_GRAPHQL",
  "LOCAL_SOURCE",
]);
const UNAVAILABLE_REASONS = new Set([
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "PLAN_UNAVAILABLE",
  "API_UNSUPPORTED",
  "SOURCE_NOT_APPLICABLE",
]);
const UNKNOWN_REASONS = new Set(["PARTIAL_RESPONSE", "TRANSIENT_ERROR"]);
const NATIVE_REFERENCE_TARGET =
  /^(?:#[0-9]+|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/[0-9]+)$/u;

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function nativeAvailabilityValid(value: Record<string, unknown>): boolean {
  if (!NATIVE_CHECKS.has(value["checkedBy"] as string)) return false;
  switch (value["availability"]) {
    case "AVAILABLE":
      return value["reason"] === null;
    case "UNAVAILABLE":
      return UNAVAILABLE_REASONS.has(value["reason"] as string);
    case "UNKNOWN":
      return UNKNOWN_REASONS.has(value["reason"] as string);
    default:
      return false;
  }
}

function nativeCapabilityValid(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, ["availability", "checkedBy", "reason"]) &&
    nativeAvailabilityValid(value)
  );
}

function boundedObjectArray(
  value: unknown,
): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.length <= NATIVE_COLLECTION_LIMIT &&
    value.every(isRecord)
  );
}

export function verifyNativeSnapshotEnvelope(
  value: unknown,
): value is IssueSnapshotV1Alpha1["native"] {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "issueType",
      "fields",
      "parent",
      "subIssues",
      "blockedBy",
      "blocking",
      "capabilities",
      "references",
    ]) ||
    (value["issueType"] !== null && !isRecord(value["issueType"])) ||
    (value["parent"] !== null && !isRecord(value["parent"])) ||
    !boundedObjectArray(value["fields"]) ||
    !boundedObjectArray(value["subIssues"]) ||
    !boundedObjectArray(value["blockedBy"]) ||
    !boundedObjectArray(value["blocking"])
  ) {
    return false;
  }
  const capabilities = value["capabilities"];
  if (
    !isRecord(capabilities) ||
    !exactKeys(capabilities, [
      "issueTypes",
      "fields",
      "parent",
      "subIssues",
      "dependencies",
      "references",
    ]) ||
    !Object.values(capabilities).every(nativeCapabilityValid)
  ) {
    return false;
  }
  const references = value["references"];
  if (
    !Array.isArray(references) ||
    references.length > NATIVE_COLLECTION_LIMIT
  ) {
    return false;
  }
  const targets = new Set<string>();
  for (const reference of references) {
    if (
      !isRecord(reference) ||
      !exactKeys(reference, [
        "target",
        "kind",
        "essential",
        "availability",
        "checkedBy",
        "reason",
      ]) ||
      typeof reference["target"] !== "string" ||
      !NATIVE_REFERENCE_TARGET.test(reference["target"]) ||
      !["ISSUE", "PULL_REQUEST"].includes(reference["kind"] as string) ||
      typeof reference["essential"] !== "boolean" ||
      !nativeAvailabilityValid(reference) ||
      targets.has(reference["target"])
    ) {
      return false;
    }
    targets.add(reference["target"]);
  }
  return true;
}

export function buildSnapshot(
  input: BuildSnapshotInput,
): ImmutableIssueSnapshot {
  if (!Number.isInteger(input.omittedBytes) || input.omittedBytes < 0) {
    throw new RangeError("omittedBytes must be a non-negative integer");
  }
  if (!verifyNativeSnapshotEnvelope(input.native)) {
    throw new TypeError("native snapshot envelope is invalid or unbounded");
  }
  const normalization = normalizeMarkdown(input.body, "issue.body");
  const draft: IssueSnapshotV1Alpha1 = {
    apiVersion: "https://example.invalid/issueready/snapshot/v1alpha1",
    kind: "IssueSnapshot",
    source: structuredClone(input.source),
    content: {
      title: input.title,
      body: input.body,
      labels: stableUnique(input.labels),
      comments: structuredClone(input.comments) as Record<string, unknown>[],
      normalization:
        mutableClone<IssueSnapshotV1Alpha1["content"]["normalization"]>(
          normalization,
        ),
    },
    ...(input.accessContext === undefined
      ? {}
      : {
          accessContext: {
            ...(input.accessContext.authorAssociation === undefined
              ? {}
              : {
                  authorAssociation:
                    input.accessContext.authorAssociation ?? null,
                }),
            ...(input.accessContext.includedCommentIds === undefined
              ? {}
              : {
                  includedCommentIds: stableUnique(
                    input.accessContext.includedCommentIds,
                  ),
                }),
          },
        }),
    native: structuredClone(input.native),
    integrity: {
      snapshotDigest: `sha256:${"0".repeat(64)}`,
      evaluatedAt: input.evaluatedAt,
      truncated: input.truncated,
      omittedBytes: input.omittedBytes,
    },
  };
  draft.integrity.snapshotDigest = calculateSnapshotDigest(
    draft as ImmutableIssueSnapshot,
  );
  return deepFreeze(draft);
}

export function verifySnapshot(snapshot: ImmutableIssueSnapshot): boolean {
  if (!verifyNativeSnapshotEnvelope(snapshot.native)) return false;
  if (snapshot.content.body !== snapshot.content.normalization.source)
    return false;
  if (
    sha256(snapshot.content.body) !==
    snapshot.content.normalization.sourceDigest
  ) {
    return false;
  }
  return (
    calculateSnapshotDigest(snapshot) === snapshot.integrity.snapshotDigest
  );
}

function nativeIssueTypeName(snapshot: ImmutableIssueSnapshot): string | null {
  const issueType = snapshot.native.issueType;
  if (!isRecord(issueType)) return null;
  const name = issueType["name"];
  return typeof name === "string" ? name : null;
}

export function prepareEvaluation(
  input: PrepareEvaluationInput,
): EvaluationProjection {
  if (!verifySnapshot(input.snapshot)) {
    throw new TypeError("Cannot prepare evaluation from an invalid snapshot");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.policyDigest)) {
    throw new TypeError("policyDigest must be a lowercase SHA-256 digest");
  }
  const taskType = selectTaskType({
    policy: input.policy,
    nativeIssueType: nativeIssueTypeName(input.snapshot),
    explicitTaskType: input.explicitTaskType,
    issueFormTemplatePath: input.issueFormTemplatePath,
    labels: input.snapshot.content.labels,
    deterministicHint: input.deterministicHint,
    semanticHint: input.semanticHint,
    ...(input.snapshot.accessContext === undefined
      ? {}
      : {
          accessContext: {
            authorAssociation:
              input.snapshot.accessContext.authorAssociation ?? null,
          },
        }),
  });
  return Object.freeze({
    snapshotDigest: input.snapshot.integrity.snapshotDigest as Sha256Digest,
    policyDigest: input.policyDigest,
    taskType,
  });
}
