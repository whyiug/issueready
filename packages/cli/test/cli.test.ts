import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  CLI_VERSION,
  evaluateDemo,
  evaluateTarget,
  main,
  parseArguments,
  parseGithubLocator,
  renderSummary,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("IssueReady CLI", () => {
  it("parses local, GitHub, demo, and output arguments", () => {
    expect(parseGithubLocator("whyiug/issueready#42")).toMatchObject({
      owner: "whyiug",
      repository: "issueready",
      number: 42,
    });
    expect(
      parseGithubLocator("https://github.com/whyiug/issueready/issues/7"),
    ).toMatchObject({ number: 7 });
    expect(parseGithubLocator("https://example.com/a/b/issues/7")).toBeNull();
    expect(parseArguments(["demo", "ready", "--format", "json"])).toMatchObject(
      { command: "demo", demo: "ready", format: "json" },
    );
    expect(
      parseArguments(["issue.md", "--task-type=bug", "--include-quotes"]),
    ).toMatchObject({
      command: "evaluate",
      target: "issue.md",
      taskType: "bug",
      includeEvidenceQuotes: true,
    });
  });

  it("runs the bundled READY and NEEDS_INFO demonstrations", async () => {
    const ready = await evaluateDemo("ready");
    expect(ready.report).toMatchObject({
      evaluationStatus: "COMPLETE",
      specVerdict: "READY",
      delegationDisposition: "CANDIDATE",
    });
    expect(renderSummary(ready)).toContain("Specification: READY");

    const needsInfo = await evaluateDemo("needs-info");
    expect(needsInfo.report).toMatchObject({
      evaluationStatus: "COMPLETE",
      specVerdict: "NEEDS_INFO",
      delegationDisposition: "CANDIDATE",
    });
    expect(renderSummary(needsInfo)).toContain(
      "Blocking checks: IR-ACC-002, IR-DEF-003, IR-EDG-001",
    );
    expect(renderSummary(needsInfo)).toContain(
      "Other failed checks: IR-CTX-001",
    );
  });

  it("evaluates a local Markdown issue without inventing semantic coverage", async () => {
    const evaluation = await evaluateTarget("examples/sample-issue.md", {
      cwd: repositoryRoot,
      now: () => new Date("2026-07-19T00:00:00Z"),
    });
    expect(evaluation.report).toMatchObject({
      evaluationStatus: "DEGRADED",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
    });
    expect(evaluation.report.evaluationReasons).toContain("IR-SEM-000");
  });

  it("reads only the requested GitHub issue and never requires a token", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBeNull();
        return new Response(
          JSON.stringify({
            title: "Keep retry notices unique",
            body: "## Goal\nUpdate `RetryStore.add()`.\n\n## Acceptance criteria\n- One notice per job.",
            labels: [{ name: "bug" }],
            updated_at: "2026-07-19T00:00:00Z",
            author_association: "OWNER",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              etag: '"issue-v1"',
            },
          },
        );
      },
    );
    const evaluation = await evaluateTarget(
      "https://github.com/acme/widgets/issues/42",
      {
        cwd: repositoryRoot,
        fetch: fetchMock as typeof globalThis.fetch,
        now: () => new Date("2026-07-19T00:00:00Z"),
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(evaluation.report.source).toMatchObject({
      kind: "github",
      owner: "acme",
      repository: "widgets",
      number: 42,
    });
    expect(evaluation.report.taskType).toMatchObject({
      id: "bug",
      source: "DETERMINISTIC_HINT",
    });
  });

  it("marks oversized GitHub issue bodies as truncated", async () => {
    const body = "🙂".repeat(40_000);
    const evaluation = await evaluateTarget("acme/widgets#9", {
      cwd: repositoryRoot,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            title: "Large issue",
            body,
            labels: [],
            updated_at: "2026-07-19T00:00:00Z",
          }),
          { status: 200 },
        )) as typeof globalThis.fetch,
      now: () => new Date("2026-07-19T00:00:00Z"),
    });
    expect(evaluation.report.snapshot.truncated).toBe(true);
    expect(evaluation.report.snapshot.omittedBytes).toBeGreaterThan(0);
    expect(evaluation.report).toMatchObject({
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
    });
  });

  it("provides useful help and fixed redacted failures", async () => {
    let stdout = "";
    let stderr = "";
    const io = {
      stdout: { write: (value: string) => (stdout += value) },
      stderr: { write: (value: string) => (stderr += value) },
    };
    await expect(
      main(["--version"], io, { cwd: repositoryRoot }),
    ).resolves.toBe(0);
    expect(stdout).toBe(`${CLI_VERSION}\n`);
    expect(stderr).toBe("");

    stdout = "";
    await expect(
      main(["missing.md"], io, { cwd: repositoryRoot }),
    ).resolves.toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Local issue file was not found");
  });
});
