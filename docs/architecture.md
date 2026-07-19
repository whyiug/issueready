# Architecture

IssueReady separates source acquisition, deterministic evaluation, and presentation so uncertainty and side effects cannot leak into readiness decisions.

```text
CLI, local file, or GitHub read adapter
              │
              ▼
        normalization ──► immutable snapshot
                              │
             policy ──────────┤
             rules ───────────┤
                              ▼
                         core facade
                              │
                              ▼
                    versioned JSON report
                              │
                              ▼
                      JSON / Markdown render
```

## Package boundaries

| Package                 | Responsibility                                                 |
| ----------------------- | -------------------------------------------------------------- |
| `@issueready/domain`    | Immutable tri-axis domain vocabulary and invariants            |
| `@issueready/schema`    | Runtime JSON Schema validation and generated TypeScript types  |
| `@issueready/normalize` | Markdown, Issue Form, and Unicode evidence normalization       |
| `@issueready/snapshot`  | Immutable, digest-bound issue snapshots                        |
| `@issueready/policy`    | Fixed-precedence policy merge and task classification          |
| `@issueready/rules`     | Versioned rule execution and registered evidence sources       |
| `@issueready/decision`  | Tri-axis decision aggregation and gates                        |
| `@issueready/report`    | Privacy-aware report construction and rendering                |
| `@issueready/core`      | Small supported facade over the deterministic evaluation flow  |
| `@issueready/github`    | Bounded, read-only GitHub transport, decoding, and consistency |
| `@issueready/testkit`   | Fixture and golden-file helpers used only by tests             |
| `issueready`            | Bundled CLI, source acquisition, and terminal presentation     |

Dependencies point toward contracts and pure computation. The core package does not import HTTP clients, provider SDKs, databases, terminal libraries, child processes, or credential sources.

## Contract strategy

- JSON Schemas under `schemas/v1alpha1/` are the wire authority.
- TypeScript projections are generated and committed so drift is visible in review.
- Unknown additive object fields are tolerated where the compatibility contract permits them; unknown enum values fail validation.
- Rule manifests, task packs, policies, locale bundles, snapshots, and reports carry stable revisions or content digests.
- Golden bytes and compatibility fixtures protect deterministic serialization.

## Evaluation boundaries

IssueReady does not infer product requirements from body length, heading count, checklist count, or formatting style. It preserves `UNKNOWN` whenever evidence is incomplete and permits `TOO_BROAD` only when independent goals with separate acceptance criteria are mechanically established.

Optional semantic analysis is an adapter input. Signals must bind to an immutable profile and cannot impersonate deterministic evidence sources or hard predicates.

## Source and network boundaries

The GitHub package is separate from core:

- offline replay and decoding can be tested without importing a network implementation;
- live requests are fixed to `https://api.github.com` and are read-only;
- credentials are injected only for the final request and never enter replay fixtures, cache keys, or reports;
- pagination, retries, redirects, timeouts, and byte counts have hard limits;
- source changes during an evaluation trigger one refresh and then degrade safely.

Applications own credential discovery, persistence, UI, and any GitHub write authorization.

## Privacy defaults

Raw issue bodies are not report fields. Evidence quotes are disabled by default and must be both explicitly requested and redacted before rendering. Provider failures use fixed diagnostics without original response bodies, URLs, or credential values.
