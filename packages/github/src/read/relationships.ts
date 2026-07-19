export const MAX_GITHUB_RELATIONSHIP_DEPTH = 8;
export const MAX_GITHUB_CHILDREN = 100;
export const MAX_GITHUB_RELATIONSHIP_NODES = 801;
export const MAX_GITHUB_RELATIONSHIP_EDGES = 1600;

export type GithubRelationshipState = "OPEN" | "CLOSED";
export type GithubRelationshipKind = "SUB_ISSUE" | "BLOCKS";

export interface GithubRelationshipNode {
  readonly issueNodeId: string;
  readonly repositoryNodeId: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly state: GithubRelationshipState;
}

export interface GithubRelationshipEdge {
  readonly kind: GithubRelationshipKind;
  readonly from: string;
  readonly to: string;
}

export interface GithubRelationshipGraph {
  readonly rootIssueNodeId: string;
  readonly nodes: readonly GithubRelationshipNode[];
  readonly edges: readonly GithubRelationshipEdge[];
}

export type GithubRelationshipInvalidReason =
  | "NODE_BOUND_EXCEEDED"
  | "EDGE_BOUND_EXCEEDED"
  | "MALFORMED_NODE"
  | "DUPLICATE_NODE"
  | "DUPLICATE_LOCATOR"
  | "ROOT_NOT_FOUND"
  | "MALFORMED_EDGE"
  | "UNKNOWN_EDGE_NODE"
  | "DUPLICATE_EDGE"
  | "MULTIPLE_PARENTS"
  | "CHILD_BOUND_EXCEEDED"
  | "HIERARCHY_CYCLE"
  | "DISCONNECTED_HIERARCHY"
  | "HIERARCHY_DEPTH_EXCEEDED";

export interface GithubRelationshipAnalysis {
  readonly hierarchyDepth: number;
  readonly maxChildren: number;
  readonly crossRepository: boolean;
  readonly dependencyCycle: boolean;
  readonly openNodes: number;
  readonly closedNodes: number;
  readonly hierarchyEdges: number;
  readonly dependencyEdges: number;
}

export type GithubRelationshipAnalysisResult =
  | Readonly<{
      outcome: "OK";
      analysis: GithubRelationshipAnalysis;
    }>
  | Readonly<{
      outcome: "INVALID";
      reason: GithubRelationshipInvalidReason;
    }>;

function invalid(
  reason: GithubRelationshipInvalidReason,
): GithubRelationshipAnalysisResult {
  return { outcome: "INVALID", reason };
}

function isNonEmptyToken(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !/\s/u.test(value);
}

function isPathSegment(value: string): boolean {
  return isNonEmptyToken(value) && !/[/?#]/u.test(value);
}

function nodeIsValid(node: GithubRelationshipNode): boolean {
  return (
    isNonEmptyToken(node.issueNodeId) &&
    isNonEmptyToken(node.repositoryNodeId) &&
    isPathSegment(node.owner) &&
    isPathSegment(node.repository) &&
    Number.isSafeInteger(node.number) &&
    node.number > 0 &&
    (node.state === "OPEN" || node.state === "CLOSED")
  );
}

function edgeIsValid(edge: GithubRelationshipEdge): boolean {
  return (
    (edge.kind === "SUB_ISSUE" || edge.kind === "BLOCKS") &&
    isNonEmptyToken(edge.from) &&
    isNonEmptyToken(edge.to)
  );
}

function hasDirectedCycle(
  nodeIds: Iterable<string>,
  adjacency: ReadonlyMap<string, readonly string[]>,
): boolean {
  const state = new Map<string, "VISITING" | "VISITED">();
  const visit = (nodeId: string): boolean => {
    const current = state.get(nodeId);
    if (current === "VISITING") return true;
    if (current === "VISITED") return false;
    state.set(nodeId, "VISITING");
    for (const target of adjacency.get(nodeId) ?? []) {
      if (visit(target)) return true;
    }
    state.set(nodeId, "VISITED");
    return false;
  };
  for (const nodeId of nodeIds) {
    if (visit(nodeId)) return true;
  }
  return false;
}

export function analyzeGithubRelationshipGraph(
  graph: GithubRelationshipGraph,
): GithubRelationshipAnalysisResult {
  if (
    graph.nodes.length < 1 ||
    graph.nodes.length > MAX_GITHUB_RELATIONSHIP_NODES
  ) {
    return invalid("NODE_BOUND_EXCEEDED");
  }
  if (graph.edges.length > MAX_GITHUB_RELATIONSHIP_EDGES) {
    return invalid("EDGE_BOUND_EXCEEDED");
  }

  const nodes = new Map<string, GithubRelationshipNode>();
  const locators = new Set<string>();
  for (const node of graph.nodes) {
    if (!nodeIsValid(node)) return invalid("MALFORMED_NODE");
    if (nodes.has(node.issueNodeId)) return invalid("DUPLICATE_NODE");
    const locator = JSON.stringify([
      node.owner.toLowerCase(),
      node.repository.toLowerCase(),
      node.number,
    ]);
    if (locators.has(locator)) return invalid("DUPLICATE_LOCATOR");
    nodes.set(node.issueNodeId, node);
    locators.add(locator);
  }
  const root = nodes.get(graph.rootIssueNodeId);
  if (root === undefined) return invalid("ROOT_NOT_FOUND");

  const edgeKeys = new Set<string>();
  const hierarchy = new Map<string, string[]>();
  const dependencies = new Map<string, string[]>();
  const parents = new Map<string, string>();
  const hierarchyParticipants = new Set<string>();
  let maxChildren = 0;
  let hierarchyEdges = 0;
  let dependencyEdges = 0;
  for (const edge of graph.edges) {
    if (!edgeIsValid(edge)) return invalid("MALFORMED_EDGE");
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      return invalid("UNKNOWN_EDGE_NODE");
    }
    const edgeKey = JSON.stringify([edge.kind, edge.from, edge.to]);
    if (edgeKeys.has(edgeKey)) return invalid("DUPLICATE_EDGE");
    edgeKeys.add(edgeKey);
    const adjacency = edge.kind === "SUB_ISSUE" ? hierarchy : dependencies;
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
    if (edge.kind === "SUB_ISSUE") {
      hierarchyEdges += 1;
      hierarchyParticipants.add(edge.from);
      hierarchyParticipants.add(edge.to);
      const currentParent = parents.get(edge.to);
      if (currentParent !== undefined && currentParent !== edge.from) {
        return invalid("MULTIPLE_PARENTS");
      }
      parents.set(edge.to, edge.from);
      if (targets.length > MAX_GITHUB_CHILDREN) {
        return invalid("CHILD_BOUND_EXCEEDED");
      }
      maxChildren = Math.max(maxChildren, targets.length);
    } else {
      dependencyEdges += 1;
    }
  }

  if (hasDirectedCycle(nodes.keys(), hierarchy)) {
    return invalid("HIERARCHY_CYCLE");
  }

  const reachable = new Set<string>();
  const queue: Array<Readonly<{ nodeId: string; depth: number }>> = [
    { nodeId: root.issueNodeId, depth: 1 },
  ];
  let hierarchyDepth = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined || reachable.has(current.nodeId)) continue;
    reachable.add(current.nodeId);
    hierarchyDepth = Math.max(hierarchyDepth, current.depth);
    if (hierarchyDepth > MAX_GITHUB_RELATIONSHIP_DEPTH) {
      return invalid("HIERARCHY_DEPTH_EXCEEDED");
    }
    for (const child of hierarchy.get(current.nodeId) ?? []) {
      queue.push({ nodeId: child, depth: current.depth + 1 });
    }
  }
  if ([...hierarchyParticipants].some((nodeId) => !reachable.has(nodeId))) {
    return invalid("DISCONNECTED_HIERARCHY");
  }

  let openNodes = 0;
  let closedNodes = 0;
  let crossRepository = false;
  for (const node of nodes.values()) {
    if (node.state === "OPEN") openNodes += 1;
    else closedNodes += 1;
    if (node.repositoryNodeId !== root.repositoryNodeId) {
      crossRepository = true;
    }
  }

  return {
    outcome: "OK",
    analysis: {
      hierarchyDepth,
      maxChildren,
      crossRepository,
      dependencyCycle: hasDirectedCycle(nodes.keys(), dependencies),
      openNodes,
      closedNodes,
      hierarchyEdges,
      dependencyEdges,
    },
  };
}
