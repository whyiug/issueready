# GitHub live HTTP executor contract

`@issueready/github/live` is the concrete HTTP boundary for the read-only adapter. It is intentionally a separate package export from `@issueready/github/read`: offline replay, decoding, graph analysis, retry policy, and source consistency remain usable without importing a live network implementation.

## Composition

The executor receives credentials only through the already-bounded credential context. It does not discover credentials, read environment variables, invoke `gh`, spawn a subprocess, or log requests.

```ts
import { createGithubHttpExecutor } from "@issueready/github/live";
import {
  createCredentialedGithubTransport,
  readRestResource,
} from "@issueready/github/read";

const executor = createGithubHttpExecutor();
const transport = createCredentialedGithubTransport({
  executor,
  credentialProvider: loadCredentialAtRuntime,
});

const result = await readRestResource(transport, {
  resource: "/repos/owner/repository/issues/42",
});
```

`loadCredentialAtRuntime` is application-owned and must return an in-memory credential without printing, persisting, or embedding it in command arguments. This library export deliberately does not guess a credential source.

## Network and request boundary

- The origin is fixed to `https://api.github.com`; callers provide only validated origin-relative resources.
- Only `GET` and `POST` are accepted. GET bodies and bodyless POST requests are rejected.
- Incoming request headers are restricted to GitHub JSON accept, pinned API version, and conditional ETag. Duplicate case-insensitive names and pre-injected credential/cookie/host headers are rejected.
- The executor adds its fixed user agent, JSON content type for POST, and the credential header only at the final Fetch call.
- Fetch redirect mode is always `manual`; the read layer independently validates and bounds a GitHub transfer location before issuing a new request with a newly resolved credential.
- The abort signal from the 30-second default/120-second hard execution boundary is forwarded through response streaming.

These constraints follow GitHub's current [REST API versioning](https://docs.github.com/en/rest/about-the-rest-api/api-versions) and [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api). The pinned version remains visible in the offline read contract and replay fixtures.

## Body and diagnostic boundary

The executor limits UTF-8 request bodies to 1 MiB. Response bodies are streamed and stopped at 8 MiB by default, with a 32 MiB hard configuration ceiling; declared content length is an early check but never replaces the streaming count. Only ETag, pagination/transfer, retry, and rate-limit response headers leave the HTTP boundary. Cookies and unrelated provider headers are discarded.

Valid JSON becomes the replay body and carries its measured decoded byte count. Empty or malformed JSON becomes `null`, allowing the read/decoder layers to return a protocol result without retaining arbitrary raw text. Fetch, stream, request, credential, and size failures use fixed codes without an original exception, URL dump, body, or credential.

All committed tests inject fake Fetch implementations. They cover REST success, GraphQL partial data, manual repository transfer, request/header negatives, credential isolation, request/stream/content-length bounds, malformed JSON, header filtering, abort forwarding, and fixed network diagnostics. They perform no live network request.
