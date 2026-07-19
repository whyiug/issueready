export type EvaluationStatus = "COMPLETE" | "DEGRADED" | "ERROR";
export type SpecVerdict = "READY" | "NEEDS_INFO" | "TOO_BROAD";
export type DelegationDisposition =
  "CANDIDATE" | "SUPERVISED" | "HUMAN_ONLY" | "UNKNOWN";
export type RuleOutcome = "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";
export type FindingSource = "DETERMINISTIC" | "SEMANTIC" | "HYBRID" | "POLICY";
export type TaskType =
  | "generic"
  | "bug"
  | "feature"
  | "docs"
  | "dependency"
  | "refactor"
  | "test-ci"
  | "operations";
export type Sha256Digest = `sha256:${string}`;

export const EVALUATION_STATUSES: readonly EvaluationStatus[] = [
  "COMPLETE",
  "DEGRADED",
  "ERROR",
];
export const SPEC_VERDICTS: readonly SpecVerdict[] = [
  "READY",
  "NEEDS_INFO",
  "TOO_BROAD",
];
export const DELEGATION_DISPOSITIONS: readonly DelegationDisposition[] = [
  "CANDIDATE",
  "SUPERVISED",
  "HUMAN_ONLY",
  "UNKNOWN",
];
export const TASK_TYPES: readonly TaskType[] = [
  "generic",
  "bug",
  "feature",
  "docs",
  "dependency",
  "refactor",
  "test-ci",
  "operations",
];

export type TriAxisState =
  | Readonly<{
      evaluationStatus: "ERROR";
      specVerdict: null;
      delegationDisposition: "UNKNOWN";
    }>
  | Readonly<{
      evaluationStatus: "COMPLETE";
      specVerdict: SpecVerdict;
      delegationDisposition: DelegationDisposition;
    }>
  | Readonly<{
      evaluationStatus: "DEGRADED";
      specVerdict: SpecVerdict | null;
      delegationDisposition: DelegationDisposition;
    }>;

export interface EvidenceSpan {
  readonly document: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly quote?: string;
  readonly snapshotDigest: Sha256Digest;
}

export interface Finding {
  readonly ruleId: string;
  readonly outcome: RuleOutcome;
  readonly source: FindingSource;
  readonly messageKey: string;
  readonly evidence: readonly EvidenceSpan[];
  readonly remediation?: Readonly<{
    questionId: string;
    expectedAnswerType: string;
  }>;
}

export interface IssueReadyReport extends TriAxisFields {
  readonly schemaVersion: string;
  readonly evaluationId: string;
  readonly agentCapabilityProfile: string;
  readonly supervisionProfile: string;
  readonly canonicalFindings: readonly Finding[];
  readonly policyFindings: readonly Finding[];
  readonly generatedAt: string;
}

export interface TriAxisFields {
  readonly evaluationStatus: EvaluationStatus;
  readonly specVerdict: SpecVerdict | null;
  readonly delegationDisposition: DelegationDisposition;
}

export function isTriAxisState(value: TriAxisFields): value is TriAxisState {
  if (value.evaluationStatus === "ERROR") {
    return (
      value.specVerdict === null && value.delegationDisposition === "UNKNOWN"
    );
  }
  if (value.evaluationStatus === "COMPLETE") {
    return value.specVerdict !== null;
  }
  return value.evaluationStatus === "DEGRADED";
}

export function assertTriAxisState(
  value: TriAxisFields,
): asserts value is TriAxisState {
  if (!isTriAxisState(value)) {
    throw new TypeError(
      `Invalid tri-axis state: ${value.evaluationStatus}/${String(value.specVerdict)}/${value.delegationDisposition}`,
    );
  }
}
