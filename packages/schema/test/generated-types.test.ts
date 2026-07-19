import type {
  DelegationDisposition,
  EvaluationStatus,
  SpecVerdict,
  TaskType,
} from "@issueready/domain";
import { describe, expect, it } from "vitest";

import type {
  IssueReadyReportV1Alpha1,
  TaskPackManifestV1Alpha1,
} from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

type Assert<Value extends true> = Value;

type EvaluationStatusAligned = Assert<
  Equal<IssueReadyReportV1Alpha1["evaluationStatus"], EvaluationStatus>
>;
type SpecVerdictAligned = Assert<
  Equal<IssueReadyReportV1Alpha1["specVerdict"], SpecVerdict | null>
>;
type DelegationDispositionAligned = Assert<
  Equal<
    IssueReadyReportV1Alpha1["delegationDisposition"],
    DelegationDisposition
  >
>;
type TaskPackIdAligned = Assert<
  Equal<TaskPackManifestV1Alpha1["id"], TaskType>
>;

const TYPE_ALIGNMENT: readonly [
  EvaluationStatusAligned,
  SpecVerdictAligned,
  DelegationDispositionAligned,
  TaskPackIdAligned,
] = [true, true, true, true];

describe("schema-derived type alignment", () => {
  it("keeps the report axes aligned with the immutable domain vocabulary", () => {
    expect(TYPE_ALIGNMENT).toEqual([true, true, true, true]);
  });
});
