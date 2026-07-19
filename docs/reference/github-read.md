# GitHub read adapter contract

`@issueready/github/read` provides bounded request orchestration, offline response replay, native-field decoding, relationship analysis, retry scheduling, and source-consistency checks. The module accepts a caller-owned `GithubTransport`; the separate `@issueready/github/live` export supplies the concrete read-only HTTP executor.

## Request boundary

The read layer emits only `GET` requests for REST collections and `POST /graphql` for GraphQL reads. REST resources must be origin-relative paths. Absolute URLs, protocol-relative paths, fragments, backslashes, and line breaks are rejected before the transport is called.

Requests include the pinned `X-GitHub-Api-Version: 2026-03-10` and GitHub JSON accept header. Authentication is deliberately absent from the replay request model. A future live transport owns credential injection at the final HTTP boundary and must not copy authorization values into fixtures, cache keys, reports, or replay mismatch errors.

Pagination follows only a `rel="next"` HTTPS URL on `api.github.com` with the same pathname as the initial collection. Off-origin, credential-bearing, fragment-bearing, malformed, path-changing, and cyclic links fail as protocol or bound errors without being followed.

Single-object REST responses use the same ETag, byte, status, and metadata contract as collections. A `301` repository/Issue transfer redirect may be followed at most once by default and three times at the hard maximum. The location must resolve to a safe path on `https://api.github.com`; credentials, fragments, protocol-relative paths, and off-origin locations are rejected. The old locator's ETag is never forwarded to the redirected resource, and a redirected collection adopts the new pathname before validating later pagination links.

## Result states

The result contract preserves infrastructure uncertainty instead of converting it into issue-content conclusions.

| Input state                                                       | Result                               | Meaning                                                                |
| ----------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| REST/GraphQL 2xx with the expected shape                          | `OK`                                 | Captured data is available.                                            |
| First REST response 304                                           | `NOT_MODIFIED`                       | The caller may reuse the matching ETag-bound cache entry.              |
| 401 or non-rate-limit 403                                         | `UNAVAILABLE/PERMISSION_DENIED`      | The read was conclusively denied.                                      |
| 404, 409, 410, 422                                                | `UNAVAILABLE` with a specific reason | The requested source is absent, conflicting, unsupported, or invalid.  |
| 403 with exhausted quota or `Retry-After`, and 429                | `UNKNOWN/RATE_LIMITED`               | Provider availability is transient; this is not missing issue content. |
| 5xx                                                               | `UNKNOWN/SERVER_ERROR`               | The layer returns after one request and does not retry automatically.  |
| GraphQL data plus errors                                          | `UNKNOWN/PARTIAL_RESPONSE`           | Partial data may be retained, but availability is not asserted.        |
| Malformed shape/link/status                                       | `UNKNOWN/PROTOCOL_ERROR`             | The response cannot safely satisfy the contract.                       |
| Page, per-response, aggregate-response, or request bound exceeded | `UNKNOWN/BOUNDS_EXCEEDED`            | Processing stops at the configured bound.                              |

Rate-limit limit, remaining count, reset time, retry delay, ETag, and request count are returned as metadata. The pure layer never sleeps and never performs an automatic retry; a higher-level scheduler may later apply a separately bounded policy.

## Hard bounds

| Bound                          |           Default |      Hard maximum |
| ------------------------------ | ----------------: | ----------------: |
| REST pages                     |                20 |               100 |
| One response body              |             1 MiB |             8 MiB |
| Aggregate REST response bodies |             8 MiB |            32 MiB |
| GraphQL request body           |           256 KiB |             1 MiB |
| GraphQL query text             | 65,536 characters | 65,536 characters |

The transport reports the measured response byte count. Replay fixtures additionally assert that the declared count equals the UTF-8 byte length of the committed JSON body.

## Offline compatibility fixtures

`fixtures/github/read-replay.v1alpha1.json` covers ETag/304, two-page REST pagination, permission denial, primary and secondary rate limiting, 404, 409, 422, 429, 503 without retry, and partial GraphQL. Its v1alpha1 JSON Schema is compiled in the normal schema contract tests, and the generated TypeScript projection is protected by the workspace drift gate.

## Native snapshot projection

`projectGithubNative` projects adapter-owned Issue Type, field, parent, sub-issue, dependency, and reference reads into the digest-bound snapshot envelope. Every feature records both the check mechanism and a three-state capability:

- successful data and 304 with a supplied cache value become `AVAILABLE`;
- permission denial, not found, and unsupported API become explicit `UNAVAILABLE` reasons;
- conflict, rate limit, and server failure become `UNKNOWN/TRANSIENT_ERROR`;
- partial, malformed, invalid-request, protocol, and bounds results become `UNKNOWN/PARTIAL_RESPONSE`.

Partial GraphQL or bounded REST data may be retained while its capability remains `UNKNOWN`; retained data never upgrades the state. A successful response with the wrong shape is discarded and downgraded. Collections are replaced from each projection rather than merged, so renamed and deleted fields cannot persist from an older snapshot. Tests bind native changes to a different snapshot digest.

Reference targets are limited to 100 unique issue/PR identifiers. Each target retains essentiality and its own available, denied, not-found, or transient state. The finished native envelope is checked by the snapshot runtime guard in integration tests.

## Raw endpoint decoding

The raw decoder layer accepts only `GithubReadResult<unknown>` values already produced by the bounded transport. It validates and minimizes the provider payload before native projection:

- parent, sub-issue, and dependency responses use the documented REST Issue shape, enforce matching GitHub URL and Issue number, distinguish Issue from pull request, reject duplicate node IDs, and stop at 100 relationships;
- Issue field values support the five documented `text`, `single_select`, `number`, `date`, and `multi_select` variants, including bounded select options and stable definition/node IDs;
- the adapter-owned GraphQL query reads the current Issue Type's `id`, `name`, `description`, `color`, and `isEnabled` fields, and deliberately omits the deprecated `isPrivate` field;
- unknown enums, incompatible typed values, malformed successful responses, duplicate identities, and over-bound collections become `UNKNOWN/PROTOCOL_ERROR` rather than trusted native facts;
- valid data accompanying a partial GraphQL result is minimized and retained while the original `UNKNOWN/PARTIAL_RESPONSE` outcome remains unchanged.

Relationship objects intentionally discard response body, user, label, assignee, milestone, and other unrelated fields. Tests include secret-shaped synthetic body content and prove that it does not enter the normalized relationship object. The decoder shapes follow GitHub's current [sub-issue REST response](https://docs.github.com/en/rest/issues/sub-issues), [Issue dependency REST response](https://docs.github.com/en/rest/issues/issue-dependencies), [Issue field values REST response](https://docs.github.com/en/rest/issues/issue-field-values), and [GraphQL `IssueType` object](https://docs.github.com/en/graphql/reference/issues).

## Transfer-safe cache identity

`githubIssueCacheIdentity` separates immutable provider node IDs from the mutable `owner/repository#number` locator. Entity-derived data can remain associated with the same Issue node ID across a repository rename, owner transfer, or Issue transfer. Locator-bound ETags are reusable only when Issue ID, repository ID, case-normalized locator, and pinned API version all remain unchanged. Any locator or repository identity change invalidates the ETag; an API version change invalidates both decoded entity reuse and ETag reuse; an Issue node ID change invalidates entity-derived data. Synthetic fixtures cover repository rename/owner transfer, cross-repository Issue transfer, API version drift, case-only locator changes, replacement Issue identities, and malformed identity inputs.

## Relationship graph bounds

`analyzeGithubRelationshipGraph` validates an adapter-owned graph before relationship facts reach later rules. It caps the graph at 801 nodes and 1,600 edges, caps each parent's immediate children at 100, and accepts at most eight hierarchy levels including the root. It rejects duplicate node IDs, duplicate mutable locators, duplicate edges, missing edge targets, multiple parents, disconnected hierarchy fragments, and hierarchy cycles. Dependency cycles remain a valid observed fact and are reported as `dependencyCycle: true` rather than being silently discarded.

The versioned `native-relationships.v1alpha1.json` catalog covers the exact 8/9-level and 100/101-child boundaries, cross-repository children, duplicate dependencies, dependency and hierarchy cycles, and a closed-to-reopened child transition. The fixture recipe stays compact while tests expand it into the full boundary graph, so the 100-child case exercises the runtime rather than only a counter assertion. Graph analysis is invariant to provider node/edge ordering and recomputes state from each response instead of merging stale child state.

## Credential, timeout, and retry execution contract

The read orchestration keeps live I/O executor-injected; `@issueready/github/live` provides the concrete GitHub-only implementation. `createCredentialedGithubTransport` resolves a credential for every request and passes it only in the final executor context; it never copies the value into the replay request, fixture, cache identity, or diagnostic. Credential resolution and executor work share one 30-second default timeout with a 120-second hard maximum and receive an abort signal. Provider, executor, timeout, and scheduler failures become fixed error codes without retaining the original exception or response body.

Low-level REST and GraphQL readers still perform zero automatic retries. A caller may explicitly wrap a complete read operation with `executeGithubReadWithRetry`. That scheduler retries only `RATE_LIMITED` and `SERVER_ERROR`, defaults to three attempts, is hard-capped at five attempts, and has a 120-second default/600-second hard cumulative delay budget. It honors `Retry-After`, then exhausted-quota reset time, then bounded exponential delays. Permission, not-found, invalid, partial, protocol, bounds, success, and not-modified results return immediately. Sleeping is caller-owned and injected, making replay tests deterministic and preventing a hidden timer from blocking a worker.

## Source-change consistency

`evaluateGithubSourceConsistently` binds evaluation to a revision made from stable Issue/repository node IDs, the case-normalized locator, pinned API version, normalized `updated_at`, and ETag. It captures once, evaluates a cloned payload, and captures again. Matching revisions return the first result. A changed revision permits exactly one fresh evaluation followed by one final observation. If the source changes again, both potentially stale outputs are discarded and the caller receives `DEGRADED` with `IR-SRC-002 SOURCE_CHANGED_DURING_EVALUATION`, two evaluation attempts, and three observations.

Repository rename, owner transfer, Issue transfer/renumber, API-version drift, ETag change, timestamp change, and Issue replacement all force the bounded refresh. Case-only owner/repository spelling does not. Malformed identity, date-time, API-version, and ETag inputs fail before evaluation, and cloned inputs prevent an evaluator from mutating captured source evidence.

The concrete GitHub-only HTTP executor is documented separately in [`github-live.md`](./github-live.md). Applications may supply an approved local credential source and opt-in live orchestration, but must preserve the credential, timeout, redirect, retry, fixed-diagnostic, and source-consistency contracts described here.
