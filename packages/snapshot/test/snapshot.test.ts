import { readFileSync } from "node:fs";

import fc from "fast-check";
import type {
  IssueReadyPolicyV1Alpha1,
  IssueSnapshotV1Alpha1,
} from "@issueready/schema";
import { compileSchema } from "@issueready/schema";
import { describe, expect, it } from "vitest";

import {
  buildSnapshot,
  calculateSnapshotDigest,
  prepareEvaluation,
  verifyNativeSnapshotEnvelope,
  verifySnapshot,
} from "../src/index.js";

const POLICY_DIGEST = `sha256:${"b".repeat(64)}` as const;

function loadJson(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8"),
  );
}

function native(
  issueType: string | null = null,
): IssueSnapshotV1Alpha1["native"] {
  const unavailable = () => ({
    availability: "UNAVAILABLE" as const,
    checkedBy: "LOCAL_SOURCE" as const,
    reason: "SOURCE_NOT_APPLICABLE" as const,
  });
  return {
    issueType: issueType === null ? null : { id: "type-1", name: issueType },
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
      references: unavailable(),
    },
    references: [],
  };
}

function mappedPolicy(): IssueReadyPolicyV1Alpha1 {
  return loadJson(
    "fixtures/policies/valid-mapped.json",
  ) as IssueReadyPolicyV1Alpha1;
}

describe("immutable normalized snapshots", () => {
  it("rejects incoherent availability reasons, duplicates, and unbounded native collections", () => {
    const valid = native();
    expect(verifyNativeSnapshotEnvelope(valid)).toBe(true);

    const incoherent = structuredClone(valid);
    incoherent.capabilities.issueTypes = {
      availability: "AVAILABLE",
      checkedBy: "GITHUB_GRAPHQL",
      reason: "TRANSIENT_ERROR",
    } as never;
    expect(verifyNativeSnapshotEnvelope(incoherent)).toBe(false);
    expect(() =>
      buildSnapshot({
        source: { kind: "local", path: "issue.md", updatedAt: null },
        title: "Invalid native envelope",
        body: "Body",
        labels: [],
        comments: [],
        native: incoherent,
        evaluatedAt: "2026-07-18T00:00:00Z",
        truncated: false,
        omittedBytes: 0,
      }),
    ).toThrow(/native snapshot envelope/u);

    const duplicate = structuredClone(valid);
    duplicate.references = [
      {
        target: "#42",
        kind: "ISSUE",
        essential: true,
        availability: "AVAILABLE",
        checkedBy: "GITHUB_REST",
        reason: null,
      },
      {
        target: "#42",
        kind: "ISSUE",
        essential: false,
        availability: "AVAILABLE",
        checkedBy: "GITHUB_REST",
        reason: null,
      },
    ];
    expect(verifyNativeSnapshotEnvelope(duplicate)).toBe(false);

    const unbounded = structuredClone(valid);
    unbounded.fields = Array.from({ length: 101 }, (_, id) => ({ id }));
    expect(verifyNativeSnapshotEnvelope(unbounded)).toBe(false);
  });

  it("verifies the committed native capability fixture and binds native data", () => {
    const snapshot = loadJson(
      "fixtures/snapshots/valid-native-capabilities.json",
    ) as IssueSnapshotV1Alpha1;
    expect(verifySnapshot(snapshot)).toBe(true);

    const nativeChanged = structuredClone(snapshot);
    nativeChanged.native.fields[0] = {
      ...nativeChanged.native.fields[0],
      value: "critical",
    };
    expect(verifySnapshot(nativeChanged)).toBe(false);

    const accessChanged = structuredClone(snapshot);
    if (accessChanged.accessContext !== undefined) {
      accessChanged.accessContext.authorAssociation = "NONE";
    }
    expect(verifySnapshot(accessChanged)).toBe(true);
  });

  it("builds a local Markdown snapshot that validates with an offline schema registry", () => {
    const snapshot = buildSnapshot({
      source: {
        kind: "local",
        path: "fixtures/issues/emoji.md",
        updatedAt: null,
      },
      title: "Render 😀 correctly",
      body: "## Acceptance\n\n- [ ] Render 😀 on Windows\n",
      labels: ["bug", "bug"],
      comments: [],
      native: native(),
      evaluatedAt: "2026-07-18T00:00:00Z",
      truncated: false,
      omittedBytes: 0,
    });
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/snapshot.schema.json") as object,
      [loadJson("schemas/v1alpha1/normalization.schema.json") as object],
    );

    expect(validate(snapshot)).toEqual({ valid: true, issues: [] });
    expect(verifySnapshot(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.content.normalization.headings)).toBe(true);
    expect(snapshot.content.labels).toEqual(["bug"]);
  });

  it("keeps the source digest stable across evaluation time and access identity", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (left, right) => {
        const common = {
          source: {
            kind: "github" as const,
            owner: "community",
            repository: "project",
            number: 42,
            updatedAt: "2026-07-18T00:00:00Z",
            apiVersion: "2022-11-28",
            etag: null,
          },
          title: "Document the API",
          body: "## Acceptance\n\nThe public API is documented.\n",
          labels: ["documentation"],
          comments: [],
          native: native("Documentation"),
          truncated: false,
          omittedBytes: 0,
        };
        const first = buildSnapshot({
          ...common,
          evaluatedAt: "2026-07-18T00:00:00Z",
          accessContext: { authorAssociation: left },
        });
        const second = buildSnapshot({
          ...common,
          evaluatedAt: "2026-07-19T00:00:00Z",
          accessContext: { authorAssociation: right },
        });
        expect(first.integrity.snapshotDigest).toBe(
          second.integrity.snapshotDigest,
        );
        expect(calculateSnapshotDigest(first)).toBe(
          calculateSnapshotDigest(second),
        );
        expect(
          prepareEvaluation({
            snapshot: first,
            policy: mappedPolicy(),
            policyDigest: POLICY_DIGEST,
            explicitTaskType: null,
            issueFormTemplatePath: null,
            deterministicHint: "docs",
            semanticHint: null,
          }).taskType,
        ).toEqual(
          prepareEvaluation({
            snapshot: second,
            policy: mappedPolicy(),
            policyDigest: POLICY_DIGEST,
            explicitTaskType: null,
            issueFormTemplatePath: null,
            deterministicHint: "docs",
            semanticHint: null,
          }).taskType,
        );
      }),
      { numRuns: 100 },
    );
  });

  it("rejects body/normalization or digest tampering", () => {
    const snapshot = buildSnapshot({
      source: { kind: "local", path: "issue.md", updatedAt: null },
      title: "Task",
      body: "Original body",
      labels: [],
      comments: [],
      native: native(),
      evaluatedAt: "2026-07-18T00:00:00Z",
      truncated: false,
      omittedBytes: 0,
    });
    const changed = structuredClone(snapshot) as IssueSnapshotV1Alpha1;
    changed.content.body = "Changed body";
    expect(verifySnapshot(changed)).toBe(false);
    expect(() =>
      prepareEvaluation({
        snapshot: changed,
        policy: mappedPolicy(),
        policyDigest: POLICY_DIGEST,
        explicitTaskType: null,
        issueFormTemplatePath: null,
        deterministicHint: null,
        semanticHint: null,
      }),
    ).toThrow(/invalid snapshot/u);
  });

  it("projects mapped native task type with source and policy digests", () => {
    const snapshot = buildSnapshot({
      source: {
        kind: "github",
        owner: "community",
        repository: "project",
        number: 7,
        updatedAt: "2026-07-18T00:00:00Z",
        apiVersion: "2022-11-28",
        etag: null,
      },
      title: "Production incident follow-up",
      body: "Define the follow-up task.",
      labels: ["sensitive"],
      comments: [],
      native: native("Incident"),
      evaluatedAt: "2026-07-18T00:00:00Z",
      truncated: false,
      omittedBytes: 0,
    });
    expect(
      prepareEvaluation({
        snapshot,
        policy: mappedPolicy(),
        policyDigest: POLICY_DIGEST,
        explicitTaskType: "feature",
        issueFormTemplatePath: null,
        deterministicHint: null,
        semanticHint: null,
      }),
    ).toMatchObject({
      snapshotDigest: snapshot.integrity.snapshotDigest,
      policyDigest: POLICY_DIGEST,
      taskType: { taskType: "operations", source: "NATIVE_ISSUE_TYPE" },
    });
  });
});
