import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as coreApi from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface CorePackageManifest {
  readonly type: string;
  readonly sideEffects: boolean;
  readonly exports: Readonly<{
    ".": Readonly<Record<string, string>>;
  }>;
  readonly dependencies: Readonly<Record<string, string>>;
}

function corePackageManifest(): CorePackageManifest {
  return JSON.parse(
    readFileSync(join(repositoryRoot, "packages/core/package.json"), "utf8"),
  ) as CorePackageManifest;
}

describe("public core contract", () => {
  it("exports only the supported alpha runtime facade", () => {
    expect(Object.keys(coreApi).sort()).toEqual([
      "evaluateIssue",
      "loadPolicy",
      "normalizeIssue",
      "renderReport",
    ]);
  });

  it("is side-effect-free ESM with only deterministic workspace dependencies", () => {
    const manifest = corePackageManifest();

    expect(manifest.type).toBe("module");
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.exports["."]["import"]).toBe("./dist/index.js");
    expect(manifest.exports["."]).not.toHaveProperty("require");
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@issueready/domain",
      "@issueready/policy",
      "@issueready/report",
      "@issueready/rules",
      "@issueready/schema",
      "@issueready/snapshot",
    ]);
  });

  it("does not import network, GitHub, database, terminal, or process runners", () => {
    const source = readFileSync(
      join(repositoryRoot, "packages/core/src/index.ts"),
      "utf8",
    );

    expect(source).not.toMatch(
      /@octokit|commander|node:(?:child_process|http|https|net|tls)|\bfetch\s*\(|\bpg\b|pino|postgres|sqlite/iu,
    );
  });
});
