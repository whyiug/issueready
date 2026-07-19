import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { calculateReportProjectionDigest } from "@issueready/report";
import type { RuleSignal } from "@issueready/rules";
import type {
  IssueReadyPolicyV1Alpha1,
  IssueSnapshotV1Alpha1,
  LocaleBundleV1Alpha1,
  RuleManifestV1Alpha1,
  TaskPackManifestV1Alpha1,
} from "@issueready/schema";
import { compileSchema } from "@issueready/schema";
import { describe, expect, it } from "vitest";

import {
  evaluateIssue,
  loadPolicy,
  normalizeIssue,
  renderReport,
} from "../src/index.js";

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

const assets = {
  rules: loadDirectory<RuleManifestV1Alpha1>("rules/catalog/v1alpha1"),
  taskPacks: loadDirectory<TaskPackManifestV1Alpha1>(
    "rules/task-packs/v1alpha1",
  ),
  localeBundle: loadJson<LocaleBundleV1Alpha1>("locales/en/v1alpha1.json"),
};
const builtInPolicy = loadJson<IssueReadyPolicyV1Alpha1>(
  "fixtures/policies/default.json",
);

function policy() {
  return loadPolicy([{ source: "BUILT_IN", policy: builtInPolicy }]);
}

function snapshot(authorAssociation?: string) {
  return normalizeIssue(
    {
      source: {
        kind: "local",
        path: "fixtures/issues/core.md",
        updatedAt: null,
      },
      title: "Stabilize the public evaluation facade",
      body: [
        "## Acceptance criteria",
        "",
        "The same normalized input produces the same evaluation projection.",
        "",
        "## Validation",
        "",
        "Run `pnpm test` for packages/core/src/index.ts.",
      ].join("\n"),
      labels: ["documentation"],
      ...(authorAssociation === undefined
        ? {}
        : { accessContext: { authorAssociation } }),
    },
    { evaluatedAt: "2026-07-18T00:00:00Z" },
  );
}

function options(generatedAt = "2026-07-18T00:00:00Z") {
  return {
    assets,
    coreVersion: "0.0.0",
    agentCapabilityProfile: "generic-coding-agent-v1",
    supervisionProfile: "maintainer-review-v1",
    generatedAt,
  } as const;
}

describe("supported core facade", () => {
  it("loads policy deterministically without mutating source layers", () => {
    const before = structuredClone(builtInPolicy);
    const first = policy();
    const second = policy();

    expect(first.digest).toBe(second.digest);
    expect(first.policy).toEqual(before);
    expect(builtInPolicy).toEqual(before);
    expect(Object.isFrozen(first.policy)).toBe(true);
  });

  it("runs normalize→policy→evaluate→report through one schema-valid API", () => {
    const report = evaluateIssue(snapshot(), policy(), options());
    const validate = compileSchema(
      loadJson<object>("schemas/v1alpha1/report.schema.json"),
    );

    expect(validate(report)).toEqual({ valid: true, issues: [] });
    expect(report).toMatchObject({
      schemaVersion: "1.0.0-alpha.1",
      evaluationStatus: "DEGRADED",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      taskType: { id: "generic", source: "FALLBACK" },
      usage: { providerCalls: 0 },
    });
    expect(report.engineLock.ruleCatalogDigest).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(report.engineLock.taskPackDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(report.engineLock.localeBundleDigest).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(JSON.stringify(report)).not.toContain(
      "The same normalized input produces",
    );
    expect(
      renderReport(report, "markdown", {
        localeBundle: assets.localeBundle,
      }),
    ).toContain("# IssueReady report");
  });

  it("is metamorphically invariant to access identity and evaluation time", () => {
    const first = evaluateIssue(
      snapshot("OWNER"),
      policy(),
      options("2026-07-18T00:00:00Z"),
    );
    const second = evaluateIssue(
      snapshot("NONE"),
      policy(),
      options("2026-07-19T00:00:00Z"),
    );

    expect(first.snapshot.digest).toBe(second.snapshot.digest);
    expect(first.evaluationId).toBe(second.evaluationId);
    expect(calculateReportProjectionDigest(first)).toBe(
      calculateReportProjectionDigest(second),
    );
    expect(first.specVerdict).toBe(second.specVerdict);
    expect(first.delegationDisposition).toBe(second.delegationDisposition);
  });

  it("rejects locale assets that do not match the merged policy", () => {
    const mismatchedAssets = {
      ...assets,
      localeBundle: { ...assets.localeBundle, locale: "fr" },
    };
    expect(() =>
      evaluateIssue(snapshot(), policy(), {
        ...options(),
        assets: mismatchedAssets,
      }),
    ).toThrow(/does not match/u);
  });

  it("requires an immutable profile lock before accepting semantic signals", () => {
    const semanticSignal: RuleSignal = {
      ruleId: "IR-ACC-002",
      source: "semantic-criterion:goal-acceptance-alignment",
      outcome: "PASS",
    };
    expect(() =>
      evaluateIssue(snapshot(), policy(), {
        ...options(),
        adapters: { semanticRuleSignals: [semanticSignal] },
      }),
    ).toThrow(/semanticProfileDigest/u);
    const report = evaluateIssue(snapshot(), policy(), {
      ...options(),
      adapters: {
        semanticRuleSignals: [semanticSignal],
        semanticProfileDigest: `sha256:${"e".repeat(64)}` as const,
      },
    });
    expect(report.engineLock.semanticProfileDigest).toBe(
      `sha256:${"e".repeat(64)}`,
    );
  });

  it("rejects public adapter attempts to inject deterministic hard facts", () => {
    expect(() =>
      evaluateIssue(snapshot(), policy(), {
        ...options(),
        adapters: {
          semanticRuleSignals: [
            {
              ruleId: "IR-ACC-001",
              source: "issue-form-field:acceptance",
              outcome: "FAIL",
              hardPredicateProven: true,
            },
          ],
          semanticProfileDigest: `sha256:${"e".repeat(64)}`,
        },
      }),
    ).toThrow(/cannot inject deterministic/u);
  });

  it("fails closed when normalized snapshot content is tampered", () => {
    const changed = structuredClone(snapshot()) as IssueSnapshotV1Alpha1;
    changed.content.body = "tampered";
    const report = evaluateIssue(changed, policy(), options());
    expect(report).toMatchObject({
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
    });
  });
});
