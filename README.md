# IssueReady

[![CI](https://github.com/whyiug/issueready/actions/workflows/ci.yml/badge.svg)](https://github.com/whyiug/issueready/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

IssueReady is a local-first TypeScript toolkit for deciding whether a GitHub issue is ready for implementation. It produces evidence-backed results without executing coding agents or writing to GitHub.

Instead of collapsing everything into one score, IssueReady keeps three questions separate:

- **Evaluation:** did the analysis complete reliably?
- **Specification:** is the task ready, missing information, or demonstrably too broad?
- **Delegation:** may an agent work independently, under supervision, or only with a human?

## Why IssueReady

- **Evidence over heuristics.** Findings point to exact source spans and versioned rules.
- **Deterministic by default.** The core runs locally without an API key, model, database, or network connection.
- **Honest uncertainty.** Permission failures, rate limits, partial responses, and malformed input never masquerade as missing requirements.
- **Repository-aware.** Policies, Issue Forms, task types, fields, relationships, and dependency state can be represented explicitly.
- **Safe integration boundary.** GitHub access is read-only, bounded, and isolated from the side-effect-free evaluation core.

## Status

IssueReady is in early alpha. The contracts and test suite are usable from source, but the workspace packages are not published to npm and compatibility may change before the first release.

## Quick start

Requirements:

- Node.js 24
- Corepack

```bash
git clone https://github.com/whyiug/issueready.git
cd issueready
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm example
```

The example evaluates [a local issue](examples/sample-issue.md) and prints a Markdown report. It performs no network request and needs no credentials.

Run every quality gate with:

```bash
corepack pnpm validate
```

## Core API

The supported evaluation flow is intentionally small:

```ts
import {
  evaluateIssue,
  loadPolicy,
  normalizeIssue,
  renderReport,
} from "@issueready/core";

const snapshot = normalizeIssue(issue, { evaluatedAt });
const policy = loadPolicy(policyLayers);
const report = evaluateIssue(snapshot, policy, evaluationOptions);
const markdown = renderReport(report, "markdown", {
  localeBundle: evaluationOptions.assets.localeBundle,
});
```

Callers own source acquisition and pass immutable assets into the core. See the [core API guide](docs/concepts/core-api.md) and the runnable [local example](examples/evaluate-local-issue.mjs) for complete inputs.

## Repository layout

| Path        | Purpose                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `packages/` | Focused ESM packages for domain, policy, rules, reports, GitHub, and the public core facade |
| `schemas/`  | Versioned JSON Schema wire contracts                                                        |
| `rules/`    | Versioned rule manifests and task packs                                                     |
| `fixtures/` | Synthetic, reproducible compatibility and regression fixtures                               |
| `examples/` | Runnable local examples                                                                     |
| `docs/`     | Architecture, API, and adapter documentation                                                |
| `mutation/` | Mutation-test configuration and reviewed evidence                                           |

Start with the [documentation index](docs/README.md) for the architecture and package boundaries.

## Security and privacy

IssueReady does not require issue content to leave the local process. Evidence quotes are omitted by default, credential-shaped values are redacted, and the GitHub transport accepts credentials only at the final HTTP boundary.

Please report vulnerabilities privately according to the [security policy](SECURITY.md). Do not include secrets, private issue content, or tests against public deployments.

## Community

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Use [SUPPORT.md](SUPPORT.md) to choose the right support channel.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in all project spaces.

## License

IssueReady is available under the [MIT License](LICENSE).
