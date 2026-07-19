import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  verifyNativeSnapshotEnvelope,
} from "@issueready/snapshot";

import {
  GITHUB_API_VERSION,
  mapGithubReadCapability,
  projectGithubNative,
  type GithubNativeCheck,
  type GithubNativeFeatureRead,
  type GithubNativeReadSet,
  type GithubReadResult,
} from "../src/read/index.js";

const CHECKED_BY: GithubNativeCheck = "GITHUB_GRAPHQL";
const rateLimit = {
  limit: 5000,
  remaining: 4999,
  resetAt: "2026-07-18T21:00:00.000Z",
  retryAfterSeconds: null,
} as const;

function ok(data: unknown): GithubReadResult<unknown> {
  return { outcome: "OK", data, requests: 1, etag: null, rateLimit };
}

function notModified(): GithubReadResult<unknown> {
  return {
    outcome: "NOT_MODIFIED",
    data: null,
    requests: 1,
    etag: '"cached"',
    rateLimit,
  };
}

function unavailable(
  reason: Extract<
    GithubReadResult<unknown>,
    { outcome: "UNAVAILABLE" }
  >["reason"],
): GithubReadResult<unknown> {
  return {
    outcome: "UNAVAILABLE",
    reason,
    data: null,
    requests: 1,
    etag: null,
    rateLimit,
  };
}

function unknown(
  reason: Extract<GithubReadResult<unknown>, { outcome: "UNKNOWN" }>["reason"],
  data: unknown = null,
): GithubReadResult<unknown> {
  return {
    outcome: "UNKNOWN",
    reason,
    data,
    requests: 1,
    etag: null,
    rateLimit,
  };
}

function read(
  result: GithubReadResult<unknown>,
  cachedData?: unknown,
): GithubNativeFeatureRead {
  return cachedData === undefined
    ? { result, checkedBy: CHECKED_BY }
    : { result, checkedBy: CHECKED_BY, cachedData };
}

function minimalReadSet(): GithubNativeReadSet {
  return {
    issueType: read(ok(null)),
    fields: read(ok([])),
    parent: read(ok(null)),
    subIssues: read(ok([])),
    dependencies: read(ok({ blockedBy: [], blocking: [] })),
    references: {
      capability: read(ok([])),
      items: [],
    },
  };
}

describe("GitHub read to native snapshot projection", () => {
  it.each([
    [ok([]), false, "AVAILABLE", null],
    [notModified(), false, "UNKNOWN", "PARTIAL_RESPONSE"],
    [notModified(), true, "AVAILABLE", null],
    [
      unavailable("PERMISSION_DENIED"),
      false,
      "UNAVAILABLE",
      "PERMISSION_DENIED",
    ],
    [unavailable("NOT_FOUND"), false, "UNAVAILABLE", "NOT_FOUND"],
    [unavailable("API_UNSUPPORTED"), false, "UNAVAILABLE", "API_UNSUPPORTED"],
    [unavailable("CONFLICT"), false, "UNKNOWN", "TRANSIENT_ERROR"],
    [unavailable("INVALID_REQUEST"), false, "UNKNOWN", "PARTIAL_RESPONSE"],
    [unknown("RATE_LIMITED"), false, "UNKNOWN", "TRANSIENT_ERROR"],
    [unknown("SERVER_ERROR"), false, "UNKNOWN", "TRANSIENT_ERROR"],
    [unknown("PARTIAL_RESPONSE"), false, "UNKNOWN", "PARTIAL_RESPONSE"],
    [unknown("PROTOCOL_ERROR"), false, "UNKNOWN", "PARTIAL_RESPONSE"],
    [unknown("BOUNDS_EXCEEDED"), false, "UNKNOWN", "PARTIAL_RESPONSE"],
  ] as const)(
    "maps provider outcome %# without claiming unavailable content",
    (result, cacheAvailable, availability, reason) => {
      expect(
        mapGithubReadCapability(result, CHECKED_BY, cacheAvailable),
      ).toEqual({ availability, checkedBy: CHECKED_BY, reason });
    },
  );

  it("projects complete and partial native data while retaining access states", () => {
    const reads: GithubNativeReadSet = {
      issueType: read(ok({ id: "type-1", name: "Bug" })),
      fields: read(
        unknown("PARTIAL_RESPONSE", [
          { id: "field-1", name: "Severity", value: "high" },
        ]),
      ),
      parent: read(notModified(), { number: 40, title: "Parent" }),
      subIssues: read(ok([{ number: 42 }, { number: 43 }])),
      dependencies: read(
        ok({
          blockedBy: [{ number: 10 }],
          blocking: [{ number: 99 }],
        }),
      ),
      references: {
        capability: read(ok([])),
        items: [
          {
            target: "#42",
            kind: "ISSUE",
            essential: true,
            checkedBy: "GITHUB_REST",
            result: unavailable("PERMISSION_DENIED"),
          },
          {
            target: "#43",
            kind: "ISSUE",
            essential: false,
            checkedBy: "GITHUB_REST",
            result: unavailable("NOT_FOUND"),
          },
          {
            target: "https://github.com/acme/widgets/pull/44",
            kind: "PULL_REQUEST",
            essential: false,
            checkedBy: "GITHUB_REST",
            result: unknown("SERVER_ERROR"),
          },
        ],
      },
    };
    const native = projectGithubNative(reads);
    expect(native).toMatchObject({
      issueType: { id: "type-1", name: "Bug" },
      fields: [{ id: "field-1", name: "Severity", value: "high" }],
      parent: { number: 40, title: "Parent" },
      subIssues: [{ number: 42 }, { number: 43 }],
      blockedBy: [{ number: 10 }],
      blocking: [{ number: 99 }],
      capabilities: {
        issueTypes: { availability: "AVAILABLE", reason: null },
        fields: { availability: "UNKNOWN", reason: "PARTIAL_RESPONSE" },
        parent: { availability: "AVAILABLE", reason: null },
        subIssues: { availability: "AVAILABLE", reason: null },
        dependencies: { availability: "AVAILABLE", reason: null },
        references: { availability: "AVAILABLE", reason: null },
      },
      references: [
        {
          target: "#42",
          availability: "UNAVAILABLE",
          reason: "PERMISSION_DENIED",
        },
        { target: "#43", availability: "UNAVAILABLE", reason: "NOT_FOUND" },
        {
          target: "https://github.com/acme/widgets/pull/44",
          availability: "UNKNOWN",
          reason: "TRANSIENT_ERROR",
        },
      ],
    });
    expect(verifyNativeSnapshotEnvelope(native)).toBe(true);

    const issueType = reads.issueType.result;
    if (issueType.outcome === "OK" && issueType.data !== null) {
      (issueType.data as { name: string }).name = "Mutated after projection";
    }
    expect(native.issueType).toMatchObject({ name: "Bug" });
  });

  it("downgrades malformed successful payloads to partial unknown", () => {
    const reads = minimalReadSet();
    const malformed: GithubNativeReadSet = {
      ...reads,
      issueType: read(ok("not-an-object")),
      fields: read(ok(Array.from({ length: 101 }, (_, id) => ({ id })))),
      parent: read(ok([])),
      subIssues: read(ok(["not-an-object"])),
      dependencies: read(ok({ blockedBy: [], extra: [], blocking: [] })),
    };
    const native = projectGithubNative(malformed);
    expect(native).toMatchObject({
      issueType: null,
      fields: [],
      parent: null,
      subIssues: [],
      blockedBy: [],
      blocking: [],
      capabilities: {
        issueTypes: { availability: "UNKNOWN", reason: "PARTIAL_RESPONSE" },
        fields: { availability: "UNKNOWN", reason: "PARTIAL_RESPONSE" },
        parent: { availability: "UNKNOWN", reason: "PARTIAL_RESPONSE" },
        subIssues: { availability: "UNKNOWN", reason: "PARTIAL_RESPONSE" },
        dependencies: { availability: "UNKNOWN", reason: "PARTIAL_RESPONSE" },
      },
    });
  });

  it("replaces renamed or deleted native records and changes the snapshot digest", () => {
    const firstReads = minimalReadSet();
    const secondReads = minimalReadSet();
    const firstNative = projectGithubNative({
      ...firstReads,
      fields: read(
        ok([
          { id: "field-1", name: "Old severity" },
          { id: "field-2", name: "Delete me" },
        ]),
      ),
    });
    const secondNative = projectGithubNative({
      ...secondReads,
      fields: read(ok([{ id: "field-1", name: "Severity" }])),
    });
    const build = (native: ReturnType<typeof projectGithubNative>) =>
      buildSnapshot({
        source: {
          kind: "github",
          owner: "acme",
          repository: "widgets",
          number: 42,
          updatedAt: "2026-07-18T21:00:00Z",
          apiVersion: GITHUB_API_VERSION,
          etag: null,
        },
        title: "Native rename and deletion",
        body: "Keep native data current.",
        labels: [],
        comments: [],
        native,
        evaluatedAt: "2026-07-18T21:01:00Z",
        truncated: false,
        omittedBytes: 0,
      });
    const first = build(firstNative);
    const second = build(secondNative);
    expect(second.native.fields).toEqual([{ id: "field-1", name: "Severity" }]);
    expect(second.integrity.snapshotDigest).not.toBe(
      first.integrity.snapshotDigest,
    );
  });

  it("rejects malformed, duplicate, and unbounded reference descriptors", () => {
    const base = minimalReadSet();
    const reference = {
      target: "#42",
      kind: "ISSUE" as const,
      essential: true,
      checkedBy: "GITHUB_REST" as const,
      result: ok({ number: 42 }),
    };
    expect(() =>
      projectGithubNative({
        ...base,
        references: {
          ...base.references,
          items: [reference, { ...reference, essential: false }],
        },
      }),
    ).toThrow(/Duplicate/u);
    expect(() =>
      projectGithubNative({
        ...base,
        references: {
          ...base.references,
          items: [{ ...reference, target: "https://example.com/42" }],
        },
      }),
    ).toThrow(/Invalid/u);
    expect(() =>
      projectGithubNative({
        ...base,
        references: {
          ...base.references,
          items: Array.from({ length: 101 }, (_, number) => ({
            ...reference,
            target: `#${number + 1}`,
          })),
        },
      }),
    ).toThrow(/100-item/u);
  });
});
