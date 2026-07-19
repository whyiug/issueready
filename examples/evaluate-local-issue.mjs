import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateIssue,
  loadPolicy,
  normalizeIssue,
  renderReport,
} from "../packages/core/dist/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argumentsWithoutFlags = process.argv
  .slice(2)
  .filter((argument) => !argument.startsWith("--"));
const checkOnly = process.argv.includes("--check");
const issuePath = resolve(
  process.cwd(),
  argumentsWithoutFlags[0] ?? "examples/sample-issue.md",
);

async function readJson(path) {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
}

async function readJsonDirectory(path) {
  const directory = resolve(repositoryRoot, path);
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  return Promise.all(
    files.map(async (name) =>
      JSON.parse(await readFile(resolve(directory, name), "utf8")),
    ),
  );
}

const body = await readFile(issuePath, "utf8");
const title =
  body
    .split(/\r?\n/u)
    .find((line) => line.startsWith("# "))
    ?.slice(2)
    .trim() ?? "Local issue";
const evaluatedAt = "2026-01-01T00:00:00Z";
const assets = {
  rules: await readJsonDirectory("rules/catalog/v1alpha1"),
  taskPacks: await readJsonDirectory("rules/task-packs/v1alpha1"),
  localeBundle: await readJson("locales/en/v1alpha1.json"),
};
const policy = loadPolicy([
  {
    source: "BUILT_IN",
    policy: await readJson("fixtures/policies/default.json"),
  },
]);
const snapshot = normalizeIssue(
  {
    source: {
      kind: "local",
      path: relative(repositoryRoot, issuePath).replaceAll("\\", "/"),
      updatedAt: null,
    },
    title,
    body,
  },
  { evaluatedAt },
);
const report = evaluateIssue(snapshot, policy, {
  assets,
  coreVersion: "0.0.0",
  agentCapabilityProfile: "generic-coding-agent-v1",
  supervisionProfile: "maintainer-review-v1",
  generatedAt: evaluatedAt,
});
const markdown = renderReport(report, "markdown", {
  localeBundle: assets.localeBundle,
});

if (checkOnly) {
  if (!markdown.startsWith("# IssueReady report\n")) {
    throw new Error("The example did not produce an IssueReady report");
  }
} else {
  process.stdout.write(markdown);
}
