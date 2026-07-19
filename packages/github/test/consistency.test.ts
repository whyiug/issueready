import { describe, expect, it } from "vitest";

import {
  evaluateGithubSourceConsistently,
  GITHUB_API_VERSION,
  type GithubSourceCapture,
  type GithubSourceRevision,
} from "../src/read/index.js";

function revision(
  overrides: Partial<GithubSourceRevision> = {},
): GithubSourceRevision {
  return {
    repositoryNodeId: "R_repo-a",
    issueNodeId: "I_issue-42",
    owner: "acme",
    repository: "widgets",
    number: 42,
    updatedAt: "2026-07-18T20:00:00.000Z",
    apiVersion: GITHUB_API_VERSION,
    etag: '"issue-v1"',
    ...overrides,
  };
}

function capture<Value>(
  data: Value,
  overrides: Partial<GithubSourceRevision> = {},
): GithubSourceCapture<Value> {
  return { revision: revision(overrides), data };
}

function sequencedCapture<Value>(
  values: readonly GithubSourceCapture<Value>[],
) {
  let cursor = 0;
  return {
    capture: async (): Promise<GithubSourceCapture<Value>> => {
      const value = values[cursor];
      if (value === undefined) throw new Error("capture sequence exhausted");
      cursor += 1;
      return value;
    },
    count: (): number => cursor,
  };
}

describe("GitHub source-change consistency", () => {
  it("returns the first evaluation after two matching observations", async () => {
    const source = sequencedCapture([
      capture({ title: "stable" }),
      capture({ title: "verification body is not evaluated" }),
    ]);
    let evaluations = 0;
    const result = await evaluateGithubSourceConsistently({
      capture: source.capture,
      evaluate: async (data) => {
        evaluations += 1;
        return data.title.toUpperCase();
      },
    });
    expect(result).toEqual({
      status: "COMPLETE",
      reason: null,
      value: "STABLE",
      revision: revision(),
      refreshed: false,
      evaluationAttempts: 1,
      sourceObservations: 2,
    });
    expect(evaluations).toBe(1);
    expect(source.count()).toBe(2);
  });

  it("refreshes exactly once and returns only the stable refreshed result", async () => {
    const refreshedRevision = {
      updatedAt: "2026-07-18T20:01:00.000Z",
      etag: '"issue-v2"',
    } as const;
    const source = sequencedCapture([
      capture({ title: "stale" }),
      capture({ title: "fresh" }, refreshedRevision),
      capture({ title: "verification body" }, refreshedRevision),
    ]);
    const evaluated: string[] = [];
    const result = await evaluateGithubSourceConsistently({
      capture: source.capture,
      evaluate: async (data) => {
        evaluated.push(data.title);
        return { evaluatedTitle: data.title };
      },
    });
    expect(result).toEqual({
      status: "COMPLETE",
      reason: null,
      value: { evaluatedTitle: "fresh" },
      revision: revision(refreshedRevision),
      refreshed: true,
      evaluationAttempts: 2,
      sourceObservations: 3,
    });
    expect(evaluated).toEqual(["stale", "fresh"]);
    expect(source.count()).toBe(3);
  });

  it("degrades after a second change and discards both potentially stale outputs", async () => {
    const source = sequencedCapture([
      capture({ generation: 1 }),
      capture(
        { generation: 2 },
        {
          updatedAt: "2026-07-18T20:01:00.000Z",
          etag: '"issue-v2"',
        },
      ),
      capture(
        { generation: 3 },
        {
          updatedAt: "2026-07-18T20:02:00.000Z",
          etag: '"issue-v3"',
        },
      ),
    ]);
    const evaluated: number[] = [];
    const result = await evaluateGithubSourceConsistently({
      capture: source.capture,
      evaluate: async (data) => {
        evaluated.push(data.generation);
        return `generation-${data.generation}`;
      },
    });
    expect(result).toEqual({
      status: "DEGRADED",
      reason: "IR-SRC-002 SOURCE_CHANGED_DURING_EVALUATION",
      value: null,
      revision: revision({
        updatedAt: "2026-07-18T20:02:00.000Z",
        etag: '"issue-v3"',
      }),
      refreshed: true,
      evaluationAttempts: 2,
      sourceObservations: 3,
    });
    expect(evaluated).toEqual([1, 2]);
    expect(JSON.stringify(result)).not.toContain("generation-1");
    expect(JSON.stringify(result)).not.toContain("generation-2");
  });

  it("treats case-only owner/repository spelling as the same locator", async () => {
    const source = sequencedCapture([
      capture({ value: 1 }),
      capture({ value: 2 }, { owner: "ACME", repository: "Widgets" }),
    ]);
    await expect(
      evaluateGithubSourceConsistently({
        capture: source.capture,
        evaluate: async (data) => data.value,
      }),
    ).resolves.toMatchObject({
      status: "COMPLETE",
      value: 1,
      refreshed: false,
      evaluationAttempts: 1,
    });
  });

  it.each([
    ["updated timestamp", { updatedAt: "2026-07-18T20:01:00.000Z" }],
    ["ETag", { etag: '"issue-v2"' }],
    ["API version", { apiVersion: "2022-11-28" }],
    ["owner transfer", { owner: "community" }],
    ["repository rename", { repository: "widgets-next" }],
    ["Issue renumber", { number: 7 }],
    ["repository identity", { repositoryNodeId: "R_repo-b" }],
    ["Issue identity", { issueNodeId: "I_issue-replacement" }],
  ] as const)("refreshes after a %s change", async (_name, changed) => {
    const source = sequencedCapture([
      capture({ value: "old" }),
      capture({ value: "new" }, changed),
      capture({ value: "verify" }, changed),
    ]);
    await expect(
      evaluateGithubSourceConsistently({
        capture: source.capture,
        evaluate: async (data) => data.value,
      }),
    ).resolves.toMatchObject({
      status: "COMPLETE",
      value: "new",
      refreshed: true,
      evaluationAttempts: 2,
      sourceObservations: 3,
    });
  });

  it("clones captured data before evaluation", async () => {
    const first = capture({ nested: { value: "original" } });
    const source = sequencedCapture([
      first,
      capture({ nested: { value: "verification" } }),
    ]);
    await evaluateGithubSourceConsistently({
      capture: source.capture,
      evaluate: async (data) => {
        data.nested.value = "mutated";
        return data.nested.value;
      },
    });
    expect(first.data.nested.value).toBe("original");
  });

  it.each([
    ["invalid updatedAt", { updatedAt: "not-a-date" }],
    ["empty API version", { apiVersion: "" }],
    ["empty Issue ID", { issueNodeId: "" }],
    ["multiline ETag", { etag: '"line\nbreak"' }],
  ] as const)("rejects a malformed revision: %s", async (_name, malformed) => {
    let evaluations = 0;
    await expect(
      evaluateGithubSourceConsistently({
        capture: async () => capture({ value: 1 }, malformed),
        evaluate: async () => {
          evaluations += 1;
          return 1;
        },
      }),
    ).rejects.toThrow();
    expect(evaluations).toBe(0);
  });
});
