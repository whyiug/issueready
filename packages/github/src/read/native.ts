import type { IssueSnapshotV1Alpha1 } from "@issueready/schema";

import type { GithubReadResult } from "./index.js";

type SnapshotNative = IssueSnapshotV1Alpha1["native"];
export type GithubNativeCapability = SnapshotNative["capabilities"]["fields"];
export type GithubNativeReference = SnapshotNative["references"][number];
export type GithubNativeCheck = Exclude<
  GithubNativeCapability["checkedBy"],
  "LOCAL_SOURCE"
>;

export interface GithubNativeFeatureRead {
  readonly result: GithubReadResult<unknown>;
  readonly checkedBy: GithubNativeCheck;
  readonly cachedData?: unknown;
}

export interface GithubNativeReferenceRead {
  readonly target: string;
  readonly kind: GithubNativeReference["kind"];
  readonly essential: boolean;
  readonly result: GithubReadResult<unknown>;
  readonly checkedBy: GithubNativeCheck;
  readonly cacheAvailable?: boolean;
}

export interface GithubNativeReadSet {
  readonly issueType: GithubNativeFeatureRead;
  readonly fields: GithubNativeFeatureRead;
  readonly parent: GithubNativeFeatureRead;
  readonly subIssues: GithubNativeFeatureRead;
  readonly dependencies: GithubNativeFeatureRead;
  readonly references: {
    readonly capability: GithubNativeFeatureRead;
    readonly items: readonly GithubNativeReferenceRead[];
  };
}

function available(checkedBy: GithubNativeCheck): GithubNativeCapability {
  return { availability: "AVAILABLE", checkedBy, reason: null };
}

function unavailable(
  checkedBy: GithubNativeCheck,
  reason: Extract<
    GithubNativeCapability,
    { availability: "UNAVAILABLE" }
  >["reason"],
): GithubNativeCapability {
  return { availability: "UNAVAILABLE", checkedBy, reason };
}

function unknown(
  checkedBy: GithubNativeCheck,
  reason: Extract<
    GithubNativeCapability,
    { availability: "UNKNOWN" }
  >["reason"],
): GithubNativeCapability {
  return { availability: "UNKNOWN", checkedBy, reason };
}

export function mapGithubReadCapability(
  result: GithubReadResult<unknown>,
  checkedBy: GithubNativeCheck,
  cacheAvailable = false,
): GithubNativeCapability {
  switch (result.outcome) {
    case "OK":
      return available(checkedBy);
    case "NOT_MODIFIED":
      return cacheAvailable
        ? available(checkedBy)
        : unknown(checkedBy, "PARTIAL_RESPONSE");
    case "UNAVAILABLE":
      switch (result.reason) {
        case "PERMISSION_DENIED":
          return unavailable(checkedBy, "PERMISSION_DENIED");
        case "NOT_FOUND":
          return unavailable(checkedBy, "NOT_FOUND");
        case "API_UNSUPPORTED":
          return unavailable(checkedBy, "API_UNSUPPORTED");
        case "CONFLICT":
          return unknown(checkedBy, "TRANSIENT_ERROR");
        case "INVALID_REQUEST":
          return unknown(checkedBy, "PARTIAL_RESPONSE");
      }
    case "UNKNOWN":
      return unknown(
        checkedBy,
        result.reason === "RATE_LIMITED" || result.reason === "SERVER_ERROR"
          ? "TRANSIENT_ERROR"
          : "PARTIAL_RESPONSE",
      );
  }
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function resolvedData(
  read: GithubNativeFeatureRead,
): Readonly<{ present: true; value: unknown }> | Readonly<{ present: false }> {
  switch (read.result.outcome) {
    case "OK":
      return { present: true, value: read.result.data };
    case "NOT_MODIFIED":
      return hasOwn(read, "cachedData")
        ? { present: true, value: read.cachedData }
        : { present: false };
    case "UNKNOWN":
      return read.result.data === null
        ? { present: false }
        : { present: true, value: read.result.data };
    case "UNAVAILABLE":
      return { present: false };
  }
}

function capabilityForRead(
  read: GithubNativeFeatureRead,
): GithubNativeCapability {
  return mapGithubReadCapability(
    read.result,
    read.checkedBy,
    hasOwn(read, "cachedData"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

interface DecodedFeature<Value> {
  readonly value: Value;
  readonly capability: GithubNativeCapability;
}

function invalidFeature<Value>(
  read: GithubNativeFeatureRead,
  fallback: Value,
): DecodedFeature<Value> {
  return {
    value: fallback,
    capability: unknown(read.checkedBy, "PARTIAL_RESPONSE"),
  };
}

function decodeNullableRecord(
  read: GithubNativeFeatureRead,
): DecodedFeature<Record<string, unknown> | null> {
  const data = resolvedData(read);
  if (!data.present)
    return { value: null, capability: capabilityForRead(read) };
  if (data.value !== null && !isRecord(data.value)) {
    return invalidFeature(read, null);
  }
  return {
    value: structuredClone(data.value),
    capability: capabilityForRead(read),
  };
}

function decodeRecordArray(
  read: GithubNativeFeatureRead,
): DecodedFeature<Record<string, unknown>[]> {
  const data = resolvedData(read);
  if (!data.present) return { value: [], capability: capabilityForRead(read) };
  if (
    !Array.isArray(data.value) ||
    data.value.length > 100 ||
    !data.value.every(isRecord)
  ) {
    return invalidFeature(read, []);
  }
  return {
    value: structuredClone(data.value),
    capability: capabilityForRead(read),
  };
}

interface DecodedDependencies {
  readonly blockedBy: Record<string, unknown>[];
  readonly blocking: Record<string, unknown>[];
  readonly capability: GithubNativeCapability;
}

function decodeDependencies(
  read: GithubNativeFeatureRead,
): DecodedDependencies {
  const data = resolvedData(read);
  if (!data.present) {
    return {
      blockedBy: [],
      blocking: [],
      capability: capabilityForRead(read),
    };
  }
  if (
    !isRecord(data.value) ||
    !exactKeys(data.value, ["blockedBy", "blocking"]) ||
    !Array.isArray(data.value["blockedBy"]) ||
    data.value["blockedBy"].length > 100 ||
    !data.value["blockedBy"].every(isRecord) ||
    !Array.isArray(data.value["blocking"]) ||
    data.value["blocking"].length > 100 ||
    !data.value["blocking"].every(isRecord)
  ) {
    return {
      blockedBy: [],
      blocking: [],
      capability: unknown(read.checkedBy, "PARTIAL_RESPONSE"),
    };
  }
  return {
    blockedBy: structuredClone(data.value["blockedBy"]),
    blocking: structuredClone(data.value["blocking"]),
    capability: capabilityForRead(read),
  };
}

const REFERENCE_TARGET =
  /^(?:#[0-9]+|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/[0-9]+)$/u;

export function mapGithubReferenceRead(
  read: GithubNativeReferenceRead,
): GithubNativeReference {
  if (!REFERENCE_TARGET.test(read.target)) {
    throw new TypeError(`Invalid GitHub reference target: ${read.target}`);
  }
  const state = mapGithubReadCapability(
    read.result,
    read.checkedBy,
    read.cacheAvailable ?? false,
  );
  const reference = {
    target: read.target,
    kind: read.kind,
    essential: read.essential,
  };
  switch (state.availability) {
    case "AVAILABLE":
      return { ...reference, ...state };
    case "UNAVAILABLE":
      return { ...reference, ...state };
    case "UNKNOWN":
      return { ...reference, ...state };
  }
}

function decodeReferences(
  reads: readonly GithubNativeReferenceRead[],
): GithubNativeReference[] {
  if (reads.length > 100) {
    throw new RangeError("GitHub native references exceed the 100-item bound");
  }
  const targets = new Set<string>();
  return reads.map((read) => {
    if (targets.has(read.target)) {
      throw new TypeError(`Duplicate GitHub reference target: ${read.target}`);
    }
    targets.add(read.target);
    return mapGithubReferenceRead(read);
  });
}

export function projectGithubNative(
  reads: GithubNativeReadSet,
): SnapshotNative {
  const issueType = decodeNullableRecord(reads.issueType);
  const fields = decodeRecordArray(reads.fields);
  const parent = decodeNullableRecord(reads.parent);
  const subIssues = decodeRecordArray(reads.subIssues);
  const dependencies = decodeDependencies(reads.dependencies);
  return {
    issueType: issueType.value,
    fields: fields.value,
    parent: parent.value,
    subIssues: subIssues.value,
    blockedBy: dependencies.blockedBy,
    blocking: dependencies.blocking,
    capabilities: {
      issueTypes: issueType.capability,
      fields: fields.capability,
      parent: parent.capability,
      subIssues: subIssues.capability,
      dependencies: dependencies.capability,
      references: capabilityForRead(reads.references.capability),
    },
    references: decodeReferences(reads.references.items),
  };
}
