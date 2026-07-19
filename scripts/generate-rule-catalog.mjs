import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const ruleDirectory = join(repositoryRoot, "rules/catalog/v1alpha1");
const taskPackDirectory = join(repositoryRoot, "rules/task-packs/v1alpha1");
const checkOnly = process.argv.includes("--check");
const taskTypes = [
  "generic",
  "bug",
  "feature",
  "docs",
  "dependency",
  "refactor",
  "test-ci",
  "operations",
];

const all = taskTypes;
const rules = [
  {
    id: "IR-DEF-001",
    dimension: "definition",
    engine: "deterministic+semantic",
    message: "concrete-object-action",
    appliesTo: all,
    level: "mandatory",
    sources: [
      "issue-title:object-action",
      "issue-body:object-action",
      "semantic-criterion:concrete-work",
    ],
    hard: ["title-or-body-provably-empty", ["issue-title", "issue-body"]],
  },
  {
    id: "IR-DEF-002",
    dimension: "definition",
    engine: "semantic",
    message: "independent-restatement",
    appliesTo: all,
    level: "mandatory",
    sources: ["semantic-criterion:independent-restatement"],
  },
  {
    id: "IR-DEF-003",
    dimension: "definition",
    engine: "semantic",
    message: "decisive-ambiguity",
    appliesTo: all,
    level: "mandatory",
    sources: ["semantic-criterion:decisive-ambiguity"],
  },
  {
    id: "IR-DEF-004",
    dimension: "definition",
    engine: "semantic",
    message: "implementation-contradiction",
    appliesTo: all,
    level: "mandatory",
    sources: ["semantic-criterion:cross-source-contradiction"],
  },
  {
    id: "IR-SCP-001",
    dimension: "scope",
    engine: "hybrid",
    message: "primary-delivery-goal",
    appliesTo: all,
    level: "mandatory",
    sources: [
      "markdown-ast:goal-structure",
      "native-relationships:children",
      "semantic-criterion:primary-goal",
    ],
  },
  {
    id: "IR-SCP-002",
    dimension: "scope",
    engine: "hybrid",
    message: "independent-delivery-goals",
    appliesTo: all,
    level: "mandatory",
    sources: [
      "markdown-ast:independent-goals",
      "native-relationships:independent-children",
      "semantic-criterion:separable-goals",
    ],
    hard: [
      "independent-goals-with-separate-acceptance",
      ["markdown-ast", "native-relationships"],
    ],
    failSpec: "TOO_BROAD",
  },
  {
    id: "IR-SCP-003",
    dimension: "scope",
    engine: "semantic",
    message: "cross-boundary-contract",
    appliesTo: all,
    level: "conditional",
    sources: ["semantic-criterion:cross-boundary-contract"],
  },
  {
    id: "IR-ACC-001",
    dimension: "acceptance",
    engine: "deterministic+semantic",
    message: "observable-completion",
    appliesTo: all,
    level: "mandatory",
    sources: [
      "issue-form-field:acceptance",
      "markdown-ast:acceptance-candidate",
      "semantic-criterion:observable-acceptance",
    ],
    hard: ["required-field-provably-empty", ["issue-form-field"]],
  },
  {
    id: "IR-ACC-002",
    dimension: "acceptance",
    engine: "semantic",
    message: "goal-aligned-acceptance",
    appliesTo: all,
    level: "mandatory",
    sources: ["semantic-criterion:goal-acceptance-alignment"],
  },
  {
    id: "IR-VAL-001",
    dimension: "validation",
    engine: "hybrid",
    message: "applicable-validation",
    appliesTo: all,
    level: "conditional",
    sources: [
      "issue-form-field:validation",
      "markdown-ast:validation-candidate",
      "semantic-criterion:applicable-validation",
    ],
  },
  {
    id: "IR-EDG-001",
    dimension: "behavior",
    engine: "semantic",
    message: "critical-edge-behavior",
    appliesTo: ["bug", "feature"],
    level: "conditional",
    sources: ["semantic-criterion:critical-edge-behavior"],
  },
  {
    id: "IR-BUG-001",
    dimension: "bug",
    engine: "deterministic+semantic",
    message: "observed-versus-expected",
    appliesTo: ["bug"],
    level: "mandatory",
    sources: [
      "issue-form-field:observed",
      "issue-form-field:expected",
      "markdown-ast:observed-expected",
      "semantic-criterion:observed-expected-distinction",
    ],
    hard: ["required-field-provably-empty", ["issue-form-field"]],
  },
  {
    id: "IR-BUG-002",
    dimension: "bug",
    engine: "hybrid",
    message: "bounded-reproduction",
    appliesTo: ["bug"],
    level: "conditional",
    sources: [
      "issue-form-field:reproduction",
      "markdown-ast:reproduction",
      "semantic-criterion:reproduction-or-constraint",
    ],
  },
  {
    id: "IR-CTX-001",
    dimension: "context",
    engine: "deterministic",
    message: "navigation-hint",
    appliesTo: all,
    level: "advisory",
    sources: [
      "markdown-ast:code-symbol-link",
      "native-fields:mapped-component",
    ],
  },
  {
    id: "IR-CTX-002",
    dimension: "context",
    engine: "hybrid",
    message: "environment-prerequisites",
    appliesTo: all,
    level: "conditional",
    sources: [
      "issue-form-field:environment",
      "markdown-ast:environment",
      "semantic-criterion:required-prerequisites",
    ],
  },
  {
    id: "IR-CTX-003",
    dimension: "context",
    engine: "deterministic",
    message: "essential-context-available",
    appliesTo: all,
    level: "conditional",
    sources: ["snapshot-context:availability", "github-reference:access-state"],
    hard: [
      "essential-context-provably-unavailable",
      ["snapshot-context", "github-reference"],
    ],
  },
  {
    id: "IR-DEP-001",
    dimension: "dependency",
    engine: "hybrid",
    message: "dependency-contract",
    appliesTo: ["bug", "feature", "dependency", "refactor", "operations"],
    level: "conditional",
    sources: [
      "native-relationships:dependencies",
      "markdown-ast:dependency-reference",
      "semantic-criterion:dependency-contract",
    ],
  },
  {
    id: "IR-MIG-001",
    dimension: "compatibility",
    engine: "semantic",
    message: "migration-boundary",
    appliesTo: ["feature", "dependency", "refactor"],
    level: "conditional",
    sources: ["semantic-criterion:migration-compatibility-boundary"],
  },
  {
    id: "IR-PERF-001",
    dimension: "quality",
    engine: "semantic",
    message: "performance-measurement",
    appliesTo: all,
    level: "conditional",
    sources: ["semantic-criterion:performance-workload-measurement"],
  },
  {
    id: "IR-POL-001",
    dimension: "delegation-policy",
    engine: "deterministic",
    message: "repository-delegation-boundary",
    appliesTo: all,
    level: "disposition-only",
    sources: [
      "repository-policy:delegation-map",
      "native-issue-type:mapped-policy",
      "trusted-label:mapped-policy",
    ],
    hard: [
      "policy-mapped-disposition",
      ["repository-policy", "native-issue-type", "trusted-label"],
    ],
  },
  {
    id: "IR-TRC-001",
    dimension: "traceability",
    engine: "deterministic",
    message: "resolvable-reference",
    appliesTo: all,
    level: "advisory",
    sources: [
      "markdown-ast:internal-reference",
      "github-reference:resolution-state",
    ],
  },
  {
    id: "IR-FRESH-001",
    dimension: "freshness",
    engine: "deterministic+semantic",
    message: "current-dependency-state",
    appliesTo: all,
    level: "conditional",
    sources: [
      "native-relationships:state",
      "github-reference:state",
      "semantic-criterion:version-freshness",
    ],
  },
  {
    id: "IR-COH-001",
    dimension: "coherence",
    engine: "semantic",
    message: "cross-dimension-coherence",
    appliesTo: all,
    level: "mandatory",
    sources: [
      "semantic-criterion:problem-scope-acceptance-validation-coherence",
    ],
  },
  {
    id: "IR-INP-001",
    dimension: "input-integrity",
    engine: "deterministic",
    message: "snapshot-evaluation-integrity",
    appliesTo: all,
    level: "evaluation-only",
    sources: [
      "snapshot-integrity:validation",
      "snapshot-integrity:truncation",
      "snapshot-integrity:coverage",
    ],
    hard: ["snapshot-invalid-or-incomplete", ["snapshot-integrity"]],
  },
];

const taskPackOverrides = {
  dependency: { mandatory: ["IR-DEP-001", "IR-MIG-001"] },
  refactor: { mandatory: ["IR-MIG-001"] },
  "test-ci": { mandatory: ["IR-VAL-001"] },
  operations: { mandatory: ["IR-CTX-002", "IR-VAL-001"] },
};

const nonRequirements = {
  generic: ["complete-technical-design"],
  bug: ["known-root-cause", "screenshot"],
  feature: ["exact-file-paths", "complete-technical-design"],
  docs: ["unit-tests", "runtime-environment"],
  dependency: ["long-problem-statement"],
  refactor: ["user-interface-change"],
  "test-ci": ["product-user-story"],
  operations: ["autonomous-execution-authorization"],
};

function uniqueSourceKinds(sources) {
  return [...new Set(sources.map((source) => source.split(":", 1)[0]))];
}

function aggregate(rule) {
  return {
    operator:
      rule.engine === "semantic"
        ? "semantic-criterion"
        : rule.engine === "deterministic"
          ? "deterministic-evidence"
          : "hard-facts-first-then-semantic-coverage",
    sourcePriority: uniqueSourceKinds(rule.sources),
    conflict: "preserve-all-evidence-hard-facts-win-otherwise-unknown",
    unknown: "propagate-when-no-complete-source-proves-outcome",
    notApplicable: "only-registered-task-pack-may-declare",
    possibleOutcomes: ["PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"],
  };
}

function effects(rule) {
  if (rule.level === "disposition-only") {
    return {
      onFail: {
        evaluationEffect: "NONE",
        specEffect: "NONE",
        dispositionEffect: "POLICY_DEFINED",
      },
      onUnknown: {
        evaluationEffect: "DEGRADED",
        specEffect: "NONE",
        dispositionEffect: "UNKNOWN",
      },
    };
  }
  if (rule.level === "evaluation-only") {
    return {
      onFail: {
        evaluationEffect: "ERROR",
        specEffect: "NONE",
        dispositionEffect: "UNKNOWN",
      },
      onUnknown: {
        evaluationEffect: "DEGRADED",
        specEffect: "NULL",
        dispositionEffect: "UNKNOWN",
      },
    };
  }
  if (rule.level === "advisory") {
    return {
      onFail: {
        evaluationEffect: "NONE",
        specEffect: "NONE",
        dispositionEffect: "NONE",
      },
      onUnknown: {
        evaluationEffect: "NONE",
        specEffect: "NONE",
        dispositionEffect: "NONE",
      },
    };
  }
  return {
    onFail: {
      evaluationEffect: "NONE",
      specEffect: rule.failSpec ?? "NEEDS_INFO",
      dispositionEffect: "NONE",
    },
    onUnknown: {
      evaluationEffect: "DEGRADED",
      specEffect: "NULL_IF_OUTCOME_COULD_CHANGE",
      dispositionEffect: "NONE",
    },
  };
}

function ruleManifest(rule) {
  return {
    id: rule.id,
    revision: 1,
    dimension: rule.dimension,
    engine: rule.engine,
    messageKey: `rules.${rule.dimension}.${rule.message}`,
    appliesTo: rule.appliesTo,
    canonicalLevel: rule.level,
    evidenceSources: rule.sources,
    aggregation: aggregate(rule),
    hardPredicate:
      rule.hard === undefined
        ? "none"
        : { kind: rule.hard[0], allowedSources: rule.hard[1] },
    ...effects(rule),
  };
}

function defaultBucket(level) {
  if (level === "evaluation-only") return "evaluation";
  if (level === "disposition-only") return "disposition";
  return level;
}

function taskPackManifest(taskType) {
  const criteria = {
    mandatory: [],
    conditional: [],
    advisory: [],
    evaluation: [],
    disposition: [],
  };
  for (const rule of rules.filter((candidate) =>
    candidate.appliesTo.includes(taskType),
  )) {
    let bucket = defaultBucket(rule.level);
    if (taskPackOverrides[taskType]?.mandatory.includes(rule.id))
      bucket = "mandatory";
    criteria[bucket].push(rule.id);
  }
  for (const bucket of Object.keys(criteria)) criteria[bucket].sort();
  return {
    apiVersion: "https://example.invalid/issueready/task-pack/v1alpha1",
    kind: "TaskPack",
    id: taskType,
    revision: 1,
    displayNameKey: `task-packs.${taskType}.name`,
    criteria,
    nonRequirements: nonRequirements[taskType].map(
      (name) => `task-packs.${taskType}.non-requirements.${name}`,
    ),
  };
}

const outputs = [
  ...rules.map((rule) => ({
    path: join(ruleDirectory, `${rule.id}.json`),
    value: ruleManifest(rule),
  })),
  ...taskTypes.map((taskType) => ({
    path: join(taskPackDirectory, `${taskType}.json`),
    value: taskPackManifest(taskType),
  })),
];

const failures = [];
if (!checkOnly) {
  await mkdir(ruleDirectory, { recursive: true });
  await mkdir(taskPackDirectory, { recursive: true });
}
for (const output of outputs) {
  const generated = await format(JSON.stringify(output.value), {
    parser: "json",
    printWidth: 80,
  });
  if (checkOnly) {
    let current = null;
    try {
      current = await readFile(output.path, "utf8");
    } catch {
      // Missing files are reported as drift.
    }
    if (current !== generated)
      failures.push(relative(repositoryRoot, output.path));
  } else {
    await writeFile(output.path, generated, "utf8");
    console.log(`generated ${relative(repositoryRoot, output.path)}`);
  }
}

if (checkOnly) {
  const expected = new Set(outputs.map((output) => output.path));
  for (const directory of [ruleDirectory, taskPackDirectory]) {
    let names = [];
    try {
      names = (await readdir(directory)).filter((name) =>
        name.endsWith(".json"),
      );
    } catch {
      // Expected missing files are already reported above.
    }
    for (const name of names) {
      const path = join(directory, name);
      if (!expected.has(path))
        failures.push(`stale:${relative(repositoryRoot, path)}`);
    }
  }
}

if (failures.length > 0) {
  console.error(
    `Generated rule catalog is out of date: ${failures.sort().join(", ")}`,
  );
  console.error("Run: corepack pnpm generate:rule-catalog");
  process.exitCode = 1;
} else if (checkOnly) {
  console.log(
    `Generated rule catalog is current (${rules.length} rules, ${taskTypes.length} task packs).`,
  );
}
