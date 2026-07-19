import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createCredentialedGithubTransport,
  GITHUB_API_VERSION,
  readGraphql,
  readRestResource,
  type GithubCredentialContext,
  type GithubReplayRequest,
} from "../src/read/index.js";
import {
  createGithubHttpExecutor,
  GithubHttpExecutorError,
} from "../src/live/index.js";

function request(
  overrides: Partial<GithubReplayRequest> = {},
): GithubReplayRequest {
  return {
    method: "GET",
    resource: "/repos/acme/widgets/issues/42",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
    },
    body: null,
    ...overrides,
  };
}

function context(
  credential = "synthetic-http-secret",
): GithubCredentialContext {
  return { credential, signal: new AbortController().signal };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

describe("GitHub-only live HTTP executor", () => {
  it("keeps credential discovery, subprocesses, logging, and alternate hosts outside the module", () => {
    const source = readFileSync(
      new URL("../src/live/index.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "process.env",
      "node:child_process",
      "console.",
      'redirect: "follow"',
      "api.github.com.evil",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("injects the final header, uses manual redirects, and filters response headers", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> =
      [];
    const signal = new AbortController().signal;
    const executor = createGithubHttpExecutor({
      fetch: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return jsonResponse(
          { id: 42 },
          {
            headers: {
              etag: '"issue-v2"',
              "x-ratelimit-remaining": "4998",
              "set-cookie": "must-not-leave-http-boundary=secret",
            },
          },
        );
      },
    });
    const result = await executor.execute(request(), {
      credential: "synthetic-http-secret",
      signal,
    });
    expect(result).toEqual({
      status: 200,
      headers: { etag: '"issue-v2"', "x-ratelimit-remaining": "4998" },
      body: { id: 42 },
      bodyBytes: 9,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(
      "https://api.github.com/repos/acme/widgets/issues/42",
    );
    expect(call?.init).toMatchObject({
      method: "GET",
      redirect: "manual",
      signal,
      body: null,
    });
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-http-secret");
    expect(headers.get("x-github-api-version")).toBe(GITHUB_API_VERSION);
    expect(headers.get("user-agent")).toBe("IssueReady/0.0.0");
    expect(JSON.stringify(result)).not.toContain("synthetic-http-secret");
    expect(JSON.stringify(result)).not.toContain("set-cookie");
  });

  it("adds JSON content type for a bounded GraphQL POST", async () => {
    const observed: { init?: RequestInit } = {};
    const executor = createGithubHttpExecutor({
      fetch: async (_input, init = {}) => {
        observed.init = init;
        return jsonResponse({ data: { viewer: { login: "octocat" } } });
      },
    });
    const body = JSON.stringify({
      query: "query Viewer { viewer { login } }",
      variables: {},
    });
    await executor.execute(
      request({ method: "POST", resource: "/graphql", body }),
      context(),
    );
    expect(observed.init).toMatchObject({ method: "POST", body });
    expect(new Headers(observed.init?.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("composes with the credential boundary and manual transfer handling", async () => {
    const calls: Array<{ readonly url: string; readonly credential: string }> =
      [];
    const responses = [
      new Response(JSON.stringify({ message: "Moved Permanently" }), {
        status: 301,
        headers: {
          location: "https://api.github.com/repos/community/widgets/issues/7",
        },
      }),
      jsonResponse({ id: 42 }),
    ];
    const executor = createGithubHttpExecutor({
      fetch: async (input, init = {}) => {
        calls.push({
          url: String(input),
          credential: new Headers(init.headers).get("authorization") ?? "",
        });
        const response = responses.shift();
        if (response === undefined) throw new Error("response exhausted");
        return response;
      },
    });
    let credentialResolutions = 0;
    const transport = createCredentialedGithubTransport({
      credentialProvider: () => {
        credentialResolutions += 1;
        return `synthetic-transfer-secret-${credentialResolutions}`;
      },
      executor,
    });
    await expect(
      readRestResource(transport, {
        resource: "/repos/acme/widgets/issues/42",
        etag: '"old-locator"',
      }),
    ).resolves.toMatchObject({ outcome: "OK", requests: 2, data: { id: 42 } });
    expect(credentialResolutions).toBe(2);
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/acme/widgets/issues/42",
        credential: "Bearer synthetic-transfer-secret-1",
      },
      {
        url: "https://api.github.com/repos/community/widgets/issues/7",
        credential: "Bearer synthetic-transfer-secret-2",
      },
    ]);
  });

  it("composes with GraphQL response classification", async () => {
    const executor = createGithubHttpExecutor({
      fetch: async () =>
        jsonResponse({
          data: { repository: { issue: null } },
          errors: [{ message: "not visible" }],
        }),
    });
    const transport = createCredentialedGithubTransport({
      credentialProvider: () => "synthetic-graphql-secret",
      executor,
    });
    await expect(
      readGraphql(transport, {
        query: 'query Issue { repository(owner: "a", name: "b") { id } }',
      }),
    ).resolves.toMatchObject({
      outcome: "UNKNOWN",
      reason: "PARTIAL_RESPONSE",
      data: { repository: { issue: null } },
    });
  });

  it.each([
    ["absolute URL", request({ resource: "https://example.com/collect" })],
    ["protocol-relative URL", request({ resource: "//example.com/collect" })],
    ["GET body", request({ body: "unexpected" })],
    ["POST without body", request({ method: "POST", body: null })],
    [
      "unapproved header",
      request({ headers: { ...request().headers, cookie: "secret=1" } }),
    ],
    [
      "pre-injected credential header",
      request({
        headers: {
          ...request().headers,
          authorization: "Bearer caller-secret",
        },
      }),
    ],
    [
      "duplicate case-insensitive header",
      request({
        headers: {
          ...request().headers,
          Accept: "application/vnd.github+json",
        },
      }),
    ],
    ["missing required headers", request({ headers: {} })],
    [
      "credential copied into resource",
      request({ resource: "/repos/synthetic-http-secret/widgets" }),
    ],
  ])("rejects an invalid request: %s", async (_name, invalid) => {
    let calls = 0;
    const executor = createGithubHttpExecutor({
      fetch: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    await expect(executor.execute(invalid, context())).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(calls).toBe(0);
  });

  it.each(["", " leading", "trailing ", "line\nbreak"])(
    "rejects a malformed credential",
    async (credential) => {
      const executor = createGithubHttpExecutor({
        fetch: async () => jsonResponse({}),
      });
      await expect(
        executor.execute(request(), context(credential)),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
    },
  );

  it("enforces request and streamed response byte bounds", async () => {
    const requestBound = createGithubHttpExecutor({
      maxRequestBytes: 8,
      fetch: async () => jsonResponse({}),
    });
    await expect(
      requestBound.execute(
        request({ method: "POST", resource: "/graphql", body: "123456789" }),
        context(),
      ),
    ).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });

    const responseBound = createGithubHttpExecutor({
      maxResponseBytes: 8,
      fetch: async () => new Response("123456789"),
    });
    await expect(
      responseBound.execute(request(), context()),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });

    const declaredResponseBound = createGithubHttpExecutor({
      maxResponseBytes: 8,
      fetch: async () =>
        new Response("small", { headers: { "content-length": "9" } }),
    });
    await expect(
      declaredResponseBound.execute(request(), context()),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("returns byte metadata but not raw text for malformed JSON", async () => {
    const executor = createGithubHttpExecutor({
      fetch: async () => new Response("not-json", { status: 502 }),
    });
    await expect(executor.execute(request(), context())).resolves.toEqual({
      status: 502,
      headers: {},
      body: null,
      bodyBytes: 8,
    });
  });

  it("replaces fetch and stream failures with fixed diagnostics", async () => {
    const secret = "synthetic-network-secret";
    const executor = createGithubHttpExecutor({
      fetch: async () => {
        throw new Error(secret);
      },
    });
    const error: unknown = await executor.execute(request(), context()).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GithubHttpExecutorError);
    if (!(error instanceof GithubHttpExecutorError)) return;
    expect(error.code).toBe("NETWORK_FAILURE");
    expect(error.message).not.toContain(secret);
  });

  it("rejects configuration beyond hard byte bounds", () => {
    expect(() =>
      createGithubHttpExecutor({ maxRequestBytes: 1_048_577 }),
    ).toThrow(/maxRequestBytes/u);
    expect(() =>
      createGithubHttpExecutor({ maxResponseBytes: 33_554_433 }),
    ).toThrow(/maxResponseBytes/u);
  });
});
