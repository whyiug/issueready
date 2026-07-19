import { describe, expect, it } from "vitest";

import {
  assertTriAxisState,
  isTriAxisState,
  type TriAxisFields,
} from "../src/index.js";

describe("tri-axis invariants", () => {
  it.each([
    {
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
    },
    {
      evaluationStatus: "COMPLETE",
      specVerdict: "READY",
      delegationDisposition: "HUMAN_ONLY",
    },
    {
      evaluationStatus: "COMPLETE",
      specVerdict: "NEEDS_INFO",
      delegationDisposition: "CANDIDATE",
    },
    {
      evaluationStatus: "DEGRADED",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
    },
    {
      evaluationStatus: "DEGRADED",
      specVerdict: "TOO_BROAD",
      delegationDisposition: "SUPERVISED",
    },
  ] satisfies TriAxisFields[])(
    "accepts $evaluationStatus/$specVerdict/$delegationDisposition",
    (state) => {
      expect(isTriAxisState(state)).toBe(true);
      expect(() => assertTriAxisState(state)).not.toThrow();
    },
  );

  it.each([
    {
      evaluationStatus: "ERROR",
      specVerdict: "READY",
      delegationDisposition: "UNKNOWN",
    },
    {
      evaluationStatus: "ERROR",
      specVerdict: null,
      delegationDisposition: "CANDIDATE",
    },
    {
      evaluationStatus: "COMPLETE",
      specVerdict: null,
      delegationDisposition: "UNKNOWN",
    },
  ] satisfies TriAxisFields[])(
    "rejects $evaluationStatus/$specVerdict/$delegationDisposition",
    (state) => {
      expect(isTriAxisState(state)).toBe(false);
      expect(() => assertTriAxisState(state)).toThrow(TypeError);
    },
  );

  it("keeps READY and HUMAN_ONLY as a legal orthogonal combination", () => {
    const state: TriAxisFields = {
      evaluationStatus: "COMPLETE",
      specVerdict: "READY",
      delegationDisposition: "HUMAN_ONLY",
    };
    expect(isTriAxisState(state)).toBe(true);
  });
});
