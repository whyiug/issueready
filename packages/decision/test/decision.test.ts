import { describe, expect, it } from "vitest";

import {
  decide,
  evaluateBatchGate,
  evaluateGate,
  type CanonicalRuleResult,
  type DecisionInput,
  type EvaluationRuleResult,
  type GateName,
  type PolicyRuleResult,
} from "../src/index.js";
import type {
  DelegationDisposition,
  EvaluationStatus,
  SpecVerdict,
  TriAxisState,
} from "@issueready/domain";

const pass: CanonicalRuleResult = {
  ruleId: "IR-ACC-001",
  outcome: "PASS",
  applicable: true,
  mandatory: true,
  onFail: "NEEDS_INFO",
  unknownCouldChangeVerdict: true,
  hardPredicateProven: false,
};

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    snapshotValid: true,
    internalFatal: false,
    canonicalRules: [pass],
    policyRules: [],
    ...overrides,
  };
}

function failingCanonical(
  ruleId: string,
  onFail: CanonicalRuleResult["onFail"],
  hardPredicateProven = false,
): CanonicalRuleResult {
  return { ...pass, ruleId, outcome: "FAIL", onFail, hardPredicateProven };
}

function policy(
  effect: PolicyRuleResult["effect"],
  independentHardBoundary = false,
  outcome: PolicyRuleResult["outcome"] = "FAIL",
  ruleId = "IR-POL-001",
): PolicyRuleResult {
  return {
    ruleId,
    outcome,
    effect,
    independentHardBoundary,
  };
}

function evaluation(
  outcome: EvaluationRuleResult["outcome"],
): EvaluationRuleResult {
  return {
    ruleId: "IR-INP-001",
    outcome,
    onFail: "ERROR",
    onUnknown: "DEGRADED",
    unknownNullsSpec: true,
  };
}

describe("decision precedence", () => {
  it("maps invalid snapshots to ERROR/null/UNKNOWN rather than NEEDS_INFO", () => {
    expect(decide(input({ snapshotValid: false }))).toEqual({
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: ["INVALID_SNAPSHOT"],
    });
    expect(decide(input({ internalFatal: true }))).toEqual({
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: ["INTERNAL_FATAL"],
    });
  });

  it("fails closed on an evaluation-only integrity failure", () => {
    expect(
      decide(input({ evaluationRules: [evaluation("FAIL")] })),
    ).toMatchObject({
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: ["IR-INP-001:FAIL"],
    });
  });

  it("keeps unavailable input coverage separate from content findings", () => {
    expect(
      decide(input({ evaluationRules: [evaluation("UNKNOWN")] })),
    ).toMatchObject({
      evaluationStatus: "DEGRADED",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: ["IR-INP-001:UNKNOWN"],
    });
  });

  it("returns COMPLETE READY when every applicable mandatory rule passes", () => {
    expect(decide(input())).toMatchObject({
      evaluationStatus: "COMPLETE",
      specVerdict: "READY",
      delegationDisposition: "CANDIDATE",
    });
  });

  it("returns NEEDS_INFO for a proven canonical content failure", () => {
    expect(
      decide(
        input({
          canonicalRules: [failingCanonical("IR-ACC-001", "NEEDS_INFO", true)],
        }),
      ),
    ).toMatchObject({
      evaluationStatus: "COMPLETE",
      specVerdict: "NEEDS_INFO",
    });
  });

  it("gives a proven stable independent-goal failure TOO_BROAD precedence", () => {
    const canonicalRules = [
      failingCanonical("IR-ACC-001", "NEEDS_INFO", true),
      failingCanonical("IR-SCP-002", "TOO_BROAD", true),
    ];
    expect(decide(input({ canonicalRules }))).toMatchObject({
      evaluationStatus: "COMPLETE",
      specVerdict: "TOO_BROAD",
    });
  });

  it("does not produce TOO_BROAD from an unproven structural signal", () => {
    expect(
      decide(
        input({
          canonicalRules: [failingCanonical("IR-SCP-002", "TOO_BROAD")],
        }),
      ),
    ).toEqual({
      evaluationStatus: "DEGRADED",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: ["IR-SCP-002:FAIL", "IR-SCP-002:UNPROVEN_HARD_EFFECT"],
    });
  });

  it("nulls the verdict when an UNKNOWN result could change it", () => {
    const semanticUnknown: CanonicalRuleResult = {
      ...pass,
      ruleId: "IR-SEM-000",
      outcome: "UNKNOWN",
      unknownCouldChangeVerdict: true,
    };
    expect(decide(input({ canonicalRules: [semanticUnknown] }))).toMatchObject({
      evaluationStatus: "DEGRADED",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
    });
  });

  it("retains a proven verdict when every UNKNOWN is conclusion-inert", () => {
    const inertUnknown: CanonicalRuleResult = {
      ...pass,
      ruleId: "IR-CTX-001",
      outcome: "UNKNOWN",
      mandatory: false,
      unknownCouldChangeVerdict: false,
    };
    expect(
      decide(input({ canonicalRules: [pass, inertUnknown] })),
    ).toMatchObject({
      evaluationStatus: "DEGRADED",
      specVerdict: "READY",
      delegationDisposition: "CANDIDATE",
    });
  });

  it("keeps canonical READY independent from a HUMAN_ONLY policy", () => {
    expect(
      decide(input({ policyRules: [policy("HUMAN_ONLY", true)] })),
    ).toMatchObject({
      evaluationStatus: "COMPLETE",
      specVerdict: "READY",
      delegationDisposition: "HUMAN_ONLY",
    });
  });

  it("retains an independent hard HUMAN_ONLY boundary even when spec is unavailable", () => {
    const semanticUnknown: CanonicalRuleResult = {
      ...pass,
      ruleId: "IR-DEF-002",
      outcome: "UNKNOWN",
      unknownCouldChangeVerdict: true,
    };
    expect(
      decide(
        input({
          canonicalRules: [semanticUnknown],
          policyRules: [policy("HUMAN_ONLY", true)],
        }),
      ),
    ).toMatchObject({
      evaluationStatus: "DEGRADED",
      specVerdict: null,
      delegationDisposition: "HUMAN_ONLY",
    });
  });
});

describe("decision input-domain matrices", () => {
  it.each([
    {
      name: "failed evaluation ignored by NONE",
      rule: {
        ...evaluation("FAIL"),
        onFail: "NONE" as const,
        unknownNullsSpec: false,
      },
      expected: {
        evaluationStatus: "COMPLETE",
        specVerdict: "READY",
        delegationDisposition: "CANDIDATE",
        reasons: [],
      },
    },
    {
      name: "failed evaluation degrades",
      rule: {
        ...evaluation("FAIL"),
        onFail: "DEGRADED" as const,
        unknownNullsSpec: false,
      },
      expected: {
        evaluationStatus: "DEGRADED",
        specVerdict: "READY",
        delegationDisposition: "CANDIDATE",
        reasons: ["IR-INP-001:FAIL"],
      },
    },
    {
      name: "unknown evaluation ignored by NONE",
      rule: {
        ...evaluation("UNKNOWN"),
        onUnknown: "NONE" as const,
        unknownNullsSpec: false,
      },
      expected: {
        evaluationStatus: "COMPLETE",
        specVerdict: "READY",
        delegationDisposition: "CANDIDATE",
        reasons: [],
      },
    },
    {
      name: "unknown evaluation degrades without nulling spec",
      rule: { ...evaluation("UNKNOWN"), unknownNullsSpec: false },
      expected: {
        evaluationStatus: "DEGRADED",
        specVerdict: "READY",
        delegationDisposition: "CANDIDATE",
        reasons: ["IR-INP-001:UNKNOWN"],
      },
    },
    {
      name: "unknown evaluation nulls spec without degradation",
      rule: {
        ...evaluation("UNKNOWN"),
        onUnknown: "NONE" as const,
        unknownNullsSpec: true,
      },
      expected: {
        evaluationStatus: "COMPLETE",
        specVerdict: null,
        delegationDisposition: "UNKNOWN",
        reasons: [],
      },
    },
    {
      name: "pass does not trigger configured failure effects",
      rule: {
        ...evaluation("PASS"),
        onFail: "DEGRADED" as const,
        onUnknown: "ERROR" as const,
      },
      expected: {
        evaluationStatus: "COMPLETE",
        specVerdict: "READY",
        delegationDisposition: "CANDIDATE",
        reasons: [],
      },
    },
    {
      name: "not applicable does not trigger configured failure effects",
      rule: { ...evaluation("NOT_APPLICABLE"), onUnknown: "ERROR" as const },
      expected: {
        evaluationStatus: "COMPLETE",
        specVerdict: "READY",
        delegationDisposition: "CANDIDATE",
        reasons: [],
      },
    },
  ])("handles $name", ({ rule, expected }) => {
    expect(decide(input({ evaluationRules: [rule] }))).toEqual(expected);
  });

  it("fails closed for UNKNOWN when its evaluation effect is ERROR", () => {
    const fatalUnknown = {
      ...evaluation("UNKNOWN"),
      onUnknown: "ERROR" as const,
    };
    const inertFailure = {
      ...evaluation("FAIL"),
      ruleId: "IR-INP-002",
      onFail: "NONE" as const,
    };
    expect(
      decide(input({ evaluationRules: [inertFailure, fatalUnknown] })),
    ).toEqual({
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: ["IR-INP-001:UNKNOWN"],
    });
  });

  it("ignores non-applicable canonical failures completely", () => {
    expect(
      decide(
        input({
          canonicalRules: [
            pass,
            {
              ...failingCanonical("IR-SCP-002", "TOO_BROAD", true),
              applicable: false,
            },
          ],
        }),
      ),
    ).toEqual({
      evaluationStatus: "COMPLETE",
      specVerdict: "READY",
      delegationDisposition: "CANDIDATE",
      reasons: [],
    });
  });

  it("rejects a mandatory failure with no registered canonical effect", () => {
    expect(
      decide(
        input({
          canonicalRules: [failingCanonical("IR-ACC-009", "NONE")],
        }),
      ),
    ).toEqual({
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: ["IR-ACC-009:INVALID_MANDATORY_EFFECT"],
    });
  });

  it("allows an optional no-effect failure while retaining its reason", () => {
    expect(
      decide(
        input({
          canonicalRules: [
            pass,
            {
              ...failingCanonical("IR-OPT-001", "NONE"),
              mandatory: false,
            },
          ],
        }),
      ),
    ).toEqual({
      evaluationStatus: "COMPLETE",
      specVerdict: "READY",
      delegationDisposition: "CANDIDATE",
      reasons: ["IR-OPT-001:FAIL"],
    });
  });

  it("treats an applicable NOT_APPLICABLE outcome as resolved", () => {
    expect(
      decide(
        input({
          canonicalRules: [{ ...pass, outcome: "NOT_APPLICABLE" }],
        }),
      ),
    ).toEqual({
      evaluationStatus: "COMPLETE",
      specVerdict: "READY",
      delegationDisposition: "CANDIDATE",
      reasons: [],
    });
  });

  it("nulls a mandatory UNKNOWN even when it is conclusion-inert", () => {
    expect(
      decide(
        input({
          canonicalRules: [
            {
              ...pass,
              outcome: "UNKNOWN",
              unknownCouldChangeVerdict: false,
            },
          ],
        }),
      ),
    ).toEqual({
      evaluationStatus: "DEGRADED",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: ["IR-ACC-001:UNKNOWN"],
    });
  });

  it("uses any mandatory UNKNOWN rather than requiring every rule to be UNKNOWN", () => {
    expect(
      decide(
        input({
          canonicalRules: [
            pass,
            {
              ...pass,
              ruleId: "IR-ACC-002",
              outcome: "UNKNOWN",
              unknownCouldChangeVerdict: false,
            },
          ],
        }),
      ).specVerdict,
    ).toBeNull();
  });

  it("nulls an optional UNKNOWN when it can change the conclusion", () => {
    expect(
      decide(
        input({
          canonicalRules: [
            pass,
            {
              ...pass,
              ruleId: "IR-SEM-002",
              outcome: "UNKNOWN",
              mandatory: false,
              unknownCouldChangeVerdict: true,
            },
          ],
        }),
      ),
    ).toEqual({
      evaluationStatus: "DEGRADED",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: ["IR-SEM-002:UNKNOWN"],
    });
  });

  it("nulls an optional unproven hard effect independently of mandatory resolution", () => {
    expect(
      decide(
        input({
          canonicalRules: [
            pass,
            {
              ...failingCanonical("IR-SCP-009", "TOO_BROAD"),
              mandatory: false,
            },
          ],
        }),
      ),
    ).toEqual({
      evaluationStatus: "DEGRADED",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: ["IR-SCP-009:FAIL", "IR-SCP-009:UNPROVEN_HARD_EFFECT"],
    });
  });
});

describe("policy disposition orthogonality", () => {
  it.each([
    [policy("NONE"), "CANDIDATE"],
    [policy("UNKNOWN"), "CANDIDATE"],
    [policy("HUMAN_ONLY", false, "PASS"), "CANDIDATE"],
    [policy("HUMAN_ONLY", false, "NOT_APPLICABLE"), "CANDIDATE"],
    [policy("NONE", false, "UNKNOWN"), "CANDIDATE"],
    [policy("CANDIDATE", false, "UNKNOWN"), "UNKNOWN"],
    [policy("SUPERVISED"), "SUPERVISED"],
    [policy("HUMAN_ONLY"), "HUMAN_ONLY"],
  ] as const)("maps an isolated policy result", (rule, expected) => {
    expect(decide(input({ policyRules: [rule] })).delegationDisposition).toBe(
      expected,
    );
  });

  it.each([
    [
      [
        policy("CANDIDATE", false, "FAIL", "low"),
        policy("SUPERVISED", false, "FAIL", "medium"),
      ],
      "SUPERVISED",
    ],
    [
      [
        policy("SUPERVISED", false, "FAIL", "medium"),
        policy("CANDIDATE", false, "FAIL", "low"),
      ],
      "SUPERVISED",
    ],
    [
      [
        policy("HUMAN_ONLY", false, "FAIL", "hard"),
        policy("SUPERVISED", false, "FAIL", "medium"),
      ],
      "HUMAN_ONLY",
    ],
    [
      [
        policy("CANDIDATE", false, "UNKNOWN", "unknown"),
        policy("HUMAN_ONLY", false, "FAIL", "hard"),
      ],
      "HUMAN_ONLY",
    ],
    [
      [
        policy("SUPERVISED", false, "FAIL", "medium"),
        policy("CANDIDATE", false, "UNKNOWN", "unknown"),
      ],
      "UNKNOWN",
    ],
  ] as const)(
    "uses stable priority independent of order",
    (rules, expected) => {
      expect(decide(input({ policyRules: rules })).delegationDisposition).toBe(
        expected,
      );
    },
  );

  it("ignores a non-independent policy failure when the spec is unavailable", () => {
    const unavailable = {
      ...pass,
      outcome: "UNKNOWN" as const,
      unknownCouldChangeVerdict: true,
    };
    expect(
      decide(
        input({
          canonicalRules: [unavailable],
          policyRules: [policy("SUPERVISED", false)],
        }),
      ).delegationDisposition,
    ).toBe("UNKNOWN");
    expect(
      decide(
        input({
          canonicalRules: [unavailable],
          policyRules: [policy("SUPERVISED", true)],
        }),
      ).delegationDisposition,
    ).toBe("SUPERVISED");
  });

  it("retains an independent CANDIDATE effect when the spec is unavailable", () => {
    const unavailable = {
      ...pass,
      outcome: "UNKNOWN" as const,
      unknownCouldChangeVerdict: true,
    };
    expect(
      decide(
        input({
          canonicalRules: [unavailable],
          policyRules: [policy("CANDIDATE", true)],
        }),
      ).delegationDisposition,
    ).toBe("CANDIDATE");
  });
});

describe("exhaustive tri-axis gates", () => {
  const gates: readonly GateName[] = [
    "evaluation-complete",
    "spec-ready",
    "spec-ready-allow-inert-degraded",
    "delegation-candidate",
    "agent-delegable",
    "agent-delegable-supervised",
  ];
  const evaluationStatuses: readonly EvaluationStatus[] = [
    "COMPLETE",
    "DEGRADED",
    "ERROR",
  ];
  const specVerdicts: readonly (SpecVerdict | null)[] = [
    "READY",
    "NEEDS_INFO",
    "TOO_BROAD",
    null,
  ];
  const dispositions: readonly DelegationDisposition[] = [
    "CANDIDATE",
    "SUPERVISED",
    "HUMAN_ONLY",
    "UNKNOWN",
  ];

  function expected(gate: GateName, state: TriAxisState): boolean {
    if (state.evaluationStatus === "ERROR") return false;
    if (gate === "evaluation-complete") {
      return state.evaluationStatus === "COMPLETE";
    }
    if (gate === "spec-ready") {
      return (
        state.evaluationStatus === "COMPLETE" && state.specVerdict === "READY"
      );
    }
    if (gate === "spec-ready-allow-inert-degraded") {
      return state.specVerdict === "READY";
    }
    if (gate === "delegation-candidate") {
      return (
        state.evaluationStatus === "COMPLETE" &&
        state.specVerdict !== null &&
        state.delegationDisposition === "CANDIDATE"
      );
    }
    if (gate === "agent-delegable") {
      return (
        state.evaluationStatus === "COMPLETE" &&
        state.specVerdict === "READY" &&
        state.delegationDisposition === "CANDIDATE"
      );
    }
    return (
      state.evaluationStatus === "COMPLETE" &&
      state.specVerdict === "READY" &&
      (state.delegationDisposition === "CANDIDATE" ||
        state.delegationDisposition === "SUPERVISED")
    );
  }

  it("covers all 48 raw axis combinations for every registered gate", () => {
    let combinations = 0;
    for (const evaluationStatus of evaluationStatuses) {
      for (const specVerdict of specVerdicts) {
        for (const delegationDisposition of dispositions) {
          const state = {
            evaluationStatus,
            specVerdict,
            delegationDisposition,
          } as TriAxisState;
          for (const gate of gates) {
            const result = evaluateGate(gate, state);
            const accepted = expected(gate, state);
            expect(result, `${gate}:${JSON.stringify(state)}`).toEqual({
              gate,
              accepted,
              exitCode: evaluationStatus === "ERROR" ? 3 : accepted ? 0 : 4,
              reason:
                evaluationStatus === "ERROR"
                  ? "EVALUATION_ERROR"
                  : accepted
                    ? "PASS"
                    : "GATE_MISMATCH",
            });
            expect(Object.isFrozen(result)).toBe(true);
          }
          combinations += 1;
        }
      }
    }
    expect(combinations).toBe(48);
  });

  it("requires the explicit inert-degraded gate for retained READY", () => {
    const state: TriAxisState = {
      evaluationStatus: "DEGRADED",
      specVerdict: "READY",
      delegationDisposition: "CANDIDATE",
    };
    expect(evaluateGate("spec-ready", state).exitCode).toBe(4);
    expect(
      evaluateGate("spec-ready-allow-inert-degraded", state).exitCode,
    ).toBe(0);
  });

  it("aggregates batch status with ERROR above gate mismatch above pass", () => {
    const passState: TriAxisState = {
      evaluationStatus: "COMPLETE",
      specVerdict: "READY",
      delegationDisposition: "CANDIDATE",
    };
    const mismatchState: TriAxisState = {
      evaluationStatus: "COMPLETE",
      specVerdict: "NEEDS_INFO",
      delegationDisposition: "CANDIDATE",
    };
    const errorState: TriAxisState = {
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
    };
    const mismatch = evaluateBatchGate("agent-delegable", [
      passState,
      mismatchState,
    ]);
    expect(mismatch).toEqual({
      gate: "agent-delegable",
      accepted: false,
      exitCode: 4,
      results: [
        {
          gate: "agent-delegable",
          accepted: true,
          exitCode: 0,
          reason: "PASS",
        },
        {
          gate: "agent-delegable",
          accepted: false,
          exitCode: 4,
          reason: "GATE_MISMATCH",
        },
      ],
    });
    const error = evaluateBatchGate("agent-delegable", [
      passState,
      mismatchState,
      errorState,
    ]);
    expect(error).toMatchObject({ accepted: false, exitCode: 3 });
    expect(error.results[2]).toEqual({
      gate: "agent-delegable",
      accepted: false,
      exitCode: 3,
      reason: "EVALUATION_ERROR",
    });
    expect(Object.isFrozen(mismatch)).toBe(true);
    expect(Object.isFrozen(mismatch.results)).toBe(true);
  });

  it("accepts an empty batch and an all-pass batch", () => {
    expect(evaluateBatchGate("agent-delegable", [])).toEqual({
      gate: "agent-delegable",
      accepted: true,
      exitCode: 0,
      results: [],
    });
    expect(
      evaluateBatchGate("agent-delegable", [
        {
          evaluationStatus: "COMPLETE",
          specVerdict: "READY",
          delegationDisposition: "CANDIDATE",
        },
      ]),
    ).toMatchObject({ accepted: true, exitCode: 0 });
  });
});
