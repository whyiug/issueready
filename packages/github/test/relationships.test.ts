import { readFileSync } from "node:fs";

import type { GithubNativeRelationshipFixtureCatalogV1Alpha1 } from "@issueready/schema";
import { describe, expect, it } from "vitest";

import {
  analyzeGithubRelationshipGraph,
  MAX_GITHUB_RELATIONSHIP_EDGES,
  MAX_GITHUB_RELATIONSHIP_NODES,
  type GithubRelationshipEdge,
  type GithubRelationshipGraph,
  type GithubRelationshipNode,
} from "../src/read/index.js";

const catalog = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/github/native-relationships.v1alpha1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as GithubNativeRelationshipFixtureCatalogV1Alpha1;

type Fixture =
  GithubNativeRelationshipFixtureCatalogV1Alpha1["fixtures"][number];

function node(
  issueNodeId: string,
  number: number,
  overrides: Partial<GithubRelationshipNode> = {},
): GithubRelationshipNode {
  return {
    issueNodeId,
    repositoryNodeId: "repo-a",
    owner: "acme",
    repository: "widgets",
    number,
    state: "OPEN",
    ...overrides,
  };
}

function expandFixture(fixture: Fixture): GithubRelationshipGraph {
  switch (fixture.recipe.kind) {
    case "CHAIN": {
      const nodes = Array.from({ length: fixture.recipe.levels }, (_, index) =>
        node(`issue-${index + 1}`, index + 1),
      );
      const edges = nodes
        .slice(1)
        .map((_child, index): GithubRelationshipEdge => ({
          kind: "SUB_ISSUE",
          from: `issue-${index + 1}`,
          to: `issue-${index + 2}`,
        }));
      return { rootIssueNodeId: "issue-1", nodes, edges };
    }
    case "FANOUT": {
      const nodes = [
        node("issue-root", 1),
        ...Array.from({ length: fixture.recipe.children }, (_, index) =>
          node(`issue-child-${index + 1}`, index + 2),
        ),
      ];
      const edges = nodes.slice(1).map((child): GithubRelationshipEdge => ({
        kind: "SUB_ISSUE",
        from: "issue-root",
        to: child.issueNodeId,
      }));
      return { rootIssueNodeId: "issue-root", nodes, edges };
    }
    case "EXPLICIT":
      return {
        rootIssueNodeId: fixture.recipe.rootIssueNodeId,
        nodes: structuredClone(fixture.recipe.nodes),
        edges: structuredClone(fixture.recipe.edges),
      };
  }
}

describe("bounded GitHub native relationship fixtures", () => {
  it("keeps the catalog versioned, unique, and complete", () => {
    expect(catalog.schemaVersion).toBe(
      "https://example.invalid/issueready/github-native-relationship-fixture/v1alpha1",
    );
    expect(catalog.fixtures).toHaveLength(10);
    expect(new Set(catalog.fixtures.map((fixture) => fixture.id)).size).toBe(
      catalog.fixtures.length,
    );
    expect(catalog.fixtures.map((fixture) => fixture.id)).toEqual(
      expect.arrayContaining([
        "depth-eight-accepted",
        "depth-nine-rejected",
        "one-hundred-children-accepted",
        "one-hundred-one-children-rejected",
        "cross-repository-child",
        "duplicate-dependency-rejected",
        "dependency-cycle-detected",
        "closed-child",
        "reopened-child",
        "hierarchy-cycle-rejected",
      ]),
    );
  });

  it.each(catalog.fixtures)("analyzes $id", (fixture) => {
    expect(analyzeGithubRelationshipGraph(expandFixture(fixture))).toEqual(
      fixture.expected,
    );
  });

  it("recomputes closed and reopened state without stale merging", () => {
    const closed = catalog.fixtures.find(
      (fixture) => fixture.id === "closed-child",
    );
    const reopened = catalog.fixtures.find(
      (fixture) => fixture.id === "reopened-child",
    );
    expect(closed).toBeDefined();
    expect(reopened).toBeDefined();
    if (closed === undefined || reopened === undefined) return;
    const closedGraph = expandFixture(closed);
    const reopenedGraph = expandFixture(reopened);
    expect(closedGraph.nodes.map((item) => item.issueNodeId)).toEqual(
      reopenedGraph.nodes.map((item) => item.issueNodeId),
    );
    expect(analyzeGithubRelationshipGraph(closedGraph)).toMatchObject({
      outcome: "OK",
      analysis: { openNodes: 1, closedNodes: 1 },
    });
    expect(analyzeGithubRelationshipGraph(reopenedGraph)).toMatchObject({
      outcome: "OK",
      analysis: { openNodes: 2, closedNodes: 0 },
    });
  });

  it("is invariant to provider node and edge ordering", () => {
    const fixture = catalog.fixtures.find(
      (item) => item.id === "dependency-cycle-detected",
    );
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const graph = expandFixture(fixture);
    expect(
      analyzeGithubRelationshipGraph({
        ...graph,
        nodes: [...graph.nodes].reverse(),
        edges: [...graph.edges].reverse(),
      }),
    ).toEqual(analyzeGithubRelationshipGraph(graph));
  });

  it.each([
    [
      "empty graph",
      { rootIssueNodeId: "missing", nodes: [], edges: [] },
      "NODE_BOUND_EXCEEDED",
    ],
    [
      "missing root",
      { rootIssueNodeId: "missing", nodes: [node("issue-1", 1)], edges: [] },
      "ROOT_NOT_FOUND",
    ],
    [
      "malformed node",
      {
        rootIssueNodeId: "issue-1",
        nodes: [{ ...node("issue-1", 1), state: "UNKNOWN" }],
        edges: [],
      },
      "MALFORMED_NODE",
    ],
    [
      "duplicate node ID",
      {
        rootIssueNodeId: "issue-1",
        nodes: [node("issue-1", 1), node("issue-1", 2)],
        edges: [],
      },
      "DUPLICATE_NODE",
    ],
    [
      "duplicate locator",
      {
        rootIssueNodeId: "issue-1",
        nodes: [node("issue-1", 1), node("issue-2", 1)],
        edges: [],
      },
      "DUPLICATE_LOCATOR",
    ],
    [
      "unknown edge node",
      {
        rootIssueNodeId: "issue-1",
        nodes: [node("issue-1", 1)],
        edges: [{ kind: "BLOCKS", from: "issue-1", to: "missing" }],
      },
      "UNKNOWN_EDGE_NODE",
    ],
    [
      "malformed edge",
      {
        rootIssueNodeId: "issue-1",
        nodes: [node("issue-1", 1)],
        edges: [{ kind: "REFERENCES", from: "issue-1", to: "issue-1" }],
      },
      "MALFORMED_EDGE",
    ],
    [
      "multiple parents",
      {
        rootIssueNodeId: "issue-1",
        nodes: [node("issue-1", 1), node("issue-2", 2), node("issue-3", 3)],
        edges: [
          { kind: "SUB_ISSUE", from: "issue-1", to: "issue-3" },
          { kind: "SUB_ISSUE", from: "issue-2", to: "issue-3" },
        ],
      },
      "MULTIPLE_PARENTS",
    ],
    [
      "disconnected hierarchy",
      {
        rootIssueNodeId: "issue-1",
        nodes: [node("issue-1", 1), node("issue-2", 2), node("issue-3", 3)],
        edges: [{ kind: "SUB_ISSUE", from: "issue-2", to: "issue-3" }],
      },
      "DISCONNECTED_HIERARCHY",
    ],
  ] as const)("rejects %s", (_name, graph, reason) => {
    expect(
      analyzeGithubRelationshipGraph(graph as GithubRelationshipGraph),
    ).toEqual({ outcome: "INVALID", reason });
  });

  it("checks total node and edge hard bounds before graph traversal", () => {
    const tooManyNodes = Array.from(
      { length: MAX_GITHUB_RELATIONSHIP_NODES + 1 },
      (_, index) => node(`issue-${index + 1}`, index + 1),
    );
    expect(
      analyzeGithubRelationshipGraph({
        rootIssueNodeId: "issue-1",
        nodes: tooManyNodes,
        edges: [],
      }),
    ).toEqual({ outcome: "INVALID", reason: "NODE_BOUND_EXCEEDED" });

    expect(
      analyzeGithubRelationshipGraph({
        rootIssueNodeId: "issue-1",
        nodes: [node("issue-1", 1), node("issue-2", 2)],
        edges: Array.from(
          { length: MAX_GITHUB_RELATIONSHIP_EDGES + 1 },
          (): GithubRelationshipEdge => ({
            kind: "BLOCKS",
            from: "issue-1",
            to: "issue-2",
          }),
        ),
      }),
    ).toEqual({ outcome: "INVALID", reason: "EDGE_BOUND_EXCEEDED" });
  });
});
