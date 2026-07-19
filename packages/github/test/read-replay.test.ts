import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createReplayTransport,
  GITHUB_API_VERSION,
  readGraphql,
  readRestCollection,
  type GithubReadResult,
  type GithubReplayEntry,
} from "../src/read/index.js";

interface ReplayFixture {
  readonly id: string;
  readonly operation:
    | {
        readonly kind: "REST_COLLECTION";
        readonly resource: string;
        readonly etag: string | null;
      }
    | {
        readonly kind: "GRAPHQL";
        readonly query: string;
        readonly variables: Readonly<Record<string, unknown>>;
      };
  readonly entries: readonly GithubReplayEntry[];
  readonly expected: {
    readonly outcome: GithubReadResult<unknown>["outcome"];
    readonly reason: string | null;
    readonly requests: number;
    readonly dataLength: number | null;
    readonly remaining: number | null;
    readonly retryAfterSeconds: number | null;
  };
}

interface ReplayCatalog {
  readonly schemaVersion: string;
  readonly kind: "GithubReadReplayCatalog";
  readonly fixtures: readonly ReplayFixture[];
}

const catalog = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/github/read-replay.v1alpha1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ReplayCatalog;

function response(
  status: number,
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly bodyBytes?: number;
  } = {},
) {
  return {
    status,
    headers: options.headers ?? {},
    body: options.body ?? null,
    bodyBytes: options.bodyBytes ?? 4,
  };
}

describe("bounded GitHub read response replay", () => {
  it("keeps the package side-effect-free and free of live I/O or credential reads", () => {
    const packageManifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      sideEffects?: boolean;
      exports?: Readonly<Record<string, unknown>>;
    };
    const sourceDirectory = new URL("../src/read/", import.meta.url);
    const source = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => readFileSync(new URL(name, sourceDirectory), "utf8"))
      .join("\n");
    expect(packageManifest.sideEffects).toBe(false);
    expect(Object.keys(packageManifest.exports ?? {}).sort()).toEqual([
      ".",
      "./live",
      "./read",
    ]);
    for (const forbidden of [
      "fetch(",
      "node:http",
      "node:https",
      "node:child_process",
      "process.env",
      "authorization",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("keeps the fixture catalog byte counts and identifiers exact", () => {
    expect(catalog.schemaVersion).toBe(
      "https://example.invalid/issueready/github-read-replay/v1alpha1",
    );
    expect(catalog.fixtures).toHaveLength(10);
    expect(new Set(catalog.fixtures.map((fixture) => fixture.id)).size).toBe(
      catalog.fixtures.length,
    );
    for (const fixture of catalog.fixtures) {
      for (const entry of fixture.entries) {
        expect(entry.response.bodyBytes, fixture.id).toBe(
          Buffer.byteLength(JSON.stringify(entry.response.body), "utf8"),
        );
      }
    }
  });

  it.each(catalog.fixtures)(
    "replays $id without network or automatic retry",
    async (fixture) => {
      const transport = createReplayTransport(fixture.entries);
      const result =
        fixture.operation.kind === "REST_COLLECTION"
          ? await readRestCollection(transport, {
              resource: fixture.operation.resource,
              etag: fixture.operation.etag,
            })
          : await readGraphql(transport, {
              query: fixture.operation.query,
              variables: fixture.operation.variables,
            });
      expect(result.outcome).toBe(fixture.expected.outcome);
      expect(result.requests).toBe(fixture.expected.requests);
      expect(result.rateLimit.remaining).toBe(fixture.expected.remaining);
      expect(result.rateLimit.retryAfterSeconds).toBe(
        fixture.expected.retryAfterSeconds,
      );
      expect("reason" in result ? result.reason : null).toBe(
        fixture.expected.reason,
      );
      expect(Array.isArray(result.data) ? result.data.length : null).toBe(
        fixture.expected.dataLength,
      );
      transport.assertDrained();
    },
  );

  it("stops before requesting a page beyond the caller bound", async () => {
    const entries: readonly GithubReplayEntry[] = [
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues?per_page=1",
        },
        response: response(200, {
          headers: {
            link: '<https://api.github.com/repos/acme/widgets/issues?per_page=1&page=2>; rel="next"',
          },
          body: [{ id: 1 }],
          bodyBytes: 10,
        }),
      },
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues?per_page=1&page=2",
        },
        response: response(200, {
          body: [{ id: 2 }],
          bodyBytes: 10,
        }),
      },
    ];
    const transport = createReplayTransport(entries);
    const result = await readRestCollection(transport, {
      resource: "/repos/acme/widgets/issues?per_page=1",
      maxPages: 1,
    });
    expect(result).toMatchObject({
      outcome: "UNKNOWN",
      reason: "BOUNDS_EXCEEDED",
      requests: 1,
      data: [{ id: 1 }],
    });
    expect(transport.remaining()).toBe(1);
  });

  it("bounds aggregate response bytes across otherwise valid pages", async () => {
    const transport = createReplayTransport([
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues?per_page=1",
        },
        response: response(200, {
          headers: {
            link: '<https://api.github.com/repos/acme/widgets/issues?per_page=1&page=2>; rel="next"',
          },
          body: [1],
          bodyBytes: 3,
        }),
      },
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues?per_page=1&page=2",
        },
        response: response(200, { body: [2], bodyBytes: 3 }),
      },
    ]);
    const result = await readRestCollection(transport, {
      resource: "/repos/acme/widgets/issues?per_page=1",
      maxTotalBytes: 5,
    });
    expect(result).toMatchObject({
      outcome: "UNKNOWN",
      reason: "BOUNDS_EXCEEDED",
      requests: 2,
      data: [1],
    });
    transport.assertDrained();
  });

  it("rejects an off-origin pagination link without following it", async () => {
    const transport = createReplayTransport([
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues",
        },
        response: response(200, {
          headers: {
            link: '<https://example.com/collect?token=secret>; rel="next"',
          },
          body: [],
          bodyBytes: 2,
        }),
      },
    ]);
    const result = await readRestCollection(transport, {
      resource: "/repos/acme/widgets/issues",
    });
    expect(result).toMatchObject({
      outcome: "UNKNOWN",
      reason: "PROTOCOL_ERROR",
      requests: 1,
    });
    transport.assertDrained();
  });

  it("rejects response bodies and configuration beyond hard bounds", async () => {
    const transport = createReplayTransport([
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues",
        },
        response: response(200, { body: [], bodyBytes: 9 }),
      },
    ]);
    await expect(
      readRestCollection(transport, {
        resource: "/repos/acme/widgets/issues",
        maxPages: 101,
      }),
    ).rejects.toThrow(/maxPages/u);
    const result = await readRestCollection(transport, {
      resource: "/repos/acme/widgets/issues",
      maxResponseBytes: 8,
    });
    expect(result).toMatchObject({
      outcome: "UNKNOWN",
      reason: "BOUNDS_EXCEEDED",
      requests: 1,
    });

    await expect(
      readGraphql(createReplayTransport([]), {
        query: "query Viewer { viewer { login } }",
        variables: { payload: "larger than one byte" },
        maxRequestBytes: 1,
      }),
    ).rejects.toThrow(/maxRequestBytes/u);
  });

  it("treats a retry-after 403 as transient secondary rate limiting", async () => {
    const transport = createReplayTransport([
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues",
        },
        response: response(403, {
          headers: { "retry-after": "9" },
          body: { message: "secondary rate limit" },
          bodyBytes: 34,
        }),
      },
    ]);
    const result = await readRestCollection(transport, {
      resource: "/repos/acme/widgets/issues",
    });
    expect(result).toMatchObject({
      outcome: "UNKNOWN",
      reason: "RATE_LIMITED",
      requests: 1,
      rateLimit: { retryAfterSeconds: 9 },
    });
    transport.assertDrained();
  });

  it("rejects a malformed GraphQL errors envelope", async () => {
    const transport = createReplayTransport([
      {
        request: { method: "POST", resource: "/graphql" },
        response: response(200, {
          body: { data: { viewer: null }, errors: "not-an-array" },
          bodyBytes: 53,
        }),
      },
    ]);
    const result = await readGraphql(transport, {
      query: "query Viewer { viewer { login } }",
    });
    expect(result).toMatchObject({
      outcome: "UNKNOWN",
      reason: "PROTOCOL_ERROR",
      requests: 1,
      data: null,
    });
    transport.assertDrained();
  });

  it("keeps auth outside the replay request and detects request drift", async () => {
    const transport = createReplayTransport([
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues",
          headers: { "x-github-api-version": GITHUB_API_VERSION },
        },
        response: response(200, { body: [], bodyBytes: 2 }),
      },
    ]);
    await expect(
      transport.execute({
        method: "GET",
        resource: "/repos/acme/widgets/pulls",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": GITHUB_API_VERSION,
        },
        body: null,
      }),
    ).rejects.toThrow(/replay mismatch/u);
    expect(transport.consumed()).toBe(0);

    const result = await readRestCollection(transport, {
      resource: "/repos/acme/widgets/issues",
    });
    expect(result.outcome).toBe("OK");
    transport.assertDrained();
  });

  it("rejects absolute, protocol-relative, fragment, and newline resources", async () => {
    const transport = createReplayTransport([]);
    for (const resource of [
      "https://api.github.com/repos/acme/widgets/issues",
      "//example.com/collect",
      "/repos/acme/widgets/issues#fragment",
      "/repos/acme/widgets/issues\nmalformed",
    ]) {
      await expect(
        readRestCollection(transport, { resource }),
        resource,
      ).rejects.toThrow(/origin-relative/u);
    }
    expect(transport.consumed()).toBe(0);
  });
});
