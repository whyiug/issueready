import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const ruleDirectory = join(repositoryRoot, "rules/catalog/v1alpha1");
const taskPackDirectory = join(repositoryRoot, "rules/task-packs/v1alpha1");
const outputPath = join(
  repositoryRoot,
  "fixtures/rules/four-state.v1alpha1.json",
);
const checkOnly = process.argv.includes("--check");
const outcomes = ["PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"];

async function loadJsonDirectory(directory) {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  return Promise.all(
    names.map(async (name) =>
      JSON.parse(await readFile(join(directory, name), "utf8")),
    ),
  );
}

const [rules, taskPacks] = await Promise.all([
  loadJsonDirectory(ruleDirectory),
  loadJsonDirectory(taskPackDirectory),
]);
const taskPacksById = new Map(taskPacks.map((pack) => [pack.id, pack]));
const sourceKind = (source) => source.split(":", 1)[0] ?? source;
const fixtures = rules.flatMap((rule) => {
  const taskType = rule.appliesTo[0];
  const taskPack = taskPacksById.get(taskType);
  if (taskType === undefined || taskPack === undefined) {
    throw new TypeError(`Rule cannot produce fixtures: ${rule.id}`);
  }
  const common = {
    ruleId: rule.id,
    ruleRevision: rule.revision,
    taskType,
    taskPackRevision: taskPack.revision,
  };
  const sourceOutcomes = rule.evidenceSources.flatMap((source, sourceIndex) =>
    outcomes.map((outcome) => ({
      ...common,
      id: `${rule.id}:SOURCE-${sourceIndex}:${outcome}`,
      scenarioKind:
        sourceIndex === 0
          ? "SINGLE_SOURCE_OUTCOME"
          : "ALTERNATE_SOURCE_OUTCOME",
      signals: [{ source, outcome }],
      expected: {
        kind: "RESULT",
        outcome,
        hardPredicateProven: false,
      },
    })),
  );
  const firstSource = rule.evidenceSources[0];
  if (firstSource === undefined) {
    throw new TypeError(`Rule cannot produce fixtures: ${rule.id}`);
  }
  const boundaryScenarios = [
    {
      ...common,
      id: `${rule.id}:SAME-SOURCE-CONFLICT`,
      scenarioKind: "SAME_SOURCE_CONFLICT",
      signals: [
        { source: firstSource, outcome: "PASS" },
        { source: firstSource, outcome: "FAIL" },
      ],
      expected: {
        kind: "RESULT",
        outcome: "UNKNOWN",
        hardPredicateProven: false,
      },
    },
    {
      ...common,
      id: `${rule.id}:UNREGISTERED-SOURCE`,
      scenarioKind: "UNREGISTERED_SOURCE",
      signals: [{ source: "unregistered-source:fixture", outcome: "PASS" }],
      expected: { kind: "ERROR", code: "UNREGISTERED_SOURCE" },
    },
  ];
  if (rule.canonicalLevel !== "disposition-only") {
    boundaryScenarios.push({
      ...common,
      id: `${rule.id}:POLICY-EFFECT-INJECTION`,
      scenarioKind: "POLICY_EFFECT_INJECTION",
      signals: [
        {
          source: firstSource,
          outcome: "PASS",
          policyEffect: "HUMAN_ONLY",
        },
      ],
      expected: { kind: "ERROR", code: "POLICY_EFFECT_BOUNDARY" },
    });
  }
  if (rule.hardPredicate === "none") {
    boundaryScenarios.push({
      ...common,
      id: `${rule.id}:ILLEGAL-HARD-PREDICATE`,
      scenarioKind: "ILLEGAL_HARD_PREDICATE",
      signals: [
        {
          source: firstSource,
          outcome: "FAIL",
          hardPredicateProven: true,
        },
      ],
      expected: { kind: "ERROR", code: "HARD_PREDICATE_BOUNDARY" },
    });
  } else {
    const hardSource = rule.evidenceSources.find((source) =>
      rule.hardPredicate.allowedSources.includes(sourceKind(source)),
    );
    if (hardSource === undefined) {
      throw new TypeError(`Rule has no registered hard source: ${rule.id}`);
    }
    boundaryScenarios.push({
      ...common,
      id: `${rule.id}:HARD-PREDICATE-PRECEDENCE`,
      scenarioKind: "HARD_PREDICATE_PRECEDENCE",
      signals: [
        { source: firstSource, outcome: "PASS" },
        {
          source: hardSource,
          outcome: "FAIL",
          hardPredicateProven: true,
        },
      ],
      expected: {
        kind: "RESULT",
        outcome: "FAIL",
        hardPredicateProven: true,
      },
    });
  }
  return [...sourceOutcomes, ...boundaryScenarios];
});
const catalog = {
  schemaVersion:
    "https://example.invalid/issueready/rule-execution-fixture-catalog/v1alpha1",
  kind: "RuleExecutionFixtureCatalog",
  fixtures,
};
const generated = await format(JSON.stringify(catalog), {
  parser: "json",
  printWidth: 80,
  trailingComma: "none",
});

if (checkOnly) {
  let current = null;
  try {
    current = await readFile(outputPath, "utf8");
  } catch {
    // A missing fixture catalog is reported as drift below.
  }
  if (current !== generated) {
    console.error(
      `Generated rule fixtures are out of date: ${relative(repositoryRoot, outputPath)}`,
    );
    console.error("Run: corepack pnpm generate:rule-fixtures");
    process.exitCode = 1;
  } else {
    console.log(
      `Generated rule fixtures are current (${fixtures.length} scenarios).`,
    );
  }
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated, "utf8");
  console.log(`generated ${relative(repositoryRoot, outputPath)}`);
}
