# Deterministic core API

IssueReady's core is a side-effect-free ESM package for normalizing one task, loading repository policy, evaluating the three independent decision axes, and rendering the resulting versioned report. It does not fetch GitHub data, call a model, open a database, write comments, or execute an agent.

## Supported runtime surface

`@issueready/core` currently exports four runtime functions:

| Function                                   | Responsibility                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalizeIssue(input, options)`           | Normalize supplied local or adapter-owned Issue data into an immutable, digest-bound snapshot.                                                          |
| `loadPolicy(layers)`                       | Merge schema-valid policy layers with fixed precedence and return the effective policy plus its digest.                                                 |
| `evaluateIssue(snapshot, policy, options)` | Select a registered task pack, execute deterministic and optional profile-locked semantic signals, decide all three axes, and build a versioned report. |
| `renderReport(report, format, options)`    | Render recursively key-sorted JSON or locale-bound, escaped Markdown.                                                                                   |

The supported flow is explicit:

```ts
import {
  evaluateIssue,
  loadPolicy,
  normalizeIssue,
  renderReport,
} from "@issueready/core";

const snapshot = normalizeIssue(input, { evaluatedAt });
const policy = loadPolicy(policyLayers);
const report = evaluateIssue(snapshot, policy, evaluationOptions);
const json = renderReport(report, "json");
const markdown = renderReport(report, "markdown", {
  localeBundle: evaluationOptions.assets.localeBundle,
});
```

Callers own source acquisition and must pass complete data into `normalizeIssue`. GitHub adapters, CLIs, Actions, and Apps may use this API, but transport clients and write authorization do not belong in core.

## Determinism and provenance

The snapshot, merged policy, rule catalog, selected task pack, locale bundle, and optional semantic profile are independently digest-bound. The report records these locks. Its evaluation identity is calculated from a versioned deterministic projection that excludes wall-clock time, provider usage, quote display, request IDs, and other run-envelope facts.

JSON rendering sorts object keys with a locale-independent UTF-16 comparator and emits exactly one trailing newline. Arrays retain their contract-defined order. A committed golden projection guards byte stability.

Markdown rendering requires the exact locale bundle named by the report's engine lock. Canonical finding messages must exist in that bundle. All variable text is escaped before it enters Markdown, and tests reparse hostile messages to ensure they do not become HTML or link nodes.

## Semantic adapter boundary

Optional semantic input is data, not an evaluator replacement. Public adapters may provide only signals whose sources start with `semantic-criterion:` and must bind them to an immutable `semanticProfileDigest`. They cannot inject deterministic source names or hard facts. Invalid snapshots fail closed and do not consume semantic signals.

No external LLM is required by core. If a higher layer uses one, its output remains auxiliary evidence and cannot override registered hard predicates.

## Privacy defaults

Raw Issue bodies are not top-level report fields. Evidence quotes are excluded by default. A caller must opt into quote inclusion while building the report and separately opt into quote expansion while rendering Markdown. Expanded quotes must already be marked redacted; secret-shaped canaries are removed before they reach the report.

## Module and compatibility policy

The current package is ESM-only and targets Node.js 24. Its package manifest has no `require` export and declares `sideEffects: false`. CJS, browser, and edge-runtime compatibility are not currently supported.

Runtime exports and dependency boundaries are protected by contract tests. Adding a public function is a reviewed contract change, not an incidental re-export from an internal package.
