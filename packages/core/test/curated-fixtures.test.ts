import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { EvidenceSpan, Sha256Digest } from "@issueready/domain";
import type { RuleSignal } from "@issueready/rules";
import type {
  CuratedIssueFixtureCatalogV1Alpha1,
  IssueReadyPolicyV1Alpha1,
  LocaleBundleV1Alpha1,
  RuleManifestV1Alpha1,
  TaskPackManifestV1Alpha1,
} from "@issueready/schema";
import { compileSchema } from "@issueready/schema";
import { describe, expect, it } from "vitest";

import { evaluateIssue, loadPolicy, normalizeIssue } from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function loadJson<Value>(relativePath: string): Value {
  return JSON.parse(
    readFileSync(join(repositoryRoot, relativePath), "utf8"),
  ) as Value;
}

function loadDirectory<Value>(relativeDirectory: string): readonly Value[] {
  const directory = join(repositoryRoot, relativeDirectory);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => loadJson<Value>(join(relativeDirectory, name)));
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
      throw new TypeError("Non-finite fixture value");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  throw new TypeError("Fixture value must be JSON-compatible");
}

function digest(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

type Fixture = CuratedIssueFixtureCatalogV1Alpha1["fixtures"][number];
type EvidenceBinding = Fixture["semanticSignals"][number]["evidence"][number];

function bindEvidence(
  fixture: Fixture,
  binding: EvidenceBinding,
  snapshotDigest: Sha256Digest,
  body: string,
): EvidenceSpan {
  const source =
    binding.document === "issue.title" ? fixture.input.title : body;
  const startUtf16 = source.indexOf(binding.quote);
  expect(startUtf16, `${fixture.id}:${binding.quote}`).toBeGreaterThanOrEqual(
    0,
  );
  expect(
    source.indexOf(binding.quote, startUtf16 + binding.quote.length),
    `${fixture.id}:${binding.quote}:ambiguous`,
  ).toBe(-1);
  const endUtf16 = startUtf16 + binding.quote.length;
  return {
    document: binding.document,
    startUtf16,
    endUtf16,
    lineStart: lineAt(source, startUtf16),
    lineEnd: lineAt(source, Math.max(startUtf16, endUtf16 - 1)),
    quote: binding.quote,
    snapshotDigest,
  };
}

const catalog = loadJson<CuratedIssueFixtureCatalogV1Alpha1>(
  "fixtures/issues/curated-semantic.v1alpha1.json",
);
const rules = loadDirectory<RuleManifestV1Alpha1>("rules/catalog/v1alpha1");
const taskPacks = loadDirectory<TaskPackManifestV1Alpha1>(
  "rules/task-packs/v1alpha1",
);
const localeBundle = loadJson<LocaleBundleV1Alpha1>("locales/en/v1alpha1.json");
const policies = {
  default: loadJson<IssueReadyPolicyV1Alpha1>("fixtures/policies/default.json"),
  mapped: loadJson<IssueReadyPolicyV1Alpha1>(
    "fixtures/policies/valid-mapped.json",
  ),
} as const;

function evaluateFixture(
  fixture: Fixture,
  body = fixture.input.body,
  authorAssociation = "OWNER",
) {
  const nativeReferences = fixture.input.nativeReferences;
  const githubBacked = nativeReferences !== undefined;
  const unavailable = () => ({
    availability: "UNAVAILABLE" as const,
    checkedBy: githubBacked
      ? ("GITHUB_GRAPHQL" as const)
      : ("LOCAL_SOURCE" as const),
    reason: githubBacked
      ? ("API_UNSUPPORTED" as const)
      : ("SOURCE_NOT_APPLICABLE" as const),
  });
  const unknownReference = nativeReferences?.find(
    (reference) => reference.availability === "UNKNOWN",
  );
  const referencesCapability =
    nativeReferences === undefined
      ? unavailable()
      : unknownReference === undefined
        ? {
            availability: "AVAILABLE" as const,
            checkedBy: "GITHUB_REST" as const,
            reason: null,
          }
        : {
            availability: "UNKNOWN" as const,
            checkedBy: unknownReference.checkedBy,
            reason: unknownReference.reason,
          };
  const native = {
    issueType:
      fixture.input.nativeIssueType === null
        ? null
        : {
            id: `fixture-${fixture.id}`,
            name: fixture.input.nativeIssueType,
            state: "AVAILABLE",
          },
    fields: [],
    parent: null,
    subIssues: [],
    blockedBy: [],
    blocking: [],
    capabilities: {
      issueTypes: unavailable(),
      fields: unavailable(),
      parent: unavailable(),
      subIssues: unavailable(),
      dependencies: unavailable(),
      references: referencesCapability,
    },
    references: structuredClone(nativeReferences ?? []),
  };
  const snapshot = normalizeIssue(
    {
      source: githubBacked
        ? {
            kind: "github",
            owner: "synthetic-community",
            repository: "curated-fixtures",
            number:
              catalog.fixtures.findIndex(
                (candidate) => candidate.id === fixture.id,
              ) + 1,
            updatedAt: "2026-07-18T19:00:00Z",
            apiVersion: "2022-11-28",
            etag: null,
          }
        : {
            kind: "local",
            path: `fixtures/issues/${fixture.id}.md`,
            updatedAt: null,
          },
      title: fixture.input.title,
      body,
      labels: fixture.input.labels,
      native,
      accessContext: { authorAssociation },
    },
    { evaluatedAt: "2026-07-18T19:00:00Z" },
  );
  const semanticRuleSignals: RuleSignal[] = fixture.semanticSignals.map(
    (semanticSignal) => ({
      ruleId: semanticSignal.ruleId,
      source: semanticSignal.source,
      outcome: semanticSignal.outcome,
      evidence: semanticSignal.evidence.map((binding) =>
        bindEvidence(
          fixture,
          binding,
          snapshot.integrity.snapshotDigest as Sha256Digest,
          body,
        ),
      ),
    }),
  );
  const issueFormTemplatePath = fixture.input.issueFormTemplatePath;
  return evaluateIssue(
    snapshot,
    loadPolicy([
      {
        source: "BUILT_IN",
        policy: policies[fixture.policyFixture],
      },
    ]),
    {
      assets: { rules, taskPacks, localeBundle },
      coreVersion: "0.0.0",
      agentCapabilityProfile: "generic-coding-agent-v1",
      supervisionProfile: "maintainer-review-v1",
      generatedAt: "2026-07-18T19:00:00Z",
      ...(issueFormTemplatePath === undefined
        ? { explicitTaskType: fixture.taskType }
        : { issueFormTemplatePath }),
      changedPaths: fixture.input.changedPaths,
      includeEvidenceQuotes: true,
      adapters: {
        semanticRuleSignals,
        semanticProfileDigest: catalog.semanticProfile.digest as Sha256Digest,
      },
    },
  );
}

describe("rights-explicit curated Issue behavior fixtures", () => {
  it("is schema-valid, digest-bound, non-calibration, and complete by task pack", () => {
    const validate = compileSchema(
      loadJson<object>("schemas/v1alpha1/curated-issue-fixture.schema.json"),
      [
        loadJson<object>("schemas/v1alpha1/snapshot.schema.json"),
        loadJson<object>("schemas/v1alpha1/normalization.schema.json"),
      ],
    );
    expect(validate(catalog)).toEqual({ valid: true, issues: [] });
    expect(catalog.limitations).toEqual({
      accuracyClaim: false,
      calibrationUse: false,
      heldOut: false,
    });
    expect(catalog.rights).toMatchObject({
      rightsBasis: "project-authored-synthetic",
      rawTextIncluded: true,
      annotationLicense: "project-license-pending",
    });
    expect(catalog.semanticProfile.digest).toBe(
      digest({
        id: catalog.semanticProfile.id,
        revision: catalog.semanticProfile.revision,
      }),
    );
    expect(new Set(catalog.fixtures.map((fixture) => fixture.id)).size).toBe(
      catalog.fixtures.length,
    );
    expect(
      [...new Set(catalog.fixtures.map((fixture) => fixture.taskType))].sort(),
    ).toEqual(
      [
        "bug",
        "dependency",
        "docs",
        "feature",
        "generic",
        "operations",
        "refactor",
        "test-ci",
      ].sort(),
    );

    const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
    for (const fixture of catalog.fixtures) {
      expect(fixture.provenance.sourceDigest, fixture.id).toBe(
        digest(fixture.input),
      );
      expect(fixture.provenance.transformDigest, fixture.id).toBe(
        digest({
          taskType: fixture.taskType,
          policyFixture: fixture.policyFixture,
          semanticSignals: fixture.semanticSignals,
          expected: fixture.expected,
          review: fixture.review,
        }),
      );
      const pack = taskPacks.find(
        (candidate) => candidate.id === fixture.taskType,
      );
      expect(pack, fixture.id).toBeDefined();
      if (pack === undefined) continue;
      const assigned = [
        ...pack.criteria.mandatory,
        ...pack.criteria.conditional,
        ...pack.criteria.advisory,
      ];
      const expectedSemantic = assigned.filter((ruleId) =>
        rulesById
          .get(ruleId)
          ?.evidenceSources.some((source) =>
            source.startsWith("semantic-criterion:"),
          ),
      );
      expect(
        fixture.semanticSignals.map((signal) => signal.ruleId).sort(),
        fixture.id,
      ).toEqual([...expectedSemantic].sort());
      expect(
        new Set(fixture.semanticSignals.map((signal) => signal.ruleId)).size,
        fixture.id,
      ).toBe(fixture.semanticSignals.length);
      for (const signal of fixture.semanticSignals) {
        expect(
          rulesById.get(signal.ruleId)?.evidenceSources,
          `${fixture.id}:${signal.ruleId}`,
        ).toContain(signal.source);
        if (signal.outcome === "NOT_APPLICABLE") {
          expect(signal.evidence, `${fixture.id}:${signal.ruleId}`).toEqual([]);
        } else {
          expect(
            signal.evidence.length,
            `${fixture.id}:${signal.ruleId}`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it.each(catalog.fixtures)(
    "evaluates $id through the public core",
    (fixture) => {
      const report = evaluateFixture(fixture);
      expect(report).toMatchObject({
        evaluationStatus: fixture.expected.evaluationStatus,
        specVerdict: fixture.expected.specVerdict,
        delegationDisposition: fixture.expected.delegationDisposition,
        taskType: { id: fixture.taskType },
        evaluationReasons: fixture.expected.evaluationReasons,
        privacy: { quotesIncluded: true, redacted: true },
      });
      const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
      const blocking = report.canonicalFindings
        .filter(
          (finding) =>
            finding.outcome === "FAIL" &&
            rulesById.get(finding.ruleId)?.onFail.specEffect !== "NONE",
        )
        .map((finding) => finding.ruleId)
        .sort();
      expect(blocking).toEqual([...fixture.expected.blockingRuleIds].sort());
      if (fixture.expected.providerCalls !== undefined) {
        expect(report.usage.providerCalls).toBe(fixture.expected.providerCalls);
      }
      for (const fragment of fixture.expected.forbiddenReportFragments ?? []) {
        expect(
          JSON.stringify(report),
          `${fixture.id}:${fragment}`,
        ).not.toContain(fragment);
      }
      for (const signal of fixture.semanticSignals) {
        if (signal.evidence.length === 0) continue;
        const finding = report.canonicalFindings.find(
          (candidate) => candidate.ruleId === signal.ruleId,
        );
        expect(finding, `${fixture.id}:${signal.ruleId}`).toBeDefined();
        for (const binding of signal.evidence) {
          expect(
            finding?.evidence.some((span) => span.quote === binding.quote),
            `${fixture.id}:${signal.ruleId}:${binding.quote}`,
          ).toBe(true);
        }
      }
    },
  );

  it("does not infer independent goals from headings without separate acceptance", () => {
    const fixture = catalog.fixtures.find(
      (candidate) => candidate.id === "curated-test-ci-independent-goals",
    );
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const body = fixture.input.body.replaceAll(
      "### Acceptance criteria",
      "### Implementation notes",
    );
    const report = evaluateFixture(fixture, body);
    expect(report).toMatchObject({
      evaluationStatus: "COMPLETE",
      specVerdict: "READY",
      delegationDisposition: "CANDIDATE",
    });
  });

  it("keeps canonical axes invariant when only author association changes", () => {
    for (const fixture of catalog.fixtures) {
      const owner = evaluateFixture(fixture, fixture.input.body, "OWNER");
      const external = evaluateFixture(fixture, fixture.input.body, "NONE");
      expect(
        {
          evaluationId: external.evaluationId,
          evaluationStatus: external.evaluationStatus,
          specVerdict: external.specVerdict,
          delegationDisposition: external.delegationDisposition,
        },
        fixture.id,
      ).toEqual({
        evaluationId: owner.evaluationId,
        evaluationStatus: owner.evaluationStatus,
        specVerdict: owner.specVerdict,
        delegationDisposition: owner.delegationDisposition,
      });
    }
  });

  it("selects the rendered Issue Form fixture without provider or write authority", () => {
    const fixture = catalog.fixtures.find(
      (candidate) => candidate.id === "curated-feature-form-prompt-injection",
    );
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const report = evaluateFixture(fixture);
    expect(report).toMatchObject({
      taskType: { id: "feature", source: "ISSUE_FORM" },
      usage: { providerCalls: 0 },
      specVerdict: "READY",
      delegationDisposition: "CANDIDATE",
    });
    expect(report.policyFindings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: "FAIL" })]),
    );
  });
});
