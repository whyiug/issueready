import { githubIssueCacheIdentity } from "./identity.js";

const RFC3339_DATE_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/u;

export interface GithubSourceRevision {
  readonly repositoryNodeId: string;
  readonly issueNodeId: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly updatedAt: string;
  readonly apiVersion: string;
  readonly etag: string | null;
}

export interface GithubSourceCapture<Value> {
  readonly revision: GithubSourceRevision;
  readonly data: Value;
}

export type GithubSourceConsistencyResult<Output> =
  | Readonly<{
      status: "COMPLETE";
      reason: null;
      value: Output;
      revision: GithubSourceRevision;
      refreshed: boolean;
      evaluationAttempts: number;
      sourceObservations: number;
    }>
  | Readonly<{
      status: "DEGRADED";
      reason: "IR-SRC-002 SOURCE_CHANGED_DURING_EVALUATION";
      value: null;
      revision: GithubSourceRevision;
      refreshed: true;
      evaluationAttempts: 2;
      sourceObservations: 3;
    }>;

export interface GithubSourceConsistencyOptions<Value, Output> {
  readonly capture: () => Promise<GithubSourceCapture<Value>>;
  readonly evaluate: (data: Value) => Promise<Output>;
}

function validateRevision(revision: GithubSourceRevision): void {
  githubIssueCacheIdentity(revision);
  const updatedAt = Date.parse(revision.updatedAt);
  if (
    !RFC3339_DATE_TIME.test(revision.updatedAt) ||
    !Number.isFinite(updatedAt)
  ) {
    throw new TypeError("updatedAt must be a valid date-time");
  }
  if (
    revision.etag !== null &&
    (typeof revision.etag !== "string" ||
      revision.etag.length < 1 ||
      revision.etag.length > 8192 ||
      /[\r\n]/u.test(revision.etag))
  ) {
    throw new TypeError("etag must be null or a bounded single-line string");
  }
}

function revisionKey(revision: GithubSourceRevision): string {
  validateRevision(revision);
  const identity = githubIssueCacheIdentity(revision);
  return JSON.stringify([
    identity.issueKey,
    identity.repositoryKey,
    identity.locatorKey,
    identity.etagKey,
    new Date(revision.updatedAt).toISOString(),
    revision.etag,
  ]);
}

function sameRevision(
  left: GithubSourceRevision,
  right: GithubSourceRevision,
): boolean {
  return revisionKey(left) === revisionKey(right);
}

function cloneCapture<Value>(
  capture: GithubSourceCapture<Value>,
): GithubSourceCapture<Value> {
  validateRevision(capture.revision);
  return structuredClone(capture);
}

export async function evaluateGithubSourceConsistently<Value, Output>(
  options: GithubSourceConsistencyOptions<Value, Output>,
): Promise<GithubSourceConsistencyResult<Output>> {
  const first = cloneCapture(await options.capture());
  const firstValue = await options.evaluate(structuredClone(first.data));
  const second = cloneCapture(await options.capture());
  if (sameRevision(first.revision, second.revision)) {
    return {
      status: "COMPLETE",
      reason: null,
      value: firstValue,
      revision: structuredClone(first.revision),
      refreshed: false,
      evaluationAttempts: 1,
      sourceObservations: 2,
    };
  }

  const secondValue = await options.evaluate(structuredClone(second.data));
  const third = cloneCapture(await options.capture());
  if (sameRevision(second.revision, third.revision)) {
    return {
      status: "COMPLETE",
      reason: null,
      value: secondValue,
      revision: structuredClone(second.revision),
      refreshed: true,
      evaluationAttempts: 2,
      sourceObservations: 3,
    };
  }
  return {
    status: "DEGRADED",
    reason: "IR-SRC-002 SOURCE_CHANGED_DURING_EVALUATION",
    value: null,
    revision: structuredClone(third.revision),
    refreshed: true,
    evaluationAttempts: 2,
    sourceObservations: 3,
  };
}
