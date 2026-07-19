import type {
  DelegationDisposition,
  EvaluationStatus,
  RuleOutcome,
  SpecVerdict,
  TriAxisState,
} from "@issueready/domain";

export type CanonicalSpecEffect = "NONE" | "NEEDS_INFO" | "TOO_BROAD";
export type PolicyDispositionEffect =
  "NONE" | "CANDIDATE" | "SUPERVISED" | "HUMAN_ONLY" | "UNKNOWN";

export interface CanonicalRuleResult {
  readonly ruleId: string;
  readonly outcome: RuleOutcome;
  readonly applicable: boolean;
  readonly mandatory: boolean;
  readonly onFail: CanonicalSpecEffect;
  readonly unknownCouldChangeVerdict: boolean;
  readonly hardPredicateProven: boolean;
}

export interface PolicyRuleResult {
  readonly ruleId: string;
  readonly outcome: RuleOutcome;
  readonly effect: PolicyDispositionEffect;
  readonly independentHardBoundary: boolean;
}

export interface EvaluationRuleResult {
  readonly ruleId: string;
  readonly outcome: RuleOutcome;
  readonly onFail: "NONE" | "DEGRADED" | "ERROR";
  readonly onUnknown: "NONE" | "DEGRADED" | "ERROR";
  readonly unknownNullsSpec: boolean;
}

export interface DecisionInput {
  readonly snapshotValid: boolean;
  readonly internalFatal: boolean;
  readonly canonicalRules: readonly CanonicalRuleResult[];
  readonly policyRules: readonly PolicyRuleResult[];
  readonly evaluationRules?: readonly EvaluationRuleResult[];
}

export type DecisionResult = TriAxisState &
  Readonly<{
    reasons: readonly string[];
  }>;

export type GateName =
  | "evaluation-complete"
  | "spec-ready"
  | "spec-ready-allow-inert-degraded"
  | "delegation-candidate"
  | "agent-delegable"
  | "agent-delegable-supervised";

export type GateExitCode = 0 | 3 | 4;

export interface GateResult {
  readonly gate: GateName;
  readonly accepted: boolean;
  readonly exitCode: GateExitCode;
  readonly reason: "PASS" | "EVALUATION_ERROR" | "GATE_MISMATCH";
}

export interface BatchGateResult {
  readonly gate: GateName;
  readonly accepted: boolean;
  readonly exitCode: GateExitCode;
  readonly results: readonly GateResult[];
}

function decideDisposition(
  policyRules: readonly PolicyRuleResult[],
  specAvailable: boolean,
): DelegationDisposition {
  let selected: Exclude<PolicyDispositionEffect, "NONE" | "UNKNOWN"> | null =
    null;
  let outcomeUnknown = false;

  for (const result of policyRules) {
    if (result.outcome === "UNKNOWN" && result.effect !== "NONE") {
      outcomeUnknown = true;
      continue;
    }
    if (result.outcome !== "FAIL") continue;
    if (!specAvailable && !result.independentHardBoundary) continue;
    if (result.effect === "HUMAN_ONLY") {
      selected = "HUMAN_ONLY";
    } else if (result.effect === "SUPERVISED" && selected !== "HUMAN_ONLY") {
      selected = "SUPERVISED";
    } else if (result.effect === "CANDIDATE" && selected === null) {
      selected = result.effect;
    }
  }

  if (selected === "HUMAN_ONLY") return selected;
  if (outcomeUnknown) return "UNKNOWN";
  if (selected !== null) return selected;
  return specAvailable ? "CANDIDATE" : "UNKNOWN";
}

function gateMatches(gate: GateName, state: TriAxisState): boolean {
  switch (gate) {
    case "evaluation-complete":
      return state.evaluationStatus === "COMPLETE";
    case "spec-ready":
      return (
        state.evaluationStatus === "COMPLETE" && state.specVerdict === "READY"
      );
    case "spec-ready-allow-inert-degraded":
      return state.specVerdict === "READY";
    case "delegation-candidate":
      return (
        state.evaluationStatus === "COMPLETE" &&
        state.specVerdict !== null &&
        state.delegationDisposition === "CANDIDATE"
      );
    case "agent-delegable":
      return (
        state.evaluationStatus === "COMPLETE" &&
        state.specVerdict === "READY" &&
        state.delegationDisposition === "CANDIDATE"
      );
    case "agent-delegable-supervised":
      return (
        state.evaluationStatus === "COMPLETE" &&
        state.specVerdict === "READY" &&
        (state.delegationDisposition === "CANDIDATE" ||
          state.delegationDisposition === "SUPERVISED")
      );
  }
}

export function evaluateGate(gate: GateName, state: TriAxisState): GateResult {
  if (state.evaluationStatus === "ERROR") {
    return Object.freeze({
      gate,
      accepted: false,
      exitCode: 3,
      reason: "EVALUATION_ERROR",
    });
  }
  const accepted = gateMatches(gate, state);
  return Object.freeze({
    gate,
    accepted,
    exitCode: accepted ? 0 : 4,
    reason: accepted ? "PASS" : "GATE_MISMATCH",
  });
}

export function evaluateBatchGate(
  gate: GateName,
  states: readonly TriAxisState[],
): BatchGateResult {
  const results = states.map((state) => evaluateGate(gate, state));
  const exitCode: GateExitCode = results.some((result) => result.exitCode === 3)
    ? 3
    : results.some((result) => result.exitCode === 4)
      ? 4
      : 0;
  return Object.freeze({
    gate,
    accepted: exitCode === 0,
    exitCode,
    results: Object.freeze(results),
  });
}

export function decide(input: DecisionInput): DecisionResult {
  if (!input.snapshotValid || input.internalFatal) {
    return {
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: [input.snapshotValid ? "INTERNAL_FATAL" : "INVALID_SNAPSHOT"],
    };
  }

  const evaluationRules = input.evaluationRules ?? [];
  const fatalEvaluationRules = evaluationRules.filter(
    (result) =>
      (result.outcome === "FAIL" && result.onFail === "ERROR") ||
      (result.outcome === "UNKNOWN" && result.onUnknown === "ERROR"),
  );
  if (fatalEvaluationRules.length > 0) {
    return {
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: fatalEvaluationRules.map(
        (result) => `${result.ruleId}:${result.outcome}`,
      ),
    };
  }
  const degradedEvaluationRules = evaluationRules.filter(
    (result) =>
      (result.outcome === "FAIL" && result.onFail === "DEGRADED") ||
      (result.outcome === "UNKNOWN" && result.onUnknown === "DEGRADED"),
  );

  const applicable = input.canonicalRules.filter((result) => result.applicable);
  const unknown = applicable.filter((result) => result.outcome === "UNKNOWN");
  const conclusionChangingUnknown = unknown.some(
    (result) => result.unknownCouldChangeVerdict,
  );
  const failures = applicable.filter((result) => result.outcome === "FAIL");
  const unprovenHardFailures = failures.filter(
    (result) => result.onFail === "TOO_BROAD" && !result.hardPredicateProven,
  );
  const invalidMandatoryFailures = failures.filter(
    (result) => result.mandatory && result.onFail === "NONE",
  );

  if (invalidMandatoryFailures.length > 0) {
    return {
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: invalidMandatoryFailures.map(
        (result) => `${result.ruleId}:INVALID_MANDATORY_EFFECT`,
      ),
    };
  }

  let specVerdict: SpecVerdict | null;
  if (conclusionChangingUnknown || unprovenHardFailures.length > 0) {
    specVerdict = null;
  } else if (
    failures.some(
      (result) => result.onFail === "TOO_BROAD" && result.hardPredicateProven,
    )
  ) {
    specVerdict = "TOO_BROAD";
  } else if (failures.some((result) => result.onFail === "NEEDS_INFO")) {
    specVerdict = "NEEDS_INFO";
  } else {
    const unknownMandatory = applicable.some(
      (result) => result.mandatory && result.outcome === "UNKNOWN",
    );
    specVerdict = unknownMandatory ? null : "READY";
  }

  if (
    evaluationRules.some(
      (result) => result.outcome === "UNKNOWN" && result.unknownNullsSpec,
    )
  ) {
    specVerdict = null;
  }

  const evaluationStatus: EvaluationStatus =
    degradedEvaluationRules.length > 0 ||
    unknown.length > 0 ||
    unprovenHardFailures.length > 0
      ? "DEGRADED"
      : "COMPLETE";
  const reasons = [
    ...degradedEvaluationRules.map(
      (result) => `${result.ruleId}:${result.outcome}`,
    ),
    ...unknown.map((result) => `${result.ruleId}:UNKNOWN`),
    ...failures.map((result) => `${result.ruleId}:FAIL`),
    ...unprovenHardFailures.map(
      (result) => `${result.ruleId}:UNPROVEN_HARD_EFFECT`,
    ),
  ];

  return {
    evaluationStatus,
    specVerdict,
    delegationDisposition: decideDisposition(
      input.policyRules,
      specVerdict !== null,
    ),
    reasons,
  } as DecisionResult;
}
