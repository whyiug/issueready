import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const generator = fileURLToPath(
  new URL("../../../scripts/generate-schema-types.mjs", import.meta.url),
);
const currentReport = fileURLToPath(
  new URL("../src/generated/report.ts", import.meta.url),
);

function check(outputDirectory: string): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      generator,
      "--check",
      "--only",
      "report.ts",
      "--output-directory",
      outputDirectory,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

describe("generated schema type drift gate", () => {
  it("passes an exact projection and rejects a modified generated file", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "issueready-schema-drift-"),
    );
    const outputDirectory = join(temporaryRoot, "generated");
    const report = join(outputDirectory, "report.ts");
    try {
      mkdirSync(outputDirectory);
      copyFileSync(currentReport, report);

      const current = check(outputDirectory);
      expect(current.status, current.stderr).toBe(0);

      appendFileSync(report, "\n// unauthorized drift\n", "utf8");
      const drifted = check(outputDirectory);
      expect(drifted.status).not.toBe(0);
      expect(drifted.stderr).toContain("report.ts");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
