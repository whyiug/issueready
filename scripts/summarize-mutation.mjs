import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const checkOnly = process.argv.includes("--check");
const summaryRelativePath = "mutation/summary.json";
const reviewRelativePath = "mutation/equivalent-mutants.json";
const threshold = 85;

const scopes = [
  {
    name: "decision",
    source: "packages/decision/src/index.ts",
    test: "packages/decision/test/decision.test.ts",
    config: "mutation/stryker.decision.config.mjs",
    raw: "runs/mutation/decision.json",
  },
  {
    name: "policy",
    source: "packages/policy/src/index.ts",
    test: "packages/policy/test/policy.test.ts",
    config: "mutation/stryker.policy.config.mjs",
    raw: "runs/mutation/policy.json",
  },
  {
    name: "redaction",
    source: "packages/report/src/redaction.ts",
    test: "packages/report/test/redaction.test.ts",
    config: "mutation/stryker.redaction.config.mjs",
    raw: "runs/mutation/redaction.json",
  },
];

function absolute(relativePath) {
  return fileURLToPath(new URL(relativePath, new URL("../", import.meta.url)));
}

async function text(relativePath) {
  return readFile(absolute(relativePath), "utf8");
}

async function json(relativePath) {
  return JSON.parse(await text(relativePath));
}

async function digest(relativePath) {
  const bytes = await readFile(absolute(relativePath));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameLocation(left, right) {
  return (
    left.start.line === right.start.line &&
    left.start.column === right.start.column &&
    left.end.line === right.end.line &&
    left.end.column === right.end.column
  );
}

function matchesReview(scope, sourceDigest, mutant, review) {
  return (
    review.scope === scope &&
    review.sourceDigest === sourceDigest &&
    review.mutatorName === mutant.mutatorName &&
    review.replacement === mutant.replacement &&
    sameLocation(review.location, mutant.location)
  );
}

function countStatuses(mutants) {
  const statuses = {};
  for (const mutant of mutants) {
    statuses[mutant.status] = (statuses[mutant.status] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(statuses).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

async function buildSummary() {
  const reviewDocument = await json(reviewRelativePath);
  const packageDocument = await json("package.json");
  const pendingReviews = new Set(reviewDocument.reviews);
  const scopeResults = [];

  for (const scope of scopes) {
    const report = await json(scope.raw);
    if (
      report.thresholds.high !== threshold ||
      report.thresholds.low !== threshold ||
      report.thresholds.break !== threshold
    ) {
      throw new Error(`${scope.name} raw report does not bind threshold 85`);
    }
    const sourceDigest = await digest(scope.source);
    const fileEntry = Object.entries(report.files).find(([fileName]) =>
      fileName.replaceAll("\\", "/").endsWith(scope.source),
    )?.[1];
    if (fileEntry === undefined) {
      throw new Error(
        `${scope.name} raw report does not contain ${scope.source}`,
      );
    }
    const statuses = countStatuses(fileEntry.mutants);
    const survivors = fileEntry.mutants
      .filter((mutant) => mutant.status === "Survived")
      .map((mutant) => {
        const review = reviewDocument.reviews.find((candidate) =>
          matchesReview(scope.name, sourceDigest, mutant, candidate),
        );
        if (review !== undefined) pendingReviews.delete(review);
        return {
          id: mutant.id,
          mutatorName: mutant.mutatorName,
          replacement: mutant.replacement,
          location: mutant.location,
          review:
            review === undefined
              ? {
                  classification: "UNREVIEWED",
                  critical: true,
                  rationale: null,
                }
              : {
                  classification: review.classification,
                  critical: review.critical,
                  rationale: review.rationale,
                },
        };
      });
    const total = fileEntry.mutants.length;
    const killed = statuses.Killed ?? 0;
    const timeout = statuses.Timeout ?? 0;
    const noCoverage = statuses.NoCoverage ?? 0;
    const survived = statuses.Survived ?? 0;
    const error = total - killed - timeout - noCoverage - survived;
    const criticalSurvivors = survivors.filter(
      (mutant) => mutant.review.critical,
    ).length;
    const score = Number(((killed / total) * 100).toFixed(2));
    scopeResults.push({
      name: scope.name,
      source: scope.source,
      sourceDigest,
      test: scope.test,
      testDigest: await digest(scope.test),
      config: scope.config,
      configDigest: await digest(scope.config),
      rawReportSchemaVersion: report.schemaVersion,
      counts: { total, killed, survived, timeout, noCoverage, error },
      mutationScore: score,
      threshold,
      criticalSurvivors,
      survivors,
      passed:
        score >= threshold &&
        timeout === 0 &&
        noCoverage === 0 &&
        error === 0 &&
        criticalSurvivors === 0,
    });
  }

  if (pendingReviews.size > 0) {
    throw new Error(
      "Equivalent-mutant review does not match a current survivor",
    );
  }

  return {
    schemaVersion:
      "https://example.invalid/issueready/mutation-evidence/v1alpha1",
    tool: {
      stryker: packageDocument.devDependencies["@stryker-mutator/core"],
      testRunner: "command-via-vitest",
      vitest: packageDocument.devDependencies.vitest,
      concurrency: 2,
      timeoutMs: 10_000,
      rawReports: "runs/mutation/*.json (local, gitignored)",
    },
    sharedConfigDigest: await digest("mutation/base-config.mjs"),
    reviewDigest: await digest(reviewRelativePath),
    lockfileDigest: await digest("pnpm-lock.yaml"),
    scopes: scopeResults,
    passed: scopeResults.every((scope) => scope.passed),
  };
}

async function validateStoredSummary(summary) {
  if (summary.passed !== true || summary.scopes.length !== scopes.length) {
    throw new Error("Stored mutation evidence is not passing or is incomplete");
  }
  if (
    summary.sharedConfigDigest !== (await digest("mutation/base-config.mjs")) ||
    summary.reviewDigest !== (await digest(reviewRelativePath)) ||
    summary.lockfileDigest !== (await digest("pnpm-lock.yaml"))
  ) {
    throw new Error("Stored mutation evidence is bound to stale tooling");
  }
  const reviewDocument = await json(reviewRelativePath);
  const matchedReviews = new Set();
  for (const definition of scopes) {
    const scope = summary.scopes.find(
      (candidate) => candidate.name === definition.name,
    );
    if (scope === undefined) {
      throw new Error(`Stored mutation evidence omits ${definition.name}`);
    }
    const accounted =
      scope.counts.killed +
      scope.counts.survived +
      scope.counts.timeout +
      scope.counts.noCoverage +
      scope.counts.error;
    const expectedScore = Number(
      ((scope.counts.killed / scope.counts.total) * 100).toFixed(2),
    );
    const criticalSurvivors = scope.survivors.filter(
      (mutant) => mutant.review.critical,
    ).length;
    if (
      scope.source !== definition.source ||
      scope.test !== definition.test ||
      scope.config !== definition.config ||
      scope.sourceDigest !== (await digest(definition.source)) ||
      scope.testDigest !== (await digest(definition.test)) ||
      scope.configDigest !== (await digest(definition.config)) ||
      accounted !== scope.counts.total ||
      scope.survivors.length !== scope.counts.survived ||
      scope.mutationScore !== expectedScore ||
      scope.mutationScore < threshold ||
      scope.threshold !== threshold ||
      scope.counts.timeout !== 0 ||
      scope.counts.noCoverage !== 0 ||
      scope.counts.error !== 0 ||
      criticalSurvivors !== scope.criticalSurvivors ||
      criticalSurvivors !== 0 ||
      scope.passed !== true
    ) {
      throw new Error(`Stored ${scope.name} mutation evidence is inconsistent`);
    }
    for (const survivor of scope.survivors) {
      const review = reviewDocument.reviews.find((candidate) =>
        matchesReview(scope.name, scope.sourceDigest, survivor, candidate),
      );
      if (
        review === undefined ||
        survivor.review.classification !== review.classification ||
        survivor.review.critical !== review.critical ||
        survivor.review.rationale !== review.rationale
      ) {
        throw new Error(`Stored ${scope.name} survivor review is stale`);
      }
      matchedReviews.add(review);
    }
  }
  if (matchedReviews.size !== reviewDocument.reviews.length) {
    throw new Error(
      "Equivalent-mutant reviews contain stale or duplicate entries",
    );
  }
}

if (checkOnly) {
  const actual = await text(summaryRelativePath);
  await validateStoredSummary(JSON.parse(actual));
  console.log("Mutation evidence is current for 3 scopes");
} else {
  const expected = `${JSON.stringify(await buildSummary(), null, 2)}\n`;
  await writeFile(absolute(summaryRelativePath), expected);
  console.log(`Wrote ${summaryRelativePath}`);
}
