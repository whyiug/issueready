import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  RuleManifestV1Alpha1,
  TaskPackManifestV1Alpha1,
} from "@issueready/schema";
import { compileSchema } from "@issueready/schema";
import { describe, expect, it } from "vitest";

import { validateCatalog } from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function loadJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(repositoryRoot, relativePath), "utf8"));
}

function loadDirectory<T>(relativeDirectory: string): readonly T[] {
  const directory = join(repositoryRoot, relativeDirectory);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map(
      (name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as T,
    );
}

const rules = loadDirectory<RuleManifestV1Alpha1>("rules/catalog/v1alpha1");
const taskPacks = loadDirectory<TaskPackManifestV1Alpha1>(
  "rules/task-packs/v1alpha1",
);

describe("registered rule catalog", () => {
  it("contains exactly the 24 v1 rules and eight registered task packs", () => {
    expect(rules).toHaveLength(24);
    expect(taskPacks).toHaveLength(8);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(24);
    expect(new Set(taskPacks.map((pack) => pack.id))).toEqual(
      new Set([
        "generic",
        "bug",
        "feature",
        "docs",
        "dependency",
        "refactor",
        "test-ci",
        "operations",
      ]),
    );
    expect(rules.some((rule) => rule.id === "IR-SEM-000")).toBe(false);
  });

  it("validates every manifest against its JSON Schema", () => {
    const validateRule = compileSchema(
      loadJson("schemas/v1alpha1/rule-manifest.schema.json") as object,
    );
    const validateTaskPack = compileSchema(
      loadJson("schemas/v1alpha1/task-pack.schema.json") as object,
    );
    for (const rule of rules) {
      expect(validateRule(rule), rule.id).toEqual({ valid: true, issues: [] });
    }
    for (const pack of taskPacks) {
      expect(validateTaskPack(pack), pack.id).toEqual({
        valid: true,
        issues: [],
      });
    }
  });

  it("has exact English coverage for every catalog message key", () => {
    const bundle = loadJson("locales/en/v1alpha1.json") as {
      messages: Readonly<Record<string, string>>;
    };
    const validateLocale = compileSchema(
      loadJson("schemas/v1alpha1/locale-bundle.schema.json") as object,
    );
    expect(validateLocale(bundle)).toEqual({ valid: true, issues: [] });
    const expected = new Set([
      ...rules.map((rule) => rule.messageKey),
      ...taskPacks.flatMap((pack) => [
        pack.displayNameKey,
        ...pack.nonRequirements,
      ]),
    ]);
    expect(new Set(Object.keys(bundle.messages))).toEqual(expected);
  });

  it("assigns every applicable rule exactly once without crossing effect axes", () => {
    expect(validateCatalog({ rules, taskPacks })).toEqual({
      valid: true,
      issues: [],
    });
    expect(rules.find((rule) => rule.id === "IR-POL-001")).toMatchObject({
      canonicalLevel: "disposition-only",
      onFail: { evaluationEffect: "NONE", specEffect: "NONE" },
    });
    expect(rules.find((rule) => rule.id === "IR-INP-001")).toMatchObject({
      canonicalLevel: "evaluation-only",
      onFail: {
        evaluationEffect: "ERROR",
        specEffect: "NONE",
        dispositionEffect: "UNKNOWN",
      },
    });
  });

  it("rejects canonical spec rules that attempt a disposition effect", () => {
    const target = rules.find((rule) => rule.id === "IR-ACC-001");
    expect(target).toBeDefined();
    const changed = structuredClone(target as RuleManifestV1Alpha1);
    changed.onFail.dispositionEffect = "HUMAN_ONLY";
    const result = validateCatalog({
      rules: rules.map((rule) => (rule.id === changed.id ? changed : rule)),
      taskPacks,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.issues.some((issue) => issue.code === "INVALID_EFFECT_BOUNDARY"),
      ).toBe(true);
    }
  });

  it("rejects duplicate or missing task-pack rule assignments", () => {
    const generic = taskPacks.find((pack) => pack.id === "generic");
    expect(generic).toBeDefined();
    const duplicate = structuredClone(generic as TaskPackManifestV1Alpha1);
    const conditional = duplicate.criteria.conditional[0];
    expect(conditional).toBeDefined();
    duplicate.criteria.mandatory.push(conditional as string);
    const result = validateCatalog({
      rules,
      taskPacks: taskPacks.map((pack) =>
        pack.id === duplicate.id ? duplicate : pack,
      ),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.issues.some(
          (issue) => issue.code === "DUPLICATE_RULE_ASSIGNMENT",
        ),
      ).toBe(true);
    }
  });

  it("schema-rejects heading, body-length, and label-only hard vetoes", () => {
    const validateRule = compileSchema(
      loadJson("schemas/v1alpha1/rule-manifest.schema.json") as object,
    );
    const base = rules.find((rule) => rule.id === "IR-ACC-001");
    expect(base).toBeDefined();
    for (const kind of [
      "missing-acceptance-heading",
      "body-shorter-than-thirty",
      "epic-label-present",
    ]) {
      const invalid = structuredClone(base) as unknown as {
        hardPredicate: unknown;
      };
      invalid.hardPredicate = { kind, allowedSources: ["markdown-ast"] };
      expect(validateRule(invalid).valid, kind).toBe(false);
    }
  });
});
