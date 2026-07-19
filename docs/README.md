# Documentation

IssueReady keeps product documentation close to the code and versioned contracts.

## Start here

- [Architecture](architecture.md) — package responsibilities, dependency direction, and trust boundaries.
- [Core API](concepts/core-api.md) — normalize, load policy, evaluate, and render.
- [GitHub read adapter](reference/github-read.md) — bounded request, retry, and consistency behavior.
- [GitHub HTTP executor](reference/github-live.md) — live read-only network boundary.

The JSON Schemas in [`schemas/v1alpha1`](../schemas/v1alpha1) are the wire-contract authority. Generated TypeScript declarations live in [`packages/schema/src/generated`](../packages/schema/src/generated) and are checked byte-for-byte in CI.

For contributor setup and generators, see [CONTRIBUTING.md](../CONTRIBUTING.md).
