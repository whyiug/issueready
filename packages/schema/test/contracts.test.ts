import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compileSchema } from "../src/index.js";

function loadJson(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8"),
  );
}

describe("versioned schema contracts", () => {
  it("accepts the bounded GitHub native relationship catalog", () => {
    const validate = compileSchema(
      loadJson(
        "schemas/v1alpha1/github-native-relationship-fixture.schema.json",
      ) as object,
    );
    expect(
      validate(loadJson("fixtures/github/native-relationships.v1alpha1.json")),
    ).toEqual({ valid: true, issues: [] });
  });

  it("accepts the bounded GitHub read replay catalog", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/github-read-replay.schema.json") as object,
    );
    expect(
      validate(loadJson("fixtures/github/read-replay.v1alpha1.json")),
    ).toEqual({ valid: true, issues: [] });
  });

  it("accepts the rights-explicit curated Issue behavior catalog", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/curated-issue-fixture.schema.json") as object,
      [
        loadJson("schemas/v1alpha1/snapshot.schema.json") as object,
        loadJson("schemas/v1alpha1/normalization.schema.json") as object,
      ],
    );
    expect(
      validate(loadJson("fixtures/issues/curated-semantic.v1alpha1.json")),
    ).toEqual({ valid: true, issues: [] });
  });

  it("accepts a complete tri-axis report", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/report.schema.json") as object,
    );
    expect(validate(loadJson("fixtures/reports/valid-complete.json"))).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("rejects ERROR paired with a READY verdict", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/report.schema.json") as object,
    );
    const result = validate(
      loadJson("fixtures/reports/invalid-error-with-ready.json"),
    );
    expect(result.valid).toBe(false);
  });

  it("accepts additive unknown report fields for minor-version compatibility", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/report.schema.json") as object,
    );
    expect(
      validate(loadJson("fixtures/reports/valid-additive-field.json")),
    ).toEqual({ valid: true, issues: [] });
  });

  it("rejects unknown report enums as an explicit compatibility error", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/report.schema.json") as object,
    );
    const result = validate(
      loadJson("fixtures/reports/invalid-unknown-enum.json"),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.keyword === "enum")).toBe(
        true,
      );
    }
  });

  it("accepts the default policy candidate", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/policy.schema.json") as object,
    );
    expect(validate(loadJson("fixtures/policies/default.json"))).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("accepts registered mappings and delegation-only local policy", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/policy.schema.json") as object,
    );
    expect(validate(loadJson("fixtures/policies/valid-mapped.json"))).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("rejects repository attempts to override canonical rules", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/policy.schema.json") as object,
    );
    const result = validate(
      loadJson("fixtures/policies/invalid-canonical-override.json"),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.issues.some((issue) => issue.keyword === "additionalProperties"),
      ).toBe(true);
    }
  });

  it("rejects canonical overrides hidden inside task-type mappings", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/policy.schema.json") as object,
    );
    const result = validate(
      loadJson("fixtures/policies/invalid-nested-canonical-override.json"),
    );
    expect(result.valid).toBe(false);
  });

  it("rejects legacy canonical knobs, inline semantic profiles, unknown profiles, and writes", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/policy.schema.json") as object,
    );
    for (const fixture of [
      "invalid-legacy-canonical-knobs.json",
      "invalid-inline-semantic-profile.json",
      "invalid-unknown-profile.json",
      "invalid-write-enabled.json",
    ]) {
      expect(
        validate(loadJson(`fixtures/policies/${fixture}`)).valid,
        fixture,
      ).toBe(false);
    }
  });

  it("accepts bounded native capability data in a digest-bound snapshot", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/snapshot.schema.json") as object,
      [loadJson("schemas/v1alpha1/normalization.schema.json") as object],
    );
    expect(
      validate(loadJson("fixtures/snapshots/valid-native-capabilities.json")),
    ).toEqual({ valid: true, issues: [] });
  });

  it("rejects a native availability/reason combination that is not coherent", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/snapshot.schema.json") as object,
      [loadJson("schemas/v1alpha1/normalization.schema.json") as object],
    );
    const snapshot = structuredClone(
      loadJson("fixtures/snapshots/valid-native-capabilities.json"),
    ) as {
      native: {
        capabilities: {
          fields: { availability: string; reason: string | null };
        };
      };
    };
    snapshot.native.capabilities.fields.availability = "AVAILABLE";
    snapshot.native.capabilities.fields.reason = "TRANSIENT_ERROR";
    expect(validate(snapshot).valid).toBe(false);
  });

  it("rejects unknown snapshot source kinds as a compatibility error", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/snapshot.schema.json") as object,
      [loadJson("schemas/v1alpha1/normalization.schema.json") as object],
    );
    const result = validate(
      loadJson("fixtures/snapshots/invalid-unknown-source-kind.json"),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.issues.some(
          (issue) => issue.keyword === "const" || issue.keyword === "oneOf",
        ),
      ).toBe(true);
    }
  });

  it("accepts the initial rule manifest", () => {
    const validate = compileSchema(
      loadJson("schemas/v1alpha1/rule-manifest.schema.json") as object,
    );
    expect(
      validate(loadJson("rules/catalog/v1alpha1/IR-ACC-001.json")),
    ).toEqual({ valid: true, issues: [] });
  });
});
