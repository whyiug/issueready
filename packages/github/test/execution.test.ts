import { describe, expect, it } from "vitest";

import {
  createCredentialedGithubTransport,
  createReplayTransport,
  executeGithubReadWithRetry,
  GITHUB_API_VERSION,
  GithubTransportBoundaryError,
  readRestCollection,
  readRestResource,
  type GithubCredentialContext,
  type GithubRateLimitState,
  type GithubReadResult,
  type GithubReplayRequest,
  type GithubReplayResponse,
  type GithubTimer,
} from "../src/read/index.js";

const rateLimit = {
  limit: 5000,
  remaining: 4999,
  resetAt: "2026-07-18T21:00:00.000Z",
  retryAfterSeconds: null,
} as const;

function response(
  status: number,
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly bodyBytes?: number;
  } = {},
): GithubReplayResponse {
  return {
    status,
    headers: options.headers ?? {},
    body: options.body ?? null,
    bodyBytes: options.bodyBytes ?? 4,
  };
}

function ok<Value>(data: Value): GithubReadResult<Value> {
  return {
    outcome: "OK",
    data,
    requests: 1,
    etag: null,
    rateLimit,
  };
}

function unknown(
  reason: "RATE_LIMITED" | "SERVER_ERROR" | "PARTIAL_RESPONSE",
  overrideRateLimit: Partial<GithubRateLimitState> = {},
): GithubReadResult<never> {
  return {
    outcome: "UNKNOWN",
    reason,
    data: null,
    requests: 1,
    etag: null,
    rateLimit: { ...rateLimit, ...overrideRateLimit },
  };
}

describe("single-resource REST replay and redirects", () => {
  it("reads one bounded resource with ETag and rate metadata", async () => {
    const transport = createReplayTransport([
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues/42",
          headers: {
            "if-none-match": '"issue-v1"',
            "x-github-api-version": GITHUB_API_VERSION,
          },
        },
        response: response(200, {
          headers: {
            etag: '"issue-v2"',
            "x-ratelimit-remaining": "4998",
          },
          body: { id: 42 },
          bodyBytes: 9,
        }),
      },
    ]);
    await expect(
      readRestResource(transport, {
        resource: "/repos/acme/widgets/issues/42",
        etag: '"issue-v1"',
      }),
    ).resolves.toMatchObject({
      outcome: "OK",
      data: { id: 42 },
      requests: 1,
      etag: '"issue-v2"',
      rateLimit: { remaining: 4998 },
    });
    transport.assertDrained();
  });

  it("preserves a first-response 304 without decoding a body", async () => {
    const transport = createReplayTransport([
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues/42",
          headers: { "if-none-match": '"issue-v1"' },
        },
        response: response(304, {
          headers: { etag: '"issue-v1"' },
          body: null,
          bodyBytes: 4,
        }),
      },
    ]);
    await expect(
      readRestResource(transport, {
        resource: "/repos/acme/widgets/issues/42",
        etag: '"issue-v1"',
      }),
    ).resolves.toMatchObject({
      outcome: "NOT_MODIFIED",
      data: null,
      requests: 1,
      etag: '"issue-v1"',
    });
    transport.assertDrained();
  });

  it("follows one same-origin repository-transfer redirect without forwarding the old ETag", async () => {
    const transport = createReplayTransport([
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues/42",
          headers: { "if-none-match": '"old-locator"' },
        },
        response: response(301, {
          headers: {
            location: "https://api.github.com/repos/community/widgets/issues/7",
          },
          body: { message: "Moved Permanently" },
          bodyBytes: 31,
        }),
      },
      {
        request: {
          method: "GET",
          resource: "/repos/community/widgets/issues/7",
        },
        response: response(200, { body: { id: 42 }, bodyBytes: 9 }),
      },
    ]);
    await expect(
      readRestResource(transport, {
        resource: "/repos/acme/widgets/issues/42",
        etag: '"old-locator"',
      }),
    ).resolves.toMatchObject({ outcome: "OK", requests: 2, data: { id: 42 } });
    transport.assertDrained();
  });

  it("uses the redirected collection pathname for subsequent pagination", async () => {
    const transport = createReplayTransport([
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues/42/sub_issues?per_page=1",
        },
        response: response(301, {
          headers: {
            location:
              "https://api.github.com/repos/community/widgets/issues/7/sub_issues?per_page=1",
          },
          body: null,
          bodyBytes: 4,
        }),
      },
      {
        request: {
          method: "GET",
          resource: "/repos/community/widgets/issues/7/sub_issues?per_page=1",
        },
        response: response(200, {
          headers: {
            link: '<https://api.github.com/repos/community/widgets/issues/7/sub_issues?per_page=1&page=2>; rel="next"',
          },
          body: [{ id: 1 }],
          bodyBytes: 10,
        }),
      },
      {
        request: {
          method: "GET",
          resource:
            "/repos/community/widgets/issues/7/sub_issues?per_page=1&page=2",
        },
        response: response(200, { body: [{ id: 2 }], bodyBytes: 10 }),
      },
    ]);
    await expect(
      readRestCollection(transport, {
        resource: "/repos/acme/widgets/issues/42/sub_issues?per_page=1",
      }),
    ).resolves.toMatchObject({
      outcome: "OK",
      requests: 3,
      data: [{ id: 1 }, { id: 2 }],
    });
    transport.assertDrained();
  });

  it.each([
    ["off-origin", "https://example.com/collect"],
    ["credential-bearing", "https://user:pass@api.github.com/repos/x/y"],
    ["fragment-bearing", "https://api.github.com/repos/x/y#fragment"],
    ["protocol-relative path", "https://api.github.com//example.com/collect"],
  ])("rejects a %s redirect", async (_name, location) => {
    const transport = createReplayTransport([
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues/42",
        },
        response: response(301, {
          headers: { location },
          body: null,
          bodyBytes: 4,
        }),
      },
    ]);
    await expect(
      readRestResource(transport, {
        resource: "/repos/acme/widgets/issues/42",
      }),
    ).resolves.toMatchObject({
      outcome: "UNKNOWN",
      reason: "PROTOCOL_ERROR",
      requests: 1,
    });
    transport.assertDrained();
  });

  it("stops a redirect loop and enforces aggregate body bounds", async () => {
    const looping = createReplayTransport([
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues/42",
        },
        response: response(301, {
          headers: {
            location: "https://api.github.com/repos/acme/widgets/issues/42",
          },
          body: null,
          bodyBytes: 4,
        }),
      },
    ]);
    await expect(
      readRestResource(looping, {
        resource: "/repos/acme/widgets/issues/42",
      }),
    ).resolves.toMatchObject({
      outcome: "UNKNOWN",
      reason: "BOUNDS_EXCEEDED",
      requests: 1,
    });
    looping.assertDrained();

    const oversized = createReplayTransport([
      {
        request: {
          method: "GET",
          resource: "/repos/acme/widgets/issues/42",
        },
        response: response(200, { body: { id: 42 }, bodyBytes: 9 }),
      },
    ]);
    await expect(
      readRestResource(oversized, {
        resource: "/repos/acme/widgets/issues/42",
        maxTotalBytes: 8,
      }),
    ).resolves.toMatchObject({
      outcome: "UNKNOWN",
      reason: "BOUNDS_EXCEEDED",
      data: null,
    });
    oversized.assertDrained();
  });
});

describe("credential and timeout transport boundary", () => {
  const request: GithubReplayRequest = {
    method: "GET",
    resource: "/repos/acme/widgets/issues/42",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
    },
    body: null,
  };

  it("injects a credential only into the final executor context", async () => {
    const secret = "synthetic-boundary-secret";
    const observed: {
      request?: GithubReplayRequest;
      context?: GithubCredentialContext;
    } = {};
    const transport = createCredentialedGithubTransport({
      credentialProvider: () => secret,
      executor: {
        async execute(incoming, context) {
          observed.request = incoming;
          observed.context = context;
          return response(200, { body: { id: 42 }, bodyBytes: 9 });
        },
      },
    });
    await expect(transport.execute(request)).resolves.toMatchObject({
      status: 200,
    });
    expect(observed.request).toEqual(request);
    expect(JSON.stringify(observed.request)).not.toContain(secret);
    expect(observed.context).toMatchObject({ credential: secret });
    expect(observed.context?.signal.aborted).toBe(false);
  });

  it("resolves credentials for each request instead of retaining them", async () => {
    let resolutions = 0;
    const observedCredentials: string[] = [];
    const transport = createCredentialedGithubTransport({
      credentialProvider: () => {
        resolutions += 1;
        return `synthetic-secret-${resolutions}`;
      },
      executor: {
        async execute(_incoming, context) {
          observedCredentials.push(context.credential);
          return response(200);
        },
      },
    });
    await transport.execute(request);
    await transport.execute(request);
    expect(resolutions).toBe(2);
    expect(observedCredentials).toEqual([
      "synthetic-secret-1",
      "synthetic-secret-2",
    ]);
  });

  it("replaces credential-provider and executor errors with fixed diagnostics", async () => {
    const secret = "synthetic-provider-secret";
    const credentialFailure = createCredentialedGithubTransport({
      credentialProvider: () => {
        throw new Error(secret);
      },
      executor: {
        async execute() {
          throw new Error("must not execute");
        },
      },
    });
    const executorFailure = createCredentialedGithubTransport({
      credentialProvider: () => secret,
      executor: {
        async execute() {
          throw new Error(`response leaked ${secret}`);
        },
      },
    });
    for (const [transport, code] of [
      [credentialFailure, "CREDENTIAL_UNAVAILABLE"],
      [executorFailure, "EXECUTOR_FAILURE"],
    ] as const) {
      const error: unknown = await transport.execute(request).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(GithubTransportBoundaryError);
      if (!(error instanceof GithubTransportBoundaryError)) return;
      expect(error.code).toBe(code);
      expect(error.message).not.toContain(secret);
    }
  });

  it.each(["", " leading", "trailing ", "line\nbreak"])(
    "rejects a malformed credential without calling the executor",
    async (credential) => {
      let executions = 0;
      const transport = createCredentialedGithubTransport({
        credentialProvider: () => credential,
        executor: {
          async execute() {
            executions += 1;
            return response(200);
          },
        },
      });
      await expect(transport.execute(request)).rejects.toMatchObject({
        code: "CREDENTIAL_UNAVAILABLE",
      });
      expect(executions).toBe(0);
    },
  );

  it("aborts and returns a fixed error when the total request boundary times out", async () => {
    let cancelled = false;
    const observed: {
      scheduled?: () => void;
      context?: GithubCredentialContext;
    } = {};
    const timer: GithubTimer = {
      schedule(callback) {
        observed.scheduled = callback;
        return "timer-handle";
      },
      cancel(handle) {
        expect(handle).toBe("timer-handle");
        cancelled = true;
      },
    };
    const transport = createCredentialedGithubTransport({
      credentialProvider: () => "synthetic-timeout-secret",
      timeoutMs: 10,
      timer,
      executor: {
        execute(_incoming, incomingContext) {
          observed.context = incomingContext;
          return new Promise((_resolve, reject) => {
            incomingContext.signal.addEventListener("abort", () => {
              reject(new Error("synthetic-timeout-secret"));
            });
          });
        },
      },
    });
    const pending = transport.execute(request);
    await Promise.resolve();
    await Promise.resolve();
    expect(observed.scheduled).toBeDefined();
    observed.scheduled?.();
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(observed.context?.signal.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("applies the same timeout to credential resolution", async () => {
    const observed: { scheduled?: () => void } = {};
    let executions = 0;
    const transport = createCredentialedGithubTransport({
      credentialProvider: () => new Promise<string>(() => undefined),
      timeoutMs: 10,
      timer: {
        schedule(callback) {
          observed.scheduled = callback;
          return "credential-timer";
        },
        cancel(handle) {
          expect(handle).toBe("credential-timer");
        },
      },
      executor: {
        async execute() {
          executions += 1;
          return response(200);
        },
      },
    });
    const pending = transport.execute(request);
    await Promise.resolve();
    observed.scheduled?.();
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(executions).toBe(0);
  });

  it("rejects timeout configuration beyond the frozen hard bound", () => {
    expect(() =>
      createCredentialedGithubTransport({
        credentialProvider: () => "synthetic-secret",
        timeoutMs: 120_001,
        executor: {
          async execute() {
            return response(200);
          },
        },
      }),
    ).toThrow(/timeoutMs/u);
  });
});

describe("caller-owned bounded retry scheduling", () => {
  it("retries only transient server results with bounded exponential delays", async () => {
    const results = [unknown("SERVER_ERROR"), unknown("SERVER_ERROR"), ok(42)];
    const slept: number[] = [];
    const execution = await executeGithubReadWithRetry(
      async () => results.shift() ?? ok(42),
      { sleep: async (delay) => void slept.push(delay) },
    );
    expect(execution).toEqual({
      result: ok(42),
      attempts: 3,
      delays: [1, 2],
      stopReason: "FINAL_RESULT",
    });
    expect(slept).toEqual([1, 2]);
  });

  it("respects Retry-After and reset timestamps without real sleeping", async () => {
    const retryAfterResults = [
      unknown("RATE_LIMITED", { remaining: 0, retryAfterSeconds: 9 }),
      ok("done"),
    ];
    const retryAfterSleeps: number[] = [];
    await expect(
      executeGithubReadWithRetry(
        async () => retryAfterResults.shift() ?? ok("done"),
        { sleep: async (delay) => void retryAfterSleeps.push(delay) },
      ),
    ).resolves.toMatchObject({ attempts: 2, delays: [9] });
    expect(retryAfterSleeps).toEqual([9]);

    const resetResults = [
      unknown("RATE_LIMITED", {
        remaining: 0,
        resetAt: "2026-07-18T21:00:07.000Z",
      }),
      ok("done"),
    ];
    await expect(
      executeGithubReadWithRetry(
        async () => resetResults.shift() ?? ok("done"),
        {
          now: () => Date.parse("2026-07-18T21:00:00.000Z"),
          sleep: async () => undefined,
        },
      ),
    ).resolves.toMatchObject({ attempts: 2, delays: [7] });
  });

  it.each([
    ok("complete"),
    {
      outcome: "UNAVAILABLE",
      reason: "PERMISSION_DENIED",
      data: null,
      requests: 1,
      etag: null,
      rateLimit,
    } as const,
    unknown("PARTIAL_RESPONSE"),
  ])(
    "does not retry a final or non-retryable provider result",
    async (result) => {
      let attempts = 0;
      const execution = await executeGithubReadWithRetry(
        async () => {
          attempts += 1;
          return result;
        },
        { sleep: async () => undefined },
      );
      expect(execution).toMatchObject({
        result,
        attempts: 1,
        delays: [],
        stopReason: "FINAL_RESULT",
      });
      expect(attempts).toBe(1);
    },
  );

  it("stops at attempt and cumulative delay bounds", async () => {
    await expect(
      executeGithubReadWithRetry(async () => unknown("SERVER_ERROR"), {
        maxAttempts: 2,
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({
      attempts: 2,
      delays: [1],
      stopReason: "ATTEMPT_BOUND",
    });

    let sleeps = 0;
    await expect(
      executeGithubReadWithRetry(
        async () =>
          unknown("RATE_LIMITED", {
            remaining: 0,
            retryAfterSeconds: 121,
          }),
        {
          maxTotalDelaySeconds: 120,
          sleep: async () => {
            sleeps += 1;
          },
        },
      ),
    ).resolves.toMatchObject({
      attempts: 1,
      delays: [],
      stopReason: "DELAY_BOUND",
    });
    expect(sleeps).toBe(0);
  });

  it("sanitizes scheduler failures and rejects configuration beyond hard bounds", async () => {
    await expect(
      executeGithubReadWithRetry(async () => unknown("SERVER_ERROR"), {
        sleep: async () => {
          throw new Error("scheduler internal details");
        },
      }),
    ).rejects.toMatchObject({ code: "SCHEDULER_FAILURE" });

    await expect(
      executeGithubReadWithRetry(async () => ok(1), {
        maxAttempts: 6,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/maxAttempts/u);
    await expect(
      executeGithubReadWithRetry(async () => ok(1), {
        maxTotalDelaySeconds: 601,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/maxTotalDelaySeconds/u);
  });
});
