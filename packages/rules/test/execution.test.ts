import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decide } from "@issueready/decision";
import fc from "fast-check";
import type { PolicyDisposition } from "@issueready/policy";
import type {
  IssueSnapshotV1Alpha1,
  RuleExecutionFixtureCatalogV1Alpha1,
  RuleManifestV1Alpha1,
  TaskPackManifestV1Alpha1,
} from "@issueready/schema";
import { compileSchema } from "@issueready/schema";
import { buildSnapshot } from "@issueready/snapshot";
import { describe, expect, it } from "vitest";

import {
  executeDeterministicSnapshot,
  executeTaskPack,
  type RuleSignal,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function loadDirectory<Value>(relativeDirectory: string): readonly Value[] {
  const directory = join(repositoryRoot, relativeDirectory);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(join(directory, name), "utf8")) as Value,
    );
}

function loadJson<Value>(relativePath: string): Value {
  return JSON.parse(
    readFileSync(join(repositoryRoot, relativePath), "utf8"),
  ) as Value;
}

const rules = loadDirectory<RuleManifestV1Alpha1>("rules/catalog/v1alpha1");
const taskPacks = loadDirectory<TaskPackManifestV1Alpha1>(
  "rules/task-packs/v1alpha1",
);

function native(): IssueSnapshotV1Alpha1["native"] {
  return {
    issueType: null,
    fields: [],
    parent: null,
    subIssues: [],
    blockedBy: [],
    blocking: [],
    capabilities: {
      issueTypes: {
        availability: "UNAVAILABLE",
        checkedBy: "LOCAL_SOURCE",
        reason: "SOURCE_NOT_APPLICABLE",
      },
      fields: {
        availability: "UNAVAILABLE",
        checkedBy: "LOCAL_SOURCE",
        reason: "SOURCE_NOT_APPLICABLE",
      },
      parent: {
        availability: "UNAVAILABLE",
        checkedBy: "LOCAL_SOURCE",
        reason: "SOURCE_NOT_APPLICABLE",
      },
      subIssues: {
        availability: "UNAVAILABLE",
        checkedBy: "LOCAL_SOURCE",
        reason: "SOURCE_NOT_APPLICABLE",
      },
      dependencies: {
        availability: "UNAVAILABLE",
        checkedBy: "LOCAL_SOURCE",
        reason: "SOURCE_NOT_APPLICABLE",
      },
      references: {
        availability: "UNAVAILABLE",
        checkedBy: "LOCAL_SOURCE",
        reason: "SOURCE_NOT_APPLICABLE",
      },
    },
    references: [],
  };
}

function snapshot(
  body: string,
  options: {
    readonly truncated?: boolean;
    readonly omittedBytes?: number;
    readonly native?: ReturnType<typeof native>;
  } = {},
) {
  return buildSnapshot({
    source: { kind: "local", path: "issue.md", updatedAt: null },
    title: "Document deterministic evaluation behavior",
    body,
    labels: [],
    comments: [],
    native: options.native ?? native(),
    evaluatedAt: "2026-07-18T00:00:00Z",
    truncated: options.truncated ?? false,
    omittedBytes: options.omittedBytes ?? 0,
  });
}

function candidatePolicy(): PolicyDisposition {
  return {
    disposition: "CANDIDATE",
    reasons: [{ source: "DEFAULT", key: "default", disposition: "CANDIDATE" }],
    localFindingIds: [],
  };
}

function item(result: ReturnType<typeof executeTaskPack>, ruleId: string) {
  const selected = result.rules.find((rule) => rule.ruleId === ruleId);
  expect(selected, ruleId).toBeDefined();
  return selected;
}

describe("deterministic manifest execution", () => {
  it.each([
    {
      availability: "AVAILABLE" as const,
      reason: null,
      traceOutcome: "PASS",
      contextOutcome: "PASS",
      hardPredicateProven: false,
    },
    {
      availability: "UNAVAILABLE" as const,
      reason: "PERMISSION_DENIED" as const,
      traceOutcome: "FAIL",
      contextOutcome: "FAIL",
      hardPredicateProven: true,
    },
    {
      availability: "UNKNOWN" as const,
      reason: "TRANSIENT_ERROR" as const,
      traceOutcome: "UNKNOWN",
      contextOutcome: "UNKNOWN",
      hardPredicateProven: false,
    },
  ])(
    "maps native reference $availability without turning transient failure into content failure",
    ({ availability, traceOutcome, contextOutcome, hardPredicateProven }) => {
      const nativeInput = native();
      nativeInput.capabilities.references =
        availability === "UNKNOWN"
          ? {
              availability,
              checkedBy: "GITHUB_REST",
              reason: "TRANSIENT_ERROR",
            }
          : {
              availability: "AVAILABLE",
              checkedBy: "GITHUB_REST",
              reason: null,
            };
      nativeInput.references = [
        availability === "AVAILABLE"
          ? {
              target: "#42",
              kind: "ISSUE",
              essential: true,
              availability,
              checkedBy: "GITHUB_REST",
              reason: null,
            }
          : availability === "UNAVAILABLE"
            ? {
                target: "#42",
                kind: "ISSUE",
                essential: true,
                availability,
                checkedBy: "GITHUB_REST",
                reason: "PERMISSION_DENIED",
              }
            : {
                target: "#42",
                kind: "ISSUE",
                essential: true,
                availability,
                checkedBy: "GITHUB_REST",
                reason: "TRANSIENT_ERROR",
              },
      ];
      const result = executeDeterministicSnapshot({
        snapshot: snapshot("Implementation depends on #42.", {
          native: nativeInput,
        }),
        taskType: "generic",
        rules,
        taskPacks,
        policyDisposition: candidatePolicy(),
      });
      expect(item(result, "IR-TRC-001")).toMatchObject({
        outcome: traceOutcome,
      });
      expect(item(result, "IR-CTX-003")).toMatchObject({
        outcome: contextOutcome,
        hardPredicateProven,
      });
    },
  );

  it("executes the full 24-rule synthetic outcome matrix", () => {
    const catalog = loadJson<RuleExecutionFixtureCatalogV1Alpha1>(
      "fixtures/rules/four-state.v1alpha1.json",
    );
    const validate = compileSchema(
      loadJson<object>("schemas/v1alpha1/rule-execution-fixture.schema.json"),
    );
    expect(validate(catalog)).toEqual({ valid: true, issues: [] });
    expect(catalog.fixtures).toHaveLength(303);
    expect(new Set(catalog.fixtures.map((fixture) => fixture.id)).size).toBe(
      303,
    );

    for (const fixture of catalog.fixtures) {
      expect(
        rules.find((manifest) => manifest.id === fixture.ruleId)?.revision,
        fixture.id,
      ).toBe(fixture.ruleRevision);
      expect(
        taskPacks.find((pack) => pack.id === fixture.taskType)?.revision,
        fixture.id,
      ).toBe(fixture.taskPackRevision);
      const execute = () =>
        executeTaskPack({
          taskType: fixture.taskType,
          rules,
          taskPacks,
          signals: fixture.signals.map((signal) => ({
            ruleId: fixture.ruleId,
            source: signal.source,
            outcome: signal.outcome,
            ...(signal.hardPredicateProven === undefined
              ? {}
              : { hardPredicateProven: signal.hardPredicateProven }),
            ...(signal.policyEffect === undefined
              ? {}
              : { policyEffect: signal.policyEffect }),
          })),
          snapshotValid: true,
        });
      if (fixture.expected.kind === "RESULT") {
        expect(item(execute(), fixture.ruleId), fixture.id).toMatchObject({
          outcome: fixture.expected.outcome,
          hardPredicateProven: fixture.expected.hardPredicateProven,
        });
      } else {
        const expectedError = {
          UNREGISTERED_SOURCE: /not registered/u,
          POLICY_EFFECT_BOUNDARY: /policy effect/u,
          HARD_PREDICATE_BOUNDARY: /hard predicate proof/u,
        } as const;
        expect(execute, fixture.id).toThrow(
          expectedError[fixture.expected.code],
        );
      }
    }
    for (const manifest of rules) {
      expect(
        new Set(
          catalog.fixtures.flatMap((fixture) =>
            fixture.ruleId === manifest.id &&
            fixture.scenarioKind === "SINGLE_SOURCE_OUTCOME" &&
            fixture.expected.kind === "RESULT"
              ? [fixture.expected.outcome]
              : [],
          ),
        ),
        manifest.id,
      ).toEqual(new Set(["PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"]));
    }
  });

  it("extracts conservative structural evidence without inventing semantic outcomes", () => {
    const source = [
      "## Acceptance criteria",
      "",
      "- [ ] The CLI prints a stable JSON report.",
      "",
      "## Validation",
      "",
      "Run `pnpm test` against packages/rules/src/index.ts.",
    ].join("\n");
    const issue = snapshot(source);
    const result = executeDeterministicSnapshot({
      snapshot: issue,
      taskType: "generic",
      rules,
      taskPacks,
      policyDisposition: candidatePolicy(),
    });

    expect(item(result, "IR-INP-001")).toMatchObject({ outcome: "PASS" });
    expect(item(result, "IR-CTX-001")).toMatchObject({ outcome: "PASS" });
    expect(item(result, "IR-VAL-001")).toMatchObject({ outcome: "UNKNOWN" });
    expect(item(result, "IR-ACC-001")).toMatchObject({
      outcome: "UNKNOWN",
      hardPredicateProven: false,
    });
    expect(result.evaluationReasons).toEqual(["IR-SEM-000"]);
    expect(
      result.canonicalFindings.some(
        (finding) => finding.ruleId === "IR-SEM-000",
      ),
    ).toBe(false);
    expect(decide(result.decisionInput)).toMatchObject({
      evaluationStatus: "DEGRADED",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
    });
    for (const finding of result.canonicalFindings) {
      for (const evidence of finding.evidence) {
        expect(evidence.snapshotDigest).toBe(issue.integrity.snapshotDigest);
        if (
          evidence.document === "issue.body" &&
          evidence.quote !== undefined
        ) {
          expect(source.slice(evidence.startUtf16, evidence.endUtf16)).toBe(
            evidence.quote,
          );
        }
      }
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rules)).toBe(true);
  });

  it("does not turn acceptance-heading absence into a hard failure", () => {
    const prose = snapshot(
      "The change is complete when the JSON output is stable across runs.",
    );
    const headed = snapshot(
      "## Acceptance criteria\n\nThe JSON output is stable across runs.\n",
    );
    for (const issue of [prose, headed]) {
      const result = executeDeterministicSnapshot({
        snapshot: issue,
        taskType: "generic",
        rules,
        taskPacks,
        policyDisposition: candidatePolicy(),
      });
      expect(item(result, "IR-ACC-001")?.outcome).toBe("UNKNOWN");
      expect(item(result, "IR-ACC-001")?.hardPredicateProven).toBe(false);
    }
  });

  it("routes truncated input through the evaluation axis and never NEEDS_INFO", () => {
    const result = executeDeterministicSnapshot({
      snapshot: snapshot("Partial body", {
        truncated: true,
        omittedBytes: 512,
      }),
      taskType: "generic",
      rules,
      taskPacks,
      policyDisposition: candidatePolicy(),
    });
    expect(item(result, "IR-INP-001")).toMatchObject({
      outcome: "FAIL",
      bucket: "evaluation",
      hardPredicateProven: true,
    });
    expect(decide(result.decisionInput)).toMatchObject({
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      reasons: ["IR-INP-001:FAIL"],
    });
  });

  it("lets a registered hard fact override a semantic PASS", () => {
    const signals: readonly RuleSignal[] = [
      {
        ruleId: "IR-ACC-001",
        source: "semantic-criterion:observable-acceptance",
        outcome: "PASS",
      },
      {
        ruleId: "IR-ACC-001",
        source: "issue-form-field:acceptance",
        outcome: "FAIL",
        hardPredicateProven: true,
      },
    ];
    const result = executeTaskPack({
      taskType: "generic",
      rules,
      taskPacks,
      signals,
      snapshotValid: true,
    });
    expect(item(result, "IR-ACC-001")).toMatchObject({
      outcome: "FAIL",
      hardPredicateProven: true,
      source: "HYBRID",
    });
  });

  it("rejects unregistered signal sources and unassigned task-pack rules", () => {
    expect(() =>
      executeTaskPack({
        taskType: "generic",
        rules,
        taskPacks,
        signals: [
          {
            ruleId: "IR-ACC-001",
            source: "markdown-ast:missing-heading-veto",
            outcome: "FAIL",
          },
        ],
        snapshotValid: true,
      }),
    ).toThrow(/not registered/u);
    expect(() =>
      executeTaskPack({
        taskType: "generic",
        rules,
        taskPacks,
        signals: [
          {
            ruleId: "IR-BUG-001",
            source: "markdown-ast:observed-expected",
            outcome: "PASS",
          },
        ],
        snapshotValid: true,
      }),
    ).toThrow(/unassigned/u);
  });

  it("is byte-stable across input signal permutations", () => {
    const signals: readonly RuleSignal[] = [
      {
        ruleId: "IR-CTX-001",
        source: "markdown-ast:code-symbol-link",
        outcome: "PASS",
      },
      {
        ruleId: "IR-CTX-001",
        source: "markdown-ast:code-symbol-link",
        outcome: "FAIL",
      },
      {
        ruleId: "IR-INP-001",
        source: "snapshot-integrity:validation",
        outcome: "PASS",
      },
    ];
    const baseline = JSON.stringify(
      executeTaskPack({
        taskType: "generic",
        rules,
        taskPacks,
        signals,
        snapshotValid: true,
      }),
    );
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...signals], {
          minLength: signals.length,
          maxLength: signals.length,
        }),
        (permutation) => {
          expect(
            JSON.stringify(
              executeTaskPack({
                taskType: "generic",
                rules,
                taskPacks,
                signals: permutation,
                snapshotValid: true,
              }),
            ),
          ).toBe(baseline);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("keeps a HUMAN_ONLY policy orthogonal to a fully proven READY spec", () => {
    const generic = taskPacks.find((pack) => pack.id === "generic");
    expect(generic).toBeDefined();
    const rulesById = new Map(rules.map((manifest) => [manifest.id, manifest]));
    const signals: RuleSignal[] = [];
    for (const bucket of [
      "mandatory",
      "conditional",
      "advisory",
      "evaluation",
    ] as const) {
      for (const ruleId of generic?.criteria[bucket] ?? []) {
        const manifest = rulesById.get(ruleId);
        expect(manifest, ruleId).toBeDefined();
        signals.push({
          ruleId,
          source: manifest?.evidenceSources[0] ?? "",
          outcome: "PASS",
        });
      }
    }
    signals.push({
      ruleId: "IR-POL-001",
      source: "repository-policy:delegation-map",
      outcome: "FAIL",
      hardPredicateProven: true,
      policyEffect: "HUMAN_ONLY",
      independentHardBoundary: true,
    });
    const result = executeTaskPack({
      taskType: "generic",
      rules,
      taskPacks,
      signals,
      snapshotValid: true,
    });
    expect(decide(result.decisionInput)).toMatchObject({
      evaluationStatus: "COMPLETE",
      specVerdict: "READY",
      delegationDisposition: "HUMAN_ONLY",
    });
  });
});
