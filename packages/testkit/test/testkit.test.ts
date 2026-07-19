import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createFixtureLoader } from "../src/index.js";

const fixtures = createFixtureLoader(new URL("../../../", import.meta.url));

describe("fixture loader", () => {
  it("reads UTF-8 text and typed JSON from a fixed repository root", () => {
    const text = fixtures.text("fixtures/reports/valid-complete.json");
    const report = fixtures.json<{ readonly schemaVersion: string }>(
      "fixtures/reports/valid-complete.json",
    );

    expect(text).toContain('"schemaVersion": "1.0.0-alpha.1"');
    expect(report.schemaVersion).toBe("1.0.0-alpha.1");
    expect(Object.isFrozen(fixtures)).toBe(true);
  });

  it("loads JSON directories in stable filename order", () => {
    const loaded = fixtures.jsonDirectory<{ readonly id: string }>(
      "rules/catalog/v1alpha1",
    );

    expect(loaded).toHaveLength(24);
    expect(loaded.map(({ name }) => name)).toEqual(
      loaded.map(({ name }) => name).sort(),
    );
    expect(loaded.every(({ name, value }) => name === `${value.id}.json`)).toBe(
      true,
    );
  });

  it("rejects absolute paths, traversal, and invalid JSON", () => {
    expect(() => fixtures.text("/etc/passwd")).toThrow(/relative path/u);
    expect(() => fixtures.text("../package.json")).toThrow(/escapes its root/u);
    expect(() => fixtures.json("README.md")).toThrow(/Invalid JSON fixture/u);
  });

  it("rejects a symlink that resolves outside the fixture root", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "issueready-testkit-"));
    const fixtureRoot = join(sandbox, "fixtures");
    const outside = join(sandbox, "outside");
    try {
      mkdirSync(fixtureRoot);
      mkdirSync(outside);
      writeFileSync(join(outside, "private.json"), "{}\n", "utf8");
      symlinkSync(outside, join(fixtureRoot, "escape"), "junction");
      const isolated = createFixtureLoader(fixtureRoot);

      expect(() => isolated.text("escape/private.json")).toThrow(
        /symlink escapes its root/u,
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
