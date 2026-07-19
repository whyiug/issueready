import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

export type { CuratedIssueFixtureCatalogV1Alpha1 } from "./generated/curated-issue-fixture.js";
export type { GithubNativeRelationshipFixtureCatalogV1Alpha1 } from "./generated/github-native-relationship-fixture.js";
export type { GithubReadReplayCatalogV1Alpha1 } from "./generated/github-read-replay.js";
export type { LocaleBundleV1Alpha1 } from "./generated/locale-bundle.js";
export type { NormalizationV1Alpha1 } from "./generated/normalization.js";
export type { IssueReadyPolicyV1Alpha1 } from "./generated/policy.js";
export type { IssueReadyReportV1Alpha1 } from "./generated/report.js";
export type { RuleManifestV1Alpha1 } from "./generated/rule-manifest.js";
export type { RuleExecutionFixtureCatalogV1Alpha1 } from "./generated/rule-execution-fixture.js";
export type { IssueSnapshotV1Alpha1 } from "./generated/snapshot.js";
export type { TaskPackManifestV1Alpha1 } from "./generated/task-pack.js";

export interface ValidationIssue {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export type ValidationResult =
  | Readonly<{ valid: true; issues: readonly [] }>
  | Readonly<{ valid: false; issues: readonly ValidationIssue[] }>;

export type SchemaValidator = (value: unknown) => ValidationResult;

function normalizeIssue(error: ErrorObject): ValidationIssue {
  return {
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "schema validation failed",
  };
}

export function compileSchema(
  schema: object,
  referencedSchemas: readonly object[] = [],
): SchemaValidator {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });
  for (const referencedSchema of referencedSchemas) {
    ajv.addSchema(referencedSchema);
  }
  const validate = ajv.compile(schema);

  return (value: unknown): ValidationResult => {
    if (validate(value)) return { valid: true, issues: [] };
    return {
      valid: false,
      issues: (validate.errors ?? []).map(normalizeIssue),
    };
  };
}
