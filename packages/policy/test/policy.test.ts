import fc from "fast-check";
import type { IssueReadyPolicyV1Alpha1 } from "@issueready/schema";
import { describe, expect, it } from "vitest";

import {
  calculatePolicyDigest,
  evaluatePolicyDisposition,
  mergePolicies,
  selectTaskType,
  type PolicyLayer,
  type PolicyLayerSource,
  type TaskTypeSelection,
  type TaskTypeSelectionInput,
} from "../src/index.js";

function policy(
  name: string,
  overrides: Partial<IssueReadyPolicyV1Alpha1["spec"]> = {},
): IssueReadyPolicyV1Alpha1 {
  return {
    apiVersion: "https://example.invalid/issueready/config/v1alpha1",
    kind: "IssueReadyPolicy",
    metadata: { name },
    spec: {
      evaluationProfile: "baseline-v1",
      locale: "en",
      context: {
        includeCommentsFrom: ["issue-author", "owner"],
        maxInputBytes: 131_072,
        fetchExternalLinks: false,
      },
      githubWrite: { mode: "disabled" },
      ...overrides,
    },
  };
}

function selectionInput(
  selectedPolicy: IssueReadyPolicyV1Alpha1,
): TaskTypeSelectionInput {
  return {
    policy: selectedPolicy,
    nativeIssueType: null,
    explicitTaskType: null,
    issueFormTemplatePath: null,
    labels: [],
    deterministicHint: null,
    semanticHint: null,
  };
}

function layer(
  source: PolicyLayerSource,
  selectedPolicy: IssueReadyPolicyV1Alpha1,
): PolicyLayer {
  return {
    source,
    digest: calculatePolicyDigest(selectedPolicy),
    policy: selectedPolicy,
  };
}

function selectionAttempt(
  selection: TaskTypeSelection,
  source: TaskTypeSelection["source"],
) {
  const attempt = selection.attempts.find(
    (candidate) => candidate.source === source,
  );
  expect(attempt).toBeDefined();
  return attempt;
}

describe("deterministic policy merge", () => {
  it("applies fixed precedence, preserves map entries, and records leaf provenance", () => {
    const builtIn = policy("built-in", {
      taskTypes: { trustedLabelMappings: { bug: "bug" } },
      suggestions: { maxQuestions: 5, maxSplits: 8 },
    });
    const repository = policy("repository", {
      taskTypes: {
        trustedLabelMappings: { enhancement: "feature" },
        nativeTypeMappings: { Incident: "operations" },
      },
      suggestions: { maxQuestions: 3 },
    });
    const layers: readonly PolicyLayer[] = [
      {
        source: "BUILT_IN",
        digest: calculatePolicyDigest(builtIn),
        policy: builtIn,
      },
      {
        source: "DEFAULT_BRANCH",
        digest: calculatePolicyDigest(repository),
        policy: repository,
      },
    ];
    const result = mergePolicies(layers);

    expect(result.policy.spec.taskTypes?.trustedLabelMappings).toEqual({
      bug: "bug",
      enhancement: "feature",
    });
    expect(result.policy.spec.suggestions).toEqual({
      maxQuestions: 3,
      maxSplits: 8,
    });
    expect(result.provenance["/spec/suggestions/maxQuestions"]).toEqual({
      source: "DEFAULT_BRANCH",
      digest: calculatePolicyDigest(repository),
    });
    expect(Object.isFrozen(result.policy)).toBe(true);
    expect(builtIn.spec.taskTypes?.trustedLabelMappings).toEqual({
      bug: "bug",
    });
    expect(mergePolicies(layers).digest).toBe(result.digest);
  });

  it("rejects missing built-ins, duplicate layers, and out-of-order precedence", () => {
    const builtIn = policy("built-in");
    const repository = policy("repository");
    expect(() =>
      mergePolicies([
        {
          source: "DEFAULT_BRANCH",
          digest: calculatePolicyDigest(repository),
          policy: repository,
        },
      ]),
    ).toThrow(/BUILT_IN/u);
    expect(() =>
      mergePolicies([
        {
          source: "BUILT_IN",
          digest: calculatePolicyDigest(builtIn),
          policy: builtIn,
        },
        {
          source: "DEFAULT_BRANCH",
          digest: calculatePolicyDigest(repository),
          policy: repository,
        },
        {
          source: "DEPLOYMENT_ADMIN",
          digest: calculatePolicyDigest(repository),
          policy: repository,
        },
      ]),
    ).toThrow(/precedence/u);
  });

  it("rejects a policy layer whose claimed digest does not bind its bytes", () => {
    const builtIn = policy("built-in");
    expect(() =>
      mergePolicies([
        {
          source: "BUILT_IN",
          digest: `sha256:${"f".repeat(64)}`,
          policy: builtIn,
        },
      ]),
    ).toThrow(/digest mismatch/u);
  });

  it("rejects an empty layer set, duplicate source, and malformed digest independently", () => {
    const builtIn = policy("built-in");
    expect(() => mergePolicies([])).toThrow(/BUILT_IN/u);
    expect(() =>
      mergePolicies([layer("BUILT_IN", builtIn), layer("BUILT_IN", builtIn)]),
    ).toThrow(/unique/u);
    expect(() =>
      mergePolicies([
        {
          source: "BUILT_IN",
          digest: "sha256:not-a-digest" as PolicyLayer["digest"],
          policy: builtIn,
        },
      ]),
    ).toThrow(/Invalid policy layer digest/u);
  });

  it("uses canonical object-key order for policy digests", () => {
    const original = policy("canonical", {
      suggestions: { maxQuestions: 2, maxSplits: 4 },
    });
    const reordered = {
      kind: original.kind,
      apiVersion: original.apiVersion,
      spec: {
        githubWrite: original.spec.githubWrite,
        context: original.spec.context,
        suggestions: original.spec.suggestions,
        locale: original.spec.locale,
        evaluationProfile: original.spec.evaluationProfile,
      },
      metadata: original.metadata,
    } as IssueReadyPolicyV1Alpha1;
    expect(calculatePolicyDigest(reordered)).toBe(
      calculatePolicyDigest(original),
    );
    expect(calculatePolicyDigest(original)).toBe(
      "sha256:fd3f4fef3c836d778ac2755c7fff11ab5c5b181372b8aa1f9224776be6e405b4",
    );

    const arrayPolicy = policy("array-canonical", {
      localFindings: [
        {
          dispositionEffect: "SUPERVISED",
          match: { labelsAny: ["x"] },
          messageKey: "m",
          id: "LOCAL-ARRAY",
        },
      ],
    });
    expect(calculatePolicyDigest(arrayPolicy)).toBe(
      "sha256:ce9f06322cec244b2f3550ce2af129533ce1332ee3a67e89dd238c1135c6b734",
    );
  });

  it("merges every configurable collection with higher-layer scalar precedence", () => {
    const builtIn = policy("built-in", {
      taskTypes: {
        nativeTypeMappings: { Bug: "bug" },
        issueFormMappings: { "bug.yml": "bug" },
        trustedLabelMappings: { docs: "docs" },
      },
      delegation: {
        default: "CANDIDATE",
        nativeTypeMappings: { Incident: "SUPERVISED" },
        trustedLabelMappings: { sensitive: "SUPERVISED" },
      },
      localFindings: [
        {
          id: "LOCAL-ONE",
          messageKey: "old",
          match: { labelsAny: ["old"] },
          dispositionEffect: "SUPERVISED",
        },
      ],
      semantic: { enabled: false },
      suggestions: { maxQuestions: 5, maxSplits: 8 },
    });
    const repository = policy("repository", {
      taskTypes: {
        nativeTypeMappings: { Feature: "feature" },
        issueFormMappings: { "feature.yml": "feature" },
        trustedLabelMappings: { enhancement: "feature" },
      },
      delegation: {
        default: "SUPERVISED",
        nativeTypeMappings: { Incident: "HUMAN_ONLY" },
        trustedLabelMappings: { release: "HUMAN_ONLY" },
      },
      localFindings: [
        {
          id: "LOCAL-ONE",
          messageKey: "new",
          match: { labelsAny: ["new"] },
          dispositionEffect: "HUMAN_ONLY",
        },
        {
          id: "LOCAL-TWO",
          messageKey: "second",
          match: { pathPrefixesAny: ["infra/"] },
          dispositionEffect: "SUPERVISED",
        },
      ],
      semantic: { enabled: true },
      suggestions: { maxQuestions: 2 },
    });
    const result = mergePolicies([
      layer("BUILT_IN", builtIn),
      layer("DEFAULT_BRANCH", repository),
    ]);

    expect(result.policy).toEqual({
      apiVersion: repository.apiVersion,
      kind: repository.kind,
      metadata: { name: "repository" },
      spec: {
        evaluationProfile: "baseline-v1",
        locale: "en",
        taskTypes: {
          nativeTypeMappings: { Bug: "bug", Feature: "feature" },
          issueFormMappings: {
            "bug.yml": "bug",
            "feature.yml": "feature",
          },
          trustedLabelMappings: { docs: "docs", enhancement: "feature" },
        },
        localFindings: repository.spec.localFindings,
        delegation: {
          default: "SUPERVISED",
          nativeTypeMappings: { Incident: "HUMAN_ONLY" },
          trustedLabelMappings: {
            sensitive: "SUPERVISED",
            release: "HUMAN_ONLY",
          },
        },
        context: repository.spec.context,
        semantic: { enabled: true },
        suggestions: { maxQuestions: 2, maxSplits: 8 },
        githubWrite: { mode: "disabled" },
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.provenance)).toBe(true);
    expect(Object.isFrozen(result.policy.spec.localFindings)).toBe(true);
    expect(Object.isFrozen(result.policy.spec.localFindings?.[0])).toBe(true);
    expect(
      Object.isFrozen(result.policy.spec.localFindings?.[0]?.match.labelsAny),
    ).toBe(true);
    expect(
      Object.isFrozen(result.policy.spec.context.includeCommentsFrom),
    ).toBe(true);
  });

  it("keeps lower semantic config when a higher layer omits it and escapes provenance pointers", () => {
    const builtIn = policy("built-in", {
      semantic: { enabled: false },
      taskTypes: {
        trustedLabelMappings: { "needs/review~now": "generic" },
      },
    });
    const repository = policy("repository");
    const result = mergePolicies([
      layer("BUILT_IN", builtIn),
      layer("DEFAULT_BRANCH", repository),
    ]);

    expect(result.policy.spec.semantic).toEqual({ enabled: false });
    expect(
      result.provenance[
        "/spec/taskTypes/trustedLabelMappings/needs~1review~0now"
      ],
    ).toEqual({
      source: "BUILT_IN",
      digest: calculatePolicyDigest(builtIn),
    });
    expect(result.provenance["/spec/context/includeCommentsFrom"]).toEqual({
      source: "DEFAULT_BRANCH",
      digest: calculatePolicyDigest(repository),
    });
  });

  it("preserves sparse optional sections from either side and omits them when both sides lack them", () => {
    const lowerOnly = policy("lower", {
      taskTypes: { nativeTypeMappings: { Bug: "bug" } },
      delegation: {
        default: "SUPERVISED",
        nativeTypeMappings: { Incident: "HUMAN_ONLY" },
      },
      localFindings: [
        {
          id: "LOCAL-LOWER",
          messageKey: "lower",
          match: { labelsAny: ["lower"] },
          dispositionEffect: "SUPERVISED",
        },
      ],
      suggestions: { maxQuestions: 3 },
    });
    const minimal = policy("minimal");
    const higherOnly = policy("higher", {
      taskTypes: {
        issueFormMappings: { "feature.yml": "feature" },
        trustedLabelMappings: { enhancement: "feature" },
      },
      delegation: {
        trustedLabelMappings: { release: "HUMAN_ONLY" },
      },
      localFindings: [
        {
          id: "LOCAL-HIGHER",
          messageKey: "higher",
          match: { pathPrefixesAny: ["infra/"] },
          dispositionEffect: "HUMAN_ONLY",
        },
      ],
      suggestions: { maxSplits: 4 },
    });

    const retained = mergePolicies([
      layer("BUILT_IN", lowerOnly),
      layer("DEFAULT_BRANCH", minimal),
    ]).policy;
    expect(retained.spec.taskTypes).toStrictEqual({
      nativeTypeMappings: { Bug: "bug" },
    });
    expect(Object.keys(retained.spec.taskTypes ?? {})).toEqual([
      "nativeTypeMappings",
    ]);
    expect(retained.spec.delegation).toStrictEqual({
      default: "SUPERVISED",
      nativeTypeMappings: { Incident: "HUMAN_ONLY" },
    });
    expect(Object.keys(retained.spec.delegation ?? {})).toEqual([
      "default",
      "nativeTypeMappings",
    ]);
    expect(retained.spec.localFindings).toEqual(lowerOnly.spec.localFindings);
    expect(retained.spec.suggestions).toEqual({ maxQuestions: 3 });

    const introduced = mergePolicies([
      layer("BUILT_IN", minimal),
      layer("DEFAULT_BRANCH", higherOnly),
    ]).policy;
    expect(introduced.spec.taskTypes).toStrictEqual({
      issueFormMappings: { "feature.yml": "feature" },
      trustedLabelMappings: { enhancement: "feature" },
    });
    expect(Object.keys(introduced.spec.taskTypes ?? {})).toEqual([
      "issueFormMappings",
      "trustedLabelMappings",
    ]);
    expect(introduced.spec.delegation).toStrictEqual({
      trustedLabelMappings: { release: "HUMAN_ONLY" },
    });
    expect(Object.keys(introduced.spec.delegation ?? {})).toEqual([
      "trustedLabelMappings",
    ]);
    expect(introduced.spec.localFindings).toEqual(
      higherOnly.spec.localFindings,
    );
    expect(introduced.spec.suggestions).toEqual({ maxSplits: 4 });

    const omitted = mergePolicies([
      layer("BUILT_IN", minimal),
      layer("DEFAULT_BRANCH", policy("also-minimal")),
    ]).policy.spec;
    expect(omitted).not.toHaveProperty("taskTypes");
    expect(omitted).not.toHaveProperty("delegation");
    expect(omitted).not.toHaveProperty("localFindings");
    expect(omitted).not.toHaveProperty("semantic");
    expect(omitted).not.toHaveProperty("suggestions");
  });

  it("records an explicitly empty object as one provenance leaf", () => {
    const builtIn = policy("empty", { taskTypes: {} });
    const result = mergePolicies([layer("BUILT_IN", builtIn)]);
    expect(result.provenance["/spec/taskTypes"]).toEqual({
      source: "BUILT_IN",
      digest: calculatePolicyDigest(builtIn),
    });
    expect(result.provenance).not.toHaveProperty("Stryker was here");
  });

  it.each([`xsha256:${"a".repeat(64)}`, `sha256:${"a".repeat(64)}x`])(
    "rejects a digest with data outside the exact envelope",
    (digest) => {
      const builtIn = policy("built-in");
      expect(() =>
        mergePolicies([
          {
            source: "BUILT_IN",
            digest: digest as PolicyLayer["digest"],
            policy: builtIn,
          },
        ]),
      ).toThrow(/Invalid policy layer digest/u);
    },
  );
});

describe("registered task-pack selection", () => {
  const mappedPolicy = policy("mapped", {
    taskTypes: {
      nativeTypeMappings: { Bug: "bug" },
      issueFormMappings: { ".github/ISSUE_TEMPLATE/feature.yml": "feature" },
      trustedLabelMappings: {
        documentation: "docs",
        enhancement: "feature",
      },
    },
    semantic: { enabled: true },
  });

  it("uses the fixed source priority and reports every attempt", () => {
    const result = selectTaskType({
      ...selectionInput(mappedPolicy),
      nativeIssueType: "BUG",
      explicitTaskType: "refactor",
      issueFormTemplatePath: ".github/ISSUE_TEMPLATE/feature.yml",
      labels: ["documentation"],
      deterministicHint: "test-ci",
      semanticHint: "operations",
    });
    expect(result).toEqual({
      taskType: "bug",
      source: "NATIVE_ISSUE_TYPE",
      attempts: [
        {
          source: "NATIVE_ISSUE_TYPE",
          status: "MATCHED",
          taskType: "bug",
          evidence: ["Bug"],
        },
        {
          source: "EXPLICIT_CONFIG",
          status: "MATCHED",
          taskType: "refactor",
          evidence: ["refactor"],
        },
        {
          source: "ISSUE_FORM",
          status: "MATCHED",
          taskType: "feature",
          evidence: [".github/ISSUE_TEMPLATE/feature.yml"],
        },
        {
          source: "TRUSTED_LABEL",
          status: "MATCHED",
          taskType: "docs",
          evidence: ["documentation"],
        },
        {
          source: "DETERMINISTIC_HINT",
          status: "MATCHED",
          taskType: "test-ci",
          evidence: ["test-ci"],
        },
        {
          source: "SEMANTIC_CLASSIFIER",
          status: "MATCHED",
          taskType: "operations",
          evidence: ["operations"],
        },
        {
          source: "FALLBACK",
          status: "MATCHED",
          taskType: "generic",
          evidence: [],
        },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.attempts)).toBe(true);
  });

  it("does not choose between conflicting trusted labels", () => {
    const result = selectTaskType({
      ...selectionInput(mappedPolicy),
      labels: ["enhancement", "documentation"],
      deterministicHint: "dependency",
    });
    expect(result).toMatchObject({
      taskType: "dependency",
      source: "DETERMINISTIC_HINT",
    });
    expect(selectionAttempt(result, "TRUSTED_LABEL")).toEqual({
      source: "TRUSTED_LABEL",
      status: "AMBIGUOUS",
      taskType: null,
      evidence: ["documentation:docs", "enhancement:feature"],
    });
  });

  it("uses generic fallback and ignores semantic hints when disabled", () => {
    const result = selectTaskType({
      ...selectionInput(policy("offline", { semantic: { enabled: false } })),
      semanticHint: "feature",
    });
    expect(result).toMatchObject({ taskType: "generic", source: "FALLBACK" });
    expect(
      result.attempts.find(
        (attempt) => attempt.source === "SEMANTIC_CLASSIFIER",
      ),
    ).toMatchObject({ status: "DISABLED" });
  });

  it("distinguishes ABSENT, UNMAPPED, INVALID, and DISABLED attempts", () => {
    const result = selectTaskType({
      ...selectionInput(policy("minimal", { semantic: { enabled: false } })),
      nativeIssueType: "Bug",
      explicitTaskType: "BUG",
      issueFormTemplatePath: "bug.yml",
      deterministicHint: "not-registered",
      semanticHint: "feature",
    });
    expect(selectionAttempt(result, "NATIVE_ISSUE_TYPE")).toEqual({
      source: "NATIVE_ISSUE_TYPE",
      status: "UNMAPPED",
      taskType: null,
      evidence: ["Bug"],
    });
    expect(selectionAttempt(result, "EXPLICIT_CONFIG")).toEqual({
      source: "EXPLICIT_CONFIG",
      status: "INVALID",
      taskType: null,
      evidence: ["BUG"],
    });
    expect(selectionAttempt(result, "ISSUE_FORM")).toMatchObject({
      status: "UNMAPPED",
      evidence: ["bug.yml"],
    });
    expect(selectionAttempt(result, "TRUSTED_LABEL")).toEqual({
      source: "TRUSTED_LABEL",
      status: "ABSENT",
      taskType: null,
      evidence: [],
    });
    expect(selectionAttempt(result, "DETERMINISTIC_HINT")).toMatchObject({
      status: "INVALID",
    });
    expect(selectionAttempt(result, "SEMANTIC_CLASSIFIER")).toEqual({
      source: "SEMANTIC_CLASSIFIER",
      status: "DISABLED",
      taskType: null,
      evidence: [],
    });
    expect(result).toMatchObject({ taskType: "generic", source: "FALLBACK" });
  });

  it("reports every absent source exactly before using fallback", () => {
    const result = selectTaskType(selectionInput(policy("empty")));
    expect(result).toEqual({
      taskType: "generic",
      source: "FALLBACK",
      attempts: [
        {
          source: "NATIVE_ISSUE_TYPE",
          status: "ABSENT",
          taskType: null,
          evidence: [],
        },
        {
          source: "EXPLICIT_CONFIG",
          status: "ABSENT",
          taskType: null,
          evidence: [],
        },
        {
          source: "ISSUE_FORM",
          status: "ABSENT",
          taskType: null,
          evidence: [],
        },
        {
          source: "TRUSTED_LABEL",
          status: "ABSENT",
          taskType: null,
          evidence: [],
        },
        {
          source: "DETERMINISTIC_HINT",
          status: "ABSENT",
          taskType: null,
          evidence: [],
        },
        {
          source: "SEMANTIC_CLASSIFIER",
          status: "DISABLED",
          taskType: null,
          evidence: [],
        },
        {
          source: "FALLBACK",
          status: "MATCHED",
          taskType: "generic",
          evidence: [],
        },
      ],
    });
  });

  it("retains evidence for defined mappings that do not match", () => {
    const selectedPolicy = policy("empty-mappings", {
      taskTypes: {
        nativeTypeMappings: {},
        issueFormMappings: {},
        trustedLabelMappings: {},
      },
    });
    const result = selectTaskType({
      ...selectionInput(selectedPolicy),
      nativeIssueType: "Bug",
      issueFormTemplatePath: "bug.yml",
      labels: ["unknown"],
    });
    expect(selectionAttempt(result, "NATIVE_ISSUE_TYPE")).toMatchObject({
      status: "UNMAPPED",
      evidence: ["Bug"],
    });
    expect(selectionAttempt(result, "ISSUE_FORM")).toMatchObject({
      status: "UNMAPPED",
      evidence: ["bug.yml"],
    });
    expect(selectionAttempt(result, "TRUSTED_LABEL")).toEqual({
      source: "TRUSTED_LABEL",
      status: "UNMAPPED",
      taskType: null,
      evidence: ["unknown"],
    });
  });

  it("sorts all normalized mapping keys that resolve to one task type", () => {
    const selectedPolicy = policy("duplicate-normalized", {
      taskTypes: {
        nativeTypeMappings: { Bug: "bug", " BUG ": "bug" },
      },
    });
    const result = selectTaskType({
      ...selectionInput(selectedPolicy),
      nativeIssueType: "bug",
    });
    expect(selectionAttempt(result, "NATIVE_ISSUE_TYPE")).toEqual({
      source: "NATIVE_ISSUE_TYPE",
      status: "MATCHED",
      taskType: "bug",
      evidence: [" BUG ", "Bug"],
    });
  });

  it("normalizes native keys but keeps Issue Form paths exact", () => {
    const selectedPolicy = policy("normalization", {
      taskTypes: {
        nativeTypeMappings: { " ＢＵＧ ": "bug" },
        issueFormMappings: { "Bug.yml": "bug" },
      },
    });
    const native = selectTaskType({
      ...selectionInput(selectedPolicy),
      nativeIssueType: "bug",
      issueFormTemplatePath: "bug.yml",
    });
    expect(native).toMatchObject({
      taskType: "bug",
      source: "NATIVE_ISSUE_TYPE",
    });
    expect(selectionAttempt(native, "ISSUE_FORM")).toMatchObject({
      status: "UNMAPPED",
    });
  });

  it("does not broaden lowercase normalization to uppercase-only Unicode equivalence", () => {
    const selectedPolicy = policy("unicode-case", {
      taskTypes: { nativeTypeMappings: { ß: "bug" } },
    });
    const result = selectTaskType({
      ...selectionInput(selectedPolicy),
      nativeIssueType: "SS",
    });
    expect(selectionAttempt(result, "NATIVE_ISSUE_TYPE")).toEqual({
      source: "NATIVE_ISSUE_TYPE",
      status: "UNMAPPED",
      taskType: null,
      evidence: ["SS"],
    });
    expect(result).toMatchObject({ taskType: "generic", source: "FALLBACK" });
  });

  it("rejects normalized mapping ambiguity and continues to the next source", () => {
    const selectedPolicy = policy("ambiguous", {
      taskTypes: {
        nativeTypeMappings: { Bug: "bug", " BUG ": "feature" },
      },
    });
    const result = selectTaskType({
      ...selectionInput(selectedPolicy),
      nativeIssueType: "bug",
      explicitTaskType: "docs",
    });
    expect(result).toMatchObject({
      taskType: "docs",
      source: "EXPLICIT_CONFIG",
    });
    expect(selectionAttempt(result, "NATIVE_ISSUE_TYPE")).toEqual({
      source: "NATIVE_ISSUE_TYPE",
      status: "AMBIGUOUS",
      taskType: null,
      evidence: [" BUG ", "Bug"],
    });
  });

  it("collapses multiple labels mapped to the same task type", () => {
    const selectedPolicy = policy("labels", {
      taskTypes: {
        trustedLabelMappings: { Documentation: "docs", docs: "docs" },
      },
    });
    const result = selectTaskType({
      ...selectionInput(selectedPolicy),
      labels: ["documentation", "docs", "unknown"],
    });
    expect(result).toMatchObject({ taskType: "docs", source: "TRUSTED_LABEL" });
    expect(selectionAttempt(result, "TRUSTED_LABEL")).toEqual({
      source: "TRUSTED_LABEL",
      status: "MATCHED",
      taskType: "docs",
      evidence: ["docs", "documentation"],
    });
  });

  it("uses a valid semantic hint only when the registered profile is enabled", () => {
    const result = selectTaskType({
      ...selectionInput(policy("semantic", { semantic: { enabled: true } })),
      semanticHint: "feature",
    });
    expect(result).toMatchObject({
      taskType: "feature",
      source: "SEMANTIC_CLASSIFIER",
    });
    expect(selectionAttempt(result, "SEMANTIC_CLASSIFIER")).toEqual({
      source: "SEMANTIC_CLASSIFIER",
      status: "MATCHED",
      taskType: "feature",
      evidence: ["feature"],
    });
  });
});

describe("delegation policy separation", () => {
  const delegationPolicy = policy("delegation", {
    taskTypes: { trustedLabelMappings: { bug: "bug" } },
    delegation: {
      default: "CANDIDATE",
      nativeTypeMappings: { Incident: "HUMAN_ONLY" },
      trustedLabelMappings: { sensitive: "SUPERVISED" },
    },
    localFindings: [
      {
        id: "LOCAL-PRODUCTION_PATH",
        messageKey: "local-findings.production-path",
        match: { pathPrefixesAny: ["infra/production/"] },
        dispositionEffect: "HUMAN_ONLY",
      },
    ],
  });

  it("computes only disposition/local findings and never a spec verdict", () => {
    const result = evaluatePolicyDisposition({
      policy: delegationPolicy,
      nativeIssueType: "incident",
      labels: ["sensitive"],
      changedPaths: ["infra/production/deploy.ts"],
    });
    expect(result).toEqual({
      disposition: "HUMAN_ONLY",
      reasons: [
        { source: "DEFAULT", key: "default", disposition: "CANDIDATE" },
        {
          source: "NATIVE_ISSUE_TYPE",
          key: "Incident",
          disposition: "HUMAN_ONLY",
        },
        {
          source: "TRUSTED_LABEL",
          key: "sensitive",
          disposition: "SUPERVISED",
        },
        {
          source: "LOCAL_FINDING",
          key: "LOCAL-PRODUCTION_PATH",
          disposition: "HUMAN_ONLY",
        },
      ],
      localFindingIds: ["LOCAL-PRODUCTION_PATH"],
    });
    expect(result).not.toHaveProperty("specVerdict");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
    expect(Object.isFrozen(result.localFindingIds)).toBe(true);
  });

  it("uses CANDIDATE with one explicit default reason when no policy signal matches", () => {
    expect(
      evaluatePolicyDisposition({
        policy: policy("default"),
        nativeIssueType: null,
        labels: [],
        changedPaths: [],
      }),
    ).toEqual({
      disposition: "CANDIDATE",
      reasons: [
        { source: "DEFAULT", key: "default", disposition: "CANDIDATE" },
      ],
      localFindingIds: [],
    });
  });

  it("handles non-null native types and labels when delegation mappings are absent", () => {
    expect(
      evaluatePolicyDisposition({
        policy: policy("no-delegation"),
        nativeIssueType: "Bug",
        labels: ["safe"],
        changedPaths: [],
      }),
    ).toEqual({
      disposition: "CANDIDATE",
      reasons: [
        { source: "DEFAULT", key: "default", disposition: "CANDIDATE" },
      ],
      localFindingIds: [],
    });
  });

  it("matches label and native local findings with normalized keys", () => {
    const selectedPolicy = policy("local", {
      delegation: {
        default: "CANDIDATE",
        trustedLabelMappings: { Sensitive: "SUPERVISED" },
      },
      localFindings: [
        {
          id: "LOCAL-LABEL",
          messageKey: "label",
          match: { labelsAny: [" RELEASE "] },
          dispositionEffect: "HUMAN_ONLY",
        },
        {
          id: "LOCAL-NATIVE",
          messageKey: "native",
          match: { nativeTypesAny: [" Incident "] },
          dispositionEffect: "SUPERVISED",
        },
        {
          id: "LOCAL-MISS",
          messageKey: "miss",
          match: { pathPrefixesAny: ["infra/"] },
          dispositionEffect: "HUMAN_ONLY",
        },
      ],
    });
    const result = evaluatePolicyDisposition({
      policy: selectedPolicy,
      nativeIssueType: "INCIDENT",
      labels: ["sensitive", "release"],
      changedPaths: ["src/index.ts"],
    });

    expect(result.disposition).toBe("HUMAN_ONLY");
    expect(result.localFindingIds).toEqual(["LOCAL-LABEL", "LOCAL-NATIVE"]);
    expect(result.reasons.map((reason) => reason.source)).toEqual([
      "DEFAULT",
      "TRUSTED_LABEL",
      "LOCAL_FINDING",
      "LOCAL_FINDING",
    ]);
  });

  it("never lets a weaker later signal downgrade disposition", () => {
    const selectedPolicy = policy("priority", {
      delegation: {
        default: "HUMAN_ONLY",
        nativeTypeMappings: { Bug: "SUPERVISED" },
        trustedLabelMappings: { safe: "SUPERVISED" },
      },
      localFindings: [
        {
          id: "LOCAL-WEAK",
          messageKey: "weak",
          match: { pathPrefixesAny: ["src/"] },
          dispositionEffect: "SUPERVISED",
        },
      ],
    });
    const result = evaluatePolicyDisposition({
      policy: selectedPolicy,
      nativeIssueType: "bug",
      labels: ["safe"],
      changedPaths: ["src/index.ts"],
    });
    expect(result.disposition).toBe("HUMAN_ONLY");
    expect(result.reasons.map((reason) => reason.disposition)).toEqual([
      "HUMAN_ONLY",
      "SUPERVISED",
      "SUPERVISED",
      "SUPERVISED",
    ]);
  });

  it("uses any matching label, native type, or path and rejects near misses", () => {
    const selectedPolicy = policy("local-any", {
      localFindings: [
        {
          id: "LOCAL-LABEL-ANY",
          messageKey: "label-any",
          match: { labelsAny: ["missing", "release"] },
          dispositionEffect: "SUPERVISED",
        },
        {
          id: "LOCAL-LABEL-MISS",
          messageKey: "label-miss",
          match: { labelsAny: ["sensitive"] },
          dispositionEffect: "HUMAN_ONLY",
        },
        {
          id: "LOCAL-NATIVE-ANY",
          messageKey: "native-any",
          match: { nativeTypesAny: ["missing", "incident"] },
          dispositionEffect: "SUPERVISED",
        },
        {
          id: "LOCAL-NATIVE-MISS",
          messageKey: "native-miss",
          match: { nativeTypesAny: ["bug"] },
          dispositionEffect: "HUMAN_ONLY",
        },
        {
          id: "LOCAL-PATH-ANY",
          messageKey: "path-any",
          match: { pathPrefixesAny: ["missing/", "src/"] },
          dispositionEffect: "HUMAN_ONLY",
        },
        {
          id: "LOCAL-PATH-MISS",
          messageKey: "path-miss",
          match: { pathPrefixesAny: ["infra/"] },
          dispositionEffect: "HUMAN_ONLY",
        },
      ],
    });
    const result = evaluatePolicyDisposition({
      policy: selectedPolicy,
      nativeIssueType: "INCIDENT",
      labels: ["release"],
      changedPaths: ["tests/no-match.ts", "src/index.ts"],
    });
    expect(result.localFindingIds).toEqual([
      "LOCAL-LABEL-ANY",
      "LOCAL-NATIVE-ANY",
      "LOCAL-PATH-ANY",
    ]);
    expect(result.disposition).toBe("HUMAN_ONLY");
  });

  it("keeps every optional local-finding matcher false when its field is absent", () => {
    const selectedPolicy = policy("local-absent", {
      localFindings: [
        {
          id: "LOCAL-LABEL",
          messageKey: "label",
          match: { labelsAny: ["release"] },
          dispositionEffect: "HUMAN_ONLY",
        },
        {
          id: "LOCAL-EMPTY-NATIVE",
          messageKey: "empty-native",
          match: { nativeTypesAny: [""] },
          dispositionEffect: "HUMAN_ONLY",
        },
      ],
    });
    expect(
      evaluatePolicyDisposition({
        policy: selectedPolicy,
        nativeIssueType: null,
        labels: [],
        changedPaths: [],
      }).localFindingIds,
    ).toEqual([]);
  });

  it("is metamorphically invariant to author association", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (left, right) => {
        const base = {
          policy: delegationPolicy,
          nativeIssueType: null,
          labels: ["bug", "sensitive"],
          changedPaths: ["src/index.ts"],
        } as const;
        expect(
          selectTaskType({
            ...selectionInput(delegationPolicy),
            labels: base.labels,
            accessContext: { authorAssociation: left },
          }),
        ).toEqual(
          selectTaskType({
            ...selectionInput(delegationPolicy),
            labels: base.labels,
            accessContext: { authorAssociation: right },
          }),
        );
        expect(
          evaluatePolicyDisposition({
            ...base,
            accessContext: { authorAssociation: left },
          }),
        ).toEqual(
          evaluatePolicyDisposition({
            ...base,
            accessContext: { authorAssociation: right },
          }),
        );
      }),
      { numRuns: 200 },
    );
  });
});
