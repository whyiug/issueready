import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { PolicyDisposition, TaskTypeSelection } from "@issueready/policy";
import { executeDeterministicSnapshot } from "@issueready/rules";
import type {
  IssueReadyReportV1Alpha1,
  LocaleBundleV1Alpha1,
  RuleManifestV1Alpha1,
  TaskPackManifestV1Alpha1,
} from "@issueready/schema";
import { compileSchema } from "@issueready/schema";
import { buildSnapshot } from "@issueready/snapshot";
import { createFixtureLoader } from "@issueready/testkit";
import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";

import {
  buildReport,
  calculateReportProjectionDigest,
  renderDeterministicReportProjection,
  renderReport,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = createFixtureLoader(repositoryRoot);
const POLICY_DIGEST = `sha256:${"b".repeat(64)}` as const;
const ENGINE_LOCK = {
  coreVersion: "0.0.0",
  ruleCatalogDigest: `sha256:${"a".repeat(64)}` as const,
  taskPackDigest: `sha256:${"c".repeat(64)}` as const,
  localeBundleDigest: `sha256:${"d".repeat(64)}` as const,
  semanticProfileDigest: null,
};
const SECRET_CANARY =
  `${["ARK", "API", "KEY"].join("_")}=` + "ark_secret_canary_123456789";

interface MarkdownNode {
  readonly type: string;
  readonly children?: readonly MarkdownNode[];
}

function markdownNodeTypes(source: string): readonly string[] {
  const types: string[] = [];
  const visit = (node: MarkdownNode): void => {
    types.push(node.type);
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(source) as MarkdownNode);
  return types;
}

function loadDirectory<Value>(relativeDirectory: string): readonly Value[] {
  return fixtures
    .jsonDirectory<Value>(relativeDirectory)
    .map(({ value }) => value);
}

function loadJson<Value = object>(relativePath: string): Value {
  return fixtures.json<Value>(relativePath);
}

const rules = loadDirectory<RuleManifestV1Alpha1>("rules/catalog/v1alpha1");
const taskPacks = loadDirectory<TaskPackManifestV1Alpha1>(
  "rules/task-packs/v1alpha1",
);
const localeBundle = loadJson<LocaleBundleV1Alpha1>("locales/en/v1alpha1.json");

function canonicalJson(value: unknown): string {
  if (value === null || ["boolean", "string"].includes(typeof value)) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  throw new TypeError("Fixture must be JSON-compatible");
}

function localeDigest(bundle: LocaleBundleV1Alpha1) {
  return `sha256:${createHash("sha256").update(canonicalJson(bundle)).digest("hex")}` as const;
}

function issue(options: { readonly truncated?: boolean } = {}) {
  return buildSnapshot({
    source: {
      kind: "local",
      path: "fixtures/issues/report.md",
      updatedAt: null,
    },
    title: "Produce a stable report",
    body: [
      "## Acceptance criteria",
      "",
      "The JSON output remains stable.",
      "",
      "## Validation",
      "",
      `Run pnpm test with ${SECRET_CANARY}.`,
    ].join("\n"),
    labels: [],
    comments: [],
    native: {
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
    },
    evaluatedAt: "2026-07-18T00:00:00Z",
    truncated: options.truncated ?? false,
    omittedBytes: options.truncated === true ? 128 : 0,
  });
}

function taskType(taskType: "generic" | "bug" = "generic"): TaskTypeSelection {
  return {
    taskType,
    source: "FALLBACK",
    attempts: [
      {
        source: "FALLBACK",
        status: "MATCHED",
        taskType,
        evidence: [],
      },
    ],
  };
}

function policyDisposition(): PolicyDisposition {
  return {
    disposition: "CANDIDATE",
    reasons: [{ source: "DEFAULT", key: "default", disposition: "CANDIDATE" }],
    localFindingIds: [],
  };
}

function inputs(snapshot = issue()) {
  const selectedTaskType = taskType();
  return {
    snapshot,
    policyDigest: POLICY_DIGEST,
    taskType: selectedTaskType,
    execution: executeDeterministicSnapshot({
      snapshot,
      taskType: selectedTaskType.taskType,
      rules,
      taskPacks,
      policyDisposition: policyDisposition(),
    }),
    engineLock: ENGINE_LOCK,
    agentCapabilityProfile: "generic-coding-agent-v1",
    supervisionProfile: "maintainer-review-v1",
    generatedAt: "2026-07-18T00:00:00Z",
  } as const;
}

function renderableInputs(
  bundle: LocaleBundleV1Alpha1 = localeBundle,
  includeEvidenceQuotes = false,
) {
  return {
    ...inputs(),
    engineLock: {
      ...ENGINE_LOCK,
      localeBundleDigest: localeDigest(bundle),
    },
    includeEvidenceQuotes,
  } as const;
}

describe("versioned report projection", () => {
  it("builds a schema-valid immutable report without raw issue text by default", () => {
    const report = buildReport(inputs());
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/report.schema.json"),
    );

    expect(validate(report)).toEqual({ valid: true, issues: [] });
    expect(report.evaluationId).toMatch(/^ir_[a-f0-9]{64}$/u);
    expect(report.evaluationStatus).toBe("DEGRADED");
    expect(report.specVerdict).toBeNull();
    expect(report.evaluationReasons).toEqual(["IR-SEM-000"]);
    expect(
      report.canonicalFindings.some(
        (finding) => finding.ruleId === "IR-INP-001",
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain(SECRET_CANARY);
    expect(report.privacy).toEqual({ quotesIncluded: false, redacted: true });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.canonicalFindings)).toBe(true);
  });

  it("keeps evaluation identity stable across envelope time and quote display", () => {
    const baseline = buildReport(inputs());
    const displayed = buildReport({
      ...inputs(),
      generatedAt: "2026-07-19T00:00:00Z",
      includeEvidenceQuotes: true,
    });

    expect(displayed.evaluationId).toBe(baseline.evaluationId);
    expect(calculateReportProjectionDigest(displayed)).toBe(
      calculateReportProjectionDigest(baseline),
    );
    expect(displayed.privacy).toEqual({
      quotesIncluded: true,
      redacted: true,
    });
    expect(JSON.stringify(displayed)).not.toContain(SECRET_CANARY);
    expect(JSON.stringify(displayed)).toContain("[REDACTED_API_KEY]");
  });

  it("emits a schema-valid ERROR report for incomplete input without NEEDS_INFO", () => {
    const report = buildReport(inputs(issue({ truncated: true })));
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/report.schema.json"),
    );

    expect(validate(report)).toEqual({ valid: true, issues: [] });
    expect(report).toMatchObject({
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
      snapshot: { truncated: true, omittedBytes: 128 },
    });
    expect(
      report.canonicalFindings.find(
        (finding) => finding.ruleId === "IR-INP-001",
      ),
    ).toMatchObject({ outcome: "FAIL" });
  });

  it("rejects mismatched task selection and execution provenance", () => {
    expect(() =>
      buildReport({
        ...inputs(),
        taskType: taskType("bug"),
      }),
    ).toThrow(/do not match/u);
  });

  it("rejects findings whose evidence belongs to another snapshot", () => {
    const base = inputs();
    const changed = structuredClone(base.execution);
    const finding = changed.canonicalFindings.find(
      (candidate) => candidate.evidence.length > 0,
    );
    expect(finding).toBeDefined();
    const evidence = finding?.evidence[0];
    expect(evidence).toBeDefined();
    if (evidence !== undefined) {
      (evidence as { snapshotDigest: string }).snapshotDigest =
        `sha256:${"f".repeat(64)}`;
    }
    expect(() => buildReport({ ...base, execution: changed })).toThrow(
      /different snapshot/u,
    );
  });

  it("rejects a forged quote even when its digest claims the right snapshot", () => {
    const base = inputs();
    const changed = structuredClone(base.execution);
    const finding = changed.canonicalFindings.find(
      (candidate) => candidate.evidence.length > 0,
    );
    const evidence = finding?.evidence[0];
    expect(evidence).toBeDefined();
    if (evidence !== undefined) {
      (evidence as { quote?: string }).quote = "fabricated evidence";
    }
    expect(() => buildReport({ ...base, execution: changed })).toThrow(
      /does not round-trip/u,
    );
  });
});

describe("deterministic report renderers", () => {
  it("matches committed deterministic projection bytes without envelope fields", () => {
    const fixtureReport = loadJson<IssueReadyReportV1Alpha1>(
      "fixtures/reports/valid-complete.json",
    );
    const expected = fixtures.text(
      "fixtures/golden/report-projection.v1alpha1.golden",
    );
    const changedEnvelope = {
      ...fixtureReport,
      generatedAt: "2099-01-01T00:00:00Z",
      usage: { providerCalls: 999 },
      privacy: { quotesIncluded: true, redacted: true },
    };

    expect(renderDeterministicReportProjection(fixtureReport)).toBe(expected);
    expect(renderDeterministicReportProjection(changedEnvelope)).toBe(expected);
  });

  it("sorts JSON object keys recursively and terminates with one newline", () => {
    const report = buildReport(renderableInputs());
    const reordered = Object.fromEntries(
      Object.entries(report).reverse(),
    ) as unknown as IssueReadyReportV1Alpha1;

    const baseline = renderReport(report, "json");
    expect(renderReport(reordered, "json")).toBe(baseline);
    expect(baseline.endsWith("\n")).toBe(true);
    expect(baseline.endsWith("\n\n")).toBe(false);
    expect(JSON.parse(baseline)).toEqual(report);
    expect(renderReport(report, "json", { prettyJson: false })).not.toContain(
      "\n  ",
    );
    expect(() => renderReport(report, "yaml" as unknown as "json")).toThrow(
      /Unsupported report format/u,
    );
  });

  it("binds Markdown messages to the locale digest and requires canonical keys", () => {
    const report = buildReport(renderableInputs());
    expect(() => renderReport(report, "markdown")).toThrow(/localeBundle/u);
    expect(() =>
      renderReport(report, "markdown", {
        localeBundle: { ...localeBundle, revision: 2 },
      }),
    ).toThrow(/digest/u);

    const missing = structuredClone(localeBundle);
    delete missing.messages[report.canonicalFindings[0]?.messageKey ?? ""];
    const missingReport = buildReport(renderableInputs(missing));
    expect(() =>
      renderReport(missingReport, "markdown", { localeBundle: missing }),
    ).toThrow(/missing key/u);
  });

  it("escapes locale Markdown and HTML instead of creating executable markup", () => {
    const hostile = structuredClone(localeBundle);
    const messageKey = "rules.definition.concrete-object-action";
    hostile.messages[messageKey] =
      "<script>alert(1)</script> [open](javascript:alert(2)) | injected";
    const report = buildReport(renderableInputs(hostile));
    const markdown = renderReport(report, "markdown", {
      localeBundle: hostile,
    });

    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("[open](javascript:");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).toContain("\\[open\\]\\(javascript:alert\\(2\\)\\)");
    expect(markdown).toContain("\\| injected");
    expect(markdownNodeTypes(markdown)).not.toContain("html");
    expect(markdownNodeTypes(markdown)).not.toContain("link");
  });

  it("keeps quotes collapsed by default and renders only redacted quotes on opt-in", () => {
    const report = buildReport(renderableInputs(localeBundle, true));
    const collapsed = renderReport(report, "markdown", { localeBundle });
    const expanded = renderReport(report, "markdown", {
      localeBundle,
      includeEvidenceQuotes: true,
    });

    expect(collapsed).not.toContain("[REDACTED_API_KEY]");
    expect(expanded).toContain("\\[REDACTED\\_API\\_KEY\\]");
    expect(expanded).not.toContain(SECRET_CANARY);

    const unsafe = structuredClone(report);
    unsafe.privacy.redacted = false;
    expect(() =>
      renderReport(unsafe, "markdown", {
        localeBundle,
        includeEvidenceQuotes: true,
      }),
    ).toThrow(/Unredacted/u);
  });
});
