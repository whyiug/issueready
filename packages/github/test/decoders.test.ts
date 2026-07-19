import { describe, expect, it } from "vitest";

import {
  compareGithubIssueCacheIdentity,
  decodeGraphqlIssueTypeResult,
  decodeIssueFieldValuesResult,
  decodeRestIssueListResult,
  decodeRestIssueResult,
  GITHUB_API_VERSION,
  GITHUB_ISSUE_TYPE_QUERY,
  githubIssueCacheIdentity,
  type GithubIssueIdentityObservation,
  type GithubReadResult,
} from "../src/read/index.js";

const rateLimit = {
  limit: 5000,
  remaining: 4999,
  resetAt: "2026-07-18T21:00:00.000Z",
  retryAfterSeconds: null,
} as const;

function ok(data: unknown): GithubReadResult<unknown> {
  return {
    outcome: "OK",
    data,
    requests: 1,
    etag: '"decoder-etag"',
    rateLimit,
  };
}

function partial(data: unknown): GithubReadResult<unknown> {
  return {
    outcome: "UNKNOWN",
    reason: "PARTIAL_RESPONSE",
    data,
    requests: 1,
    etag: null,
    rateLimit,
  };
}

function issue(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: 101,
    node_id: "I_issue-101",
    html_url: "https://github.com/acme/widgets/issues/42",
    number: 42,
    state: "open",
    title: "Bound the decoder",
    body: "Authorization: Bearer should-never-reach-normalized-data",
    user: { login: "private-user" },
    labels: [{ name: "private-label" }],
    ...overrides,
  };
}

describe("bounded GitHub endpoint payload decoders", () => {
  it("projects only the minimal issue relationship shape", () => {
    const result = decodeRestIssueResult(ok(issue()));
    expect(result).toEqual({
      outcome: "OK",
      data: {
        id: 101,
        nodeId: "I_issue-101",
        url: "https://github.com/acme/widgets/issues/42",
        owner: "acme",
        repository: "widgets",
        number: 42,
        kind: "ISSUE",
        state: "open",
        title: "Bound the decoder",
      },
      requests: 1,
      etag: '"decoder-etag"',
      rateLimit,
    });
    expect(JSON.stringify(result)).not.toContain("should-never");
    expect(JSON.stringify(result)).not.toContain("private-user");
    expect(JSON.stringify(result)).not.toContain("private-label");
  });

  it("distinguishes pull request relationship objects", () => {
    const result = decodeRestIssueResult(
      ok(
        issue({
          html_url: "https://github.com/acme/widgets/pull/42",
          pull_request: {
            url: "https://api.github.com/repos/acme/widgets/pulls/42",
          },
        }),
      ),
    );
    expect(result).toMatchObject({
      outcome: "OK",
      data: { kind: "PULL_REQUEST", number: 42 },
    });
  });

  it.each([
    ["URL and number disagree", issue({ number: 43 })],
    ["URL points off GitHub", issue({ html_url: "https://example.com/42" })],
    ["pull marker and URL disagree", issue({ pull_request: {} })],
    ["node ID is absent", issue({ node_id: "" })],
    ["database ID is unsafe", issue({ id: Number.MAX_SAFE_INTEGER + 1 })],
  ])("downgrades malformed issue payloads: %s", (_name, payload) => {
    expect(decodeRestIssueResult(ok(payload))).toMatchObject({
      outcome: "UNKNOWN",
      reason: "PROTOCOL_ERROR",
      data: null,
      requests: 1,
    });
  });

  it("rejects duplicate and over-bound relationship collections", () => {
    expect(decodeRestIssueListResult(ok([issue(), issue()]))).toMatchObject({
      outcome: "UNKNOWN",
      reason: "PROTOCOL_ERROR",
      data: null,
    });
    expect(
      decodeRestIssueListResult(
        ok(
          Array.from({ length: 101 }, (_, offset) =>
            issue({
              id: offset + 1,
              node_id: `I_${offset + 1}`,
              html_url: `https://github.com/acme/widgets/issues/${offset + 1}`,
              number: offset + 1,
            }),
          ),
        ),
      ),
    ).toMatchObject({
      outcome: "UNKNOWN",
      reason: "PROTOCOL_ERROR",
      data: null,
    });
  });

  it("decodes all documented issue field value variants", () => {
    const result = decodeIssueFieldValuesResult(
      ok([
        {
          issue_field_id: 1,
          issue_field_name: "DRI",
          node_id: "IFT_DRI",
          data_type: "text",
          value: "maintainer",
        },
        {
          issue_field_id: 2,
          issue_field_name: "Priority",
          node_id: "IFSS_PRIORITY",
          data_type: "single_select",
          value: 7,
          single_select_option: { id: 7, name: "High", color: "red" },
        },
        {
          issue_field_id: 3,
          issue_field_name: "Points",
          node_id: "IFN_POINTS",
          data_type: "number",
          value: 42,
        },
        {
          issue_field_id: 4,
          issue_field_name: "Due Date",
          node_id: "IFD_DUE",
          data_type: "date",
          value: "2026-07-31",
        },
        {
          issue_field_id: 5,
          issue_field_name: "Area",
          node_id: "IFMS_AREA",
          data_type: "multi_select",
          value: "CLI,Docs",
          multi_select_options: [
            { id: 10, name: "CLI", color: "blue" },
            { id: 11, name: "Docs", color: "green" },
          ],
        },
      ]),
    );
    expect(result).toMatchObject({
      outcome: "OK",
      data: [
        { id: 1, dataType: "text", value: "maintainer" },
        {
          id: 2,
          dataType: "single_select",
          singleSelectOption: { id: 7, name: "High", color: "red" },
        },
        { id: 3, dataType: "number", value: 42 },
        { id: 4, dataType: "date", value: "2026-07-31" },
        {
          id: 5,
          dataType: "multi_select",
          multiSelectOptions: [
            { id: 10, name: "CLI", color: "blue" },
            { id: 11, name: "Docs", color: "green" },
          ],
        },
      ],
    });
  });

  it.each([
    [
      "unknown data type",
      {
        issue_field_id: 1,
        issue_field_name: "Future",
        node_id: "IF_FUTURE",
        data_type: "future_type",
        value: "x",
      },
    ],
    [
      "value type mismatch",
      {
        issue_field_id: 1,
        issue_field_name: "Points",
        node_id: "IF_POINTS",
        data_type: "number",
        value: "forty-two",
      },
    ],
    [
      "missing select option",
      {
        issue_field_id: 1,
        issue_field_name: "Priority",
        node_id: "IF_PRIORITY",
        data_type: "single_select",
        value: 7,
      },
    ],
    [
      "select value and option disagree",
      {
        issue_field_id: 1,
        issue_field_name: "Priority",
        node_id: "IF_PRIORITY",
        data_type: "single_select",
        value: 7,
        single_select_option: { id: 8, name: "Low", color: "blue" },
      },
    ],
  ])("rejects malformed field data: %s", (_name, field) => {
    expect(decodeIssueFieldValuesResult(ok([field]))).toMatchObject({
      outcome: "UNKNOWN",
      reason: "PROTOCOL_ERROR",
      data: null,
    });
  });

  it("decodes the adapter-owned GraphQL current Issue Type shape", () => {
    expect(GITHUB_ISSUE_TYPE_QUERY).toContain("issueType");
    expect(GITHUB_ISSUE_TYPE_QUERY).toContain("isEnabled");
    expect(GITHUB_ISSUE_TYPE_QUERY).not.toContain("isPrivate");
    expect(
      decodeGraphqlIssueTypeResult(
        ok({
          repository: {
            issue: {
              issueType: {
                id: "IT_bug",
                name: "Bug",
                description: "Unexpected behavior",
                color: "RED",
                isEnabled: true,
                isPrivate: false,
              },
            },
          },
        }),
      ),
    ).toMatchObject({
      outcome: "OK",
      data: {
        id: "IT_bug",
        name: "Bug",
        description: "Unexpected behavior",
        color: "RED",
        isEnabled: true,
      },
    });
    expect(
      decodeGraphqlIssueTypeResult(
        ok({ repository: { issue: { issueType: null } } }),
      ),
    ).toMatchObject({ outcome: "OK", data: null });
  });

  it("rejects malformed or compatibility-unknown Issue Type fields", () => {
    for (const data of [
      { repository: null },
      { repository: { issue: null } },
      {
        repository: {
          issue: {
            issueType: {
              id: "IT_bug",
              name: "Bug",
              description: null,
              color: "FUTURE_COLOR",
              isEnabled: true,
            },
          },
        },
      },
    ]) {
      expect(decodeGraphqlIssueTypeResult(ok(data))).toMatchObject({
        outcome: "UNKNOWN",
        reason: "PROTOCOL_ERROR",
        data: null,
      });
    }
  });

  it("retains valid partial data without upgrading provider uncertainty", () => {
    expect(decodeRestIssueListResult(partial([issue()]))).toMatchObject({
      outcome: "UNKNOWN",
      reason: "PARTIAL_RESPONSE",
      data: [{ nodeId: "I_issue-101", number: 42 }],
    });
    expect(decodeRestIssueListResult(partial(["malformed"]))).toMatchObject({
      outcome: "UNKNOWN",
      reason: "PROTOCOL_ERROR",
      data: null,
    });
  });

  it("preserves non-data outcomes and their metadata", () => {
    const unavailable = {
      outcome: "UNAVAILABLE",
      reason: "PERMISSION_DENIED",
      data: null,
      requests: 2,
      etag: null,
      rateLimit,
    } as const;
    expect(decodeRestIssueListResult(unavailable)).toBe(unavailable);

    const rateLimited = {
      outcome: "UNKNOWN",
      reason: "RATE_LIMITED",
      data: null,
      requests: 1,
      etag: null,
      rateLimit,
    } as const;
    expect(decodeIssueFieldValuesResult(rateLimited)).toStrictEqual(
      rateLimited,
    );
  });
});

describe("GitHub repository transfer and cache identity", () => {
  const original: GithubIssueIdentityObservation = {
    repositoryNodeId: "R_repo-a",
    issueNodeId: "I_issue-42",
    owner: "acme",
    repository: "widgets",
    number: 42,
    apiVersion: GITHUB_API_VERSION,
  };

  it("uses stable node IDs separately from the mutable locator", () => {
    const identity = githubIssueCacheIdentity(original);
    expect(identity).toEqual({
      issueKey: 'github-issue:["I_issue-42"]',
      repositoryKey: 'github-repository:["R_repo-a"]',
      locatorKey: 'github-locator:["acme","widgets","42"]',
      etagKey: 'github-etag:["acme","widgets","42","2026-03-10"]',
    });
    expect(
      githubIssueCacheIdentity({
        ...original,
        owner: "ACME",
        repository: "Widgets",
      }),
    ).toEqual(identity);
    expect(
      compareGithubIssueCacheIdentity(original, {
        ...original,
        owner: "ACME",
        repository: "Widgets",
      }),
    ).toEqual({
      sameIssue: true,
      sameRepository: true,
      sameApiVersion: true,
      locatorChanged: false,
      reuseEntityCache: true,
      reuseEtag: true,
    });
  });

  it("invalidates locator ETags after repository rename or owner transfer", () => {
    expect(
      compareGithubIssueCacheIdentity(original, {
        ...original,
        owner: "community",
        repository: "widgets-next",
      }),
    ).toEqual({
      sameIssue: true,
      sameRepository: true,
      sameApiVersion: true,
      locatorChanged: true,
      reuseEntityCache: true,
      reuseEtag: false,
    });
  });

  it("preserves Issue identity but invalidates repository and ETag caches after Issue transfer", () => {
    expect(
      compareGithubIssueCacheIdentity(original, {
        repositoryNodeId: "R_repo-b",
        issueNodeId: original.issueNodeId,
        owner: "community",
        repository: "backlog",
        number: 7,
        apiVersion: GITHUB_API_VERSION,
      }),
    ).toEqual({
      sameIssue: true,
      sameRepository: false,
      sameApiVersion: true,
      locatorChanged: true,
      reuseEntityCache: true,
      reuseEtag: false,
    });
  });

  it("never reuses entity data when the Issue node ID changes", () => {
    expect(
      compareGithubIssueCacheIdentity(original, {
        ...original,
        issueNodeId: "I_replacement",
      }),
    ).toEqual({
      sameIssue: false,
      sameRepository: true,
      sameApiVersion: true,
      locatorChanged: false,
      reuseEntityCache: false,
      reuseEtag: false,
    });
  });

  it("invalidates decoded entity data and ETags when the API version changes", () => {
    expect(
      compareGithubIssueCacheIdentity(original, {
        ...original,
        apiVersion: "2022-11-28",
      }),
    ).toEqual({
      sameIssue: true,
      sameRepository: true,
      sameApiVersion: false,
      locatorChanged: false,
      reuseEntityCache: false,
      reuseEtag: false,
    });
  });

  it("rejects malformed identities before constructing cache keys", () => {
    expect(() =>
      githubIssueCacheIdentity({ ...original, owner: "bad/owner" }),
    ).toThrow(/path segment/u);
    expect(() =>
      githubIssueCacheIdentity({ ...original, issueNodeId: "" }),
    ).toThrow(/node ID/u);
    expect(() => githubIssueCacheIdentity({ ...original, number: 0 })).toThrow(
      /positive safe integer/u,
    );
    expect(() =>
      githubIssueCacheIdentity({ ...original, apiVersion: "" }),
    ).toThrow(/version identifier/u);
  });
});
