import type {
  CanonicalRuleResult,
  DecisionInput,
  EvaluationRuleResult,
  PolicyDispositionEffect,
  PolicyRuleResult,
} from "@issueready/decision";
import type {
  EvidenceSpan,
  Finding,
  FindingSource,
  RuleOutcome,
  Sha256Digest,
  TaskType,
} from "@issueready/domain";
import type { PolicyDisposition } from "@issueready/policy";
import type {
  RuleManifestV1Alpha1,
  TaskPackManifestV1Alpha1,
} from "@issueready/schema";
import {
  verifySnapshot,
  type ImmutableIssueSnapshot,
} from "@issueready/snapshot";

import { validateCatalog } from "./index.js";

export type RuleCriteriaBucket =
  "mandatory" | "conditional" | "advisory" | "evaluation" | "disposition";

export interface RuleSignal {
  readonly ruleId: string;
  readonly source: string;
  readonly outcome: RuleOutcome;
  readonly evidence?: readonly EvidenceSpan[];
  readonly hardPredicateProven?: boolean;
  readonly policyEffect?: PolicyDispositionEffect;
  readonly independentHardBoundary?: boolean;
}

export interface RuleExecutionItem {
  readonly ruleId: string;
  readonly revision: number;
  readonly dimension: string;
  readonly bucket: RuleCriteriaBucket;
  readonly outcome: RuleOutcome;
  readonly source: FindingSource;
  readonly messageKey: string;
  readonly evidence: readonly EvidenceSpan[];
  readonly hardPredicateProven: boolean;
  readonly policyEffect: PolicyDispositionEffect;
  readonly independentHardBoundary: boolean;
}

export interface ExecuteTaskPackInput {
  readonly taskType: TaskType;
  readonly rules: readonly RuleManifestV1Alpha1[];
  readonly taskPacks: readonly TaskPackManifestV1Alpha1[];
  readonly signals: readonly RuleSignal[];
  readonly snapshotValid: boolean;
  readonly internalFatal?: boolean;
}

export interface RuleExecutionResult {
  readonly taskType: TaskType;
  readonly taskPackRevision: number;
  readonly rules: readonly RuleExecutionItem[];
  readonly canonicalFindings: readonly Finding[];
  readonly evaluationFindings: readonly Finding[];
  readonly policyFindings: readonly Finding[];
  readonly evaluationReasons: readonly string[];
  readonly decisionInput: DecisionInput;
}

export interface ExecuteDeterministicSnapshotInput {
  readonly snapshot: ImmutableIssueSnapshot;
  readonly taskType: TaskType;
  readonly rules: readonly RuleManifestV1Alpha1[];
  readonly taskPacks: readonly TaskPackManifestV1Alpha1[];
  readonly policyDisposition?: PolicyDisposition;
  readonly additionalSignals?: readonly RuleSignal[];
}

const BUCKETS: readonly RuleCriteriaBucket[] = [
  "mandatory",
  "conditional",
  "advisory",
  "evaluation",
  "disposition",
];

const POLICY_EFFECT_RANK: Readonly<Record<PolicyDispositionEffect, number>> = {
  NONE: 0,
  CANDIDATE: 1,
  SUPERVISED: 2,
  HUMAN_ONLY: 3,
  UNKNOWN: 4,
};

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreeze(entry));
    return Object.freeze(value);
  }
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((entry) => deepFreeze(entry));
    return Object.freeze(value);
  }
  return value;
}

function sourceKind(source: string): string {
  return source.split(":", 1)[0] ?? source;
}

function compareEvidence(left: EvidenceSpan, right: EvidenceSpan): number {
  return (
    left.document.localeCompare(right.document) ||
    left.startUtf16 - right.startUtf16 ||
    left.endUtf16 - right.endUtf16 ||
    left.snapshotDigest.localeCompare(right.snapshotDigest)
  );
}

function stableEvidence(
  signals: readonly RuleSignal[],
): readonly EvidenceSpan[] {
  const byIdentity = new Map<string, EvidenceSpan>();
  for (const signal of signals) {
    for (const evidence of signal.evidence ?? []) {
      const key = [
        evidence.document,
        evidence.startUtf16,
        evidence.endUtf16,
        evidence.snapshotDigest,
      ].join("\u0000");
      byIdentity.set(key, evidence);
    }
  }
  return Object.freeze([...byIdentity.values()].sort(compareEvidence));
}

function findingSource(
  manifest: RuleManifestV1Alpha1,
  signals: readonly RuleSignal[],
): FindingSource {
  if (manifest.canonicalLevel === "disposition-only") return "POLICY";
  const kinds = new Set(signals.map((signal) => sourceKind(signal.source)));
  const hasSemantic = kinds.has("semantic-criterion");
  const hasDeterministic = [...kinds].some(
    (kind) => kind !== "semantic-criterion",
  );
  if (hasSemantic && hasDeterministic) return "HYBRID";
  if (hasSemantic) return "SEMANTIC";
  if (hasDeterministic) return "DETERMINISTIC";
  if (manifest.engine === "semantic") return "SEMANTIC";
  if (
    manifest.engine === "hybrid" ||
    manifest.engine === "deterministic+semantic"
  ) {
    return "HYBRID";
  }
  return "DETERMINISTIC";
}

function strongestPolicyEffect(
  signals: readonly RuleSignal[],
): PolicyDispositionEffect {
  let selected: PolicyDispositionEffect = "NONE";
  for (const signal of signals) {
    const candidate = signal.policyEffect ?? "NONE";
    if (POLICY_EFFECT_RANK[candidate] > POLICY_EFFECT_RANK[selected]) {
      selected = candidate;
    }
  }
  return selected;
}

function validateSignal(
  signal: RuleSignal,
  manifest: RuleManifestV1Alpha1,
): void {
  if (!manifest.evidenceSources.includes(signal.source)) {
    throw new TypeError(
      `${signal.ruleId} signal source is not registered: ${signal.source}`,
    );
  }
  if (!manifest.aggregation.possibleOutcomes.includes(signal.outcome)) {
    throw new TypeError(
      `${signal.ruleId} signal outcome is not registered: ${signal.outcome}`,
    );
  }
  if (signal.hardPredicateProven === true) {
    if (
      signal.outcome !== "FAIL" ||
      manifest.hardPredicate === "none" ||
      !manifest.hardPredicate.allowedSources.includes(sourceKind(signal.source))
    ) {
      throw new TypeError(
        `${signal.ruleId} hard predicate proof is not allowed from ${signal.source}`,
      );
    }
  }
  if (
    signal.policyEffect !== undefined &&
    manifest.canonicalLevel !== "disposition-only"
  ) {
    throw new TypeError(
      `${signal.ruleId} canonical signals cannot carry a policy effect`,
    );
  }
}

interface AggregatedSignal {
  readonly outcome: RuleOutcome;
  readonly contributors: readonly RuleSignal[];
  readonly hardPredicateProven: boolean;
}

function aggregateSignals(
  manifest: RuleManifestV1Alpha1,
  signals: readonly RuleSignal[],
): AggregatedSignal {
  const hardFailures = signals.filter(
    (signal) =>
      signal.outcome === "FAIL" && signal.hardPredicateProven === true,
  );
  if (hardFailures.length > 0) {
    return {
      outcome: "FAIL",
      contributors: hardFailures,
      hardPredicateProven: true,
    };
  }
  for (const kind of manifest.aggregation.sourcePriority) {
    const candidates = signals.filter(
      (signal) =>
        sourceKind(signal.source) === kind && signal.outcome !== "UNKNOWN",
    );
    if (candidates.length === 0) continue;
    const outcomes = new Set(candidates.map((signal) => signal.outcome));
    return outcomes.size === 1
      ? {
          outcome: candidates[0]?.outcome ?? "UNKNOWN",
          contributors: candidates,
          hardPredicateProven: false,
        }
      : {
          outcome: "UNKNOWN",
          contributors: candidates,
          hardPredicateProven: false,
        };
  }
  return {
    outcome: "UNKNOWN",
    contributors: signals,
    hardPredicateProven: false,
  };
}

function toFinding(item: RuleExecutionItem): Finding {
  return Object.freeze({
    ruleId: item.ruleId,
    outcome: item.outcome,
    source: item.source,
    messageKey: item.messageKey,
    evidence: item.evidence,
  });
}

function toCanonicalResult(
  item: RuleExecutionItem,
  manifest: RuleManifestV1Alpha1,
): CanonicalRuleResult {
  return Object.freeze({
    ruleId: item.ruleId,
    outcome: item.outcome,
    applicable: item.outcome !== "NOT_APPLICABLE",
    mandatory: item.bucket === "mandatory",
    onFail: manifest.onFail.specEffect,
    unknownCouldChangeVerdict:
      manifest.onUnknown.specEffect === "NULL" ||
      manifest.onUnknown.specEffect === "NULL_IF_OUTCOME_COULD_CHANGE",
    hardPredicateProven: item.hardPredicateProven,
  });
}

function toEvaluationResult(
  item: RuleExecutionItem,
  manifest: RuleManifestV1Alpha1,
): EvaluationRuleResult {
  return Object.freeze({
    ruleId: item.ruleId,
    outcome: item.outcome,
    onFail: manifest.onFail.evaluationEffect,
    onUnknown: manifest.onUnknown.evaluationEffect,
    unknownNullsSpec: manifest.onUnknown.specEffect === "NULL",
  });
}

function toPolicyResult(item: RuleExecutionItem): PolicyRuleResult {
  return Object.freeze({
    ruleId: item.ruleId,
    outcome: item.outcome,
    effect: item.outcome === "UNKNOWN" ? "UNKNOWN" : item.policyEffect,
    independentHardBoundary: item.independentHardBoundary,
  });
}

export function executeTaskPack(
  input: ExecuteTaskPackInput,
): RuleExecutionResult {
  const catalogValidation = validateCatalog({
    rules: input.rules,
    taskPacks: input.taskPacks,
  });
  if (!catalogValidation.valid) {
    throw new TypeError(
      `Cannot execute invalid rule catalog: ${catalogValidation.issues
        .map((issue) => `${issue.code}:${issue.subject}`)
        .join(",")}`,
    );
  }
  const taskPack = input.taskPacks.find((pack) => pack.id === input.taskType);
  if (taskPack === undefined) {
    throw new TypeError(`Missing registered task pack: ${input.taskType}`);
  }
  const rulesById = new Map(
    input.rules.map((manifest) => [manifest.id, manifest]),
  );
  const assignedRuleIds = new Set(
    BUCKETS.flatMap((bucket) => taskPack.criteria[bucket]),
  );
  for (const signal of input.signals) {
    const manifest = rulesById.get(signal.ruleId);
    if (manifest === undefined || !assignedRuleIds.has(signal.ruleId)) {
      throw new TypeError(
        `Signal targets an unassigned rule: ${signal.ruleId}`,
      );
    }
    validateSignal(signal, manifest);
  }
  const signalsByRule = new Map<string, RuleSignal[]>();
  for (const signal of input.signals) {
    const values = signalsByRule.get(signal.ruleId) ?? [];
    values.push(signal);
    signalsByRule.set(signal.ruleId, values);
  }
  const executed: RuleExecutionItem[] = [];
  const manifestsForExecution: RuleManifestV1Alpha1[] = [];
  for (const bucket of BUCKETS) {
    for (const ruleId of taskPack.criteria[bucket]) {
      const manifest = rulesById.get(ruleId);
      if (manifest === undefined) {
        throw new TypeError(`Task pack references missing rule: ${ruleId}`);
      }
      const signals = signalsByRule.get(ruleId) ?? [];
      const aggregate = aggregateSignals(manifest, signals);
      executed.push(
        Object.freeze({
          ruleId: manifest.id,
          revision: manifest.revision,
          dimension: manifest.dimension,
          bucket,
          outcome: aggregate.outcome,
          source: findingSource(manifest, signals),
          messageKey: manifest.messageKey,
          evidence: stableEvidence(signals),
          hardPredicateProven: aggregate.hardPredicateProven,
          policyEffect: strongestPolicyEffect(aggregate.contributors),
          independentHardBoundary: aggregate.contributors.some(
            (signal) => signal.independentHardBoundary === true,
          ),
        }),
      );
      manifestsForExecution.push(manifest);
    }
  }
  const canonicalResults: CanonicalRuleResult[] = [];
  const evaluationResults: EvaluationRuleResult[] = [];
  const policyResults: PolicyRuleResult[] = [];
  for (let index = 0; index < executed.length; index += 1) {
    const item = executed[index];
    const manifest = manifestsForExecution[index];
    if (item === undefined || manifest === undefined) continue;
    if (
      item.bucket === "mandatory" ||
      item.bucket === "conditional" ||
      item.bucket === "advisory"
    ) {
      canonicalResults.push(toCanonicalResult(item, manifest));
    } else if (item.bucket === "evaluation") {
      evaluationResults.push(toEvaluationResult(item, manifest));
    } else {
      policyResults.push(toPolicyResult(item));
    }
  }
  const canonicalFindings = executed
    .filter((item) =>
      ["mandatory", "conditional", "advisory"].includes(item.bucket),
    )
    .map(toFinding);
  const evaluationFindings = executed
    .filter((item) => item.bucket === "evaluation")
    .map(toFinding);
  const policyFindings = executed
    .filter((item) => item.bucket === "disposition")
    .map(toFinding);
  const semanticCoverageUnavailable = executed.some((item, index) => {
    const manifest = manifestsForExecution[index];
    return (
      item.outcome === "UNKNOWN" &&
      manifest !== undefined &&
      manifest.engine !== "deterministic"
    );
  });
  return deepFreeze({
    taskType: input.taskType,
    taskPackRevision: taskPack.revision,
    rules: executed,
    canonicalFindings,
    evaluationFindings,
    policyFindings,
    evaluationReasons: semanticCoverageUnavailable ? ["IR-SEM-000"] : [],
    decisionInput: {
      snapshotValid: input.snapshotValid,
      internalFatal: input.internalFatal ?? false,
      canonicalRules: canonicalResults,
      evaluationRules: evaluationResults,
      policyRules: policyResults,
    },
  }) as RuleExecutionResult;
}

function digest(snapshot: ImmutableIssueSnapshot): Sha256Digest {
  return snapshot.integrity.snapshotDigest as Sha256Digest;
}

function lineEnd(source: string, endUtf16: number): number {
  if (endUtf16 === 0) return 1;
  let lines = 1;
  for (let index = 0; index < endUtf16; index += 1) {
    if (source[index] === "\n") lines += 1;
  }
  return lines;
}

function evidence(
  snapshot: ImmutableIssueSnapshot,
  document: string,
  source: string,
  startUtf16: number,
  endUtf16: number,
): EvidenceSpan {
  const quote = source.slice(startUtf16, endUtf16);
  return Object.freeze({
    document,
    startUtf16,
    endUtf16,
    lineStart: lineEnd(source, startUtf16),
    lineEnd: lineEnd(source, endUtf16),
    ...(quote.length <= 512 ? { quote } : {}),
    snapshotDigest: digest(snapshot),
  });
}

function bodyEvidence(
  snapshot: ImmutableIssueSnapshot,
  startUtf16 = 0,
  endUtf16 = snapshot.content.body.length,
): EvidenceSpan {
  return evidence(
    snapshot,
    snapshot.content.normalization.document,
    snapshot.content.body,
    startUtf16,
    endUtf16,
  );
}

type SnapshotHeading =
  ImmutableIssueSnapshot["content"]["normalization"]["headings"][number];

function matchingHeadings(
  snapshot: ImmutableIssueSnapshot,
  pattern: RegExp,
): readonly SnapshotHeading[] {
  return snapshot.content.normalization.headings.filter((heading) =>
    pattern.test(heading.text),
  );
}

function headingsNestedWithin(
  snapshot: ImmutableIssueSnapshot,
  parent: SnapshotHeading,
  pattern: RegExp,
): readonly SnapshotHeading[] {
  return snapshot.content.normalization.headings.filter(
    (heading) =>
      heading.depth > parent.depth &&
      heading.span.startUtf16 >= parent.span.endUtf16 &&
      heading.sectionSpan.endUtf16 <= parent.sectionSpan.endUtf16 &&
      pattern.test(heading.text) &&
      sectionHasContent(snapshot, heading),
  );
}

function independentlyAcceptedGoals(
  snapshot: ImmutableIssueSnapshot,
  goals: readonly SnapshotHeading[],
): readonly SnapshotHeading[] {
  for (const depth of new Set(goals.map((heading) => heading.depth))) {
    const peers = goals.filter(
      (heading) =>
        heading.depth === depth &&
        sectionHasContent(snapshot, heading) &&
        headingsNestedWithin(snapshot, heading, ACCEPTANCE_HEADING).length > 0,
    );
    if (peers.length > 1) return peers;
  }
  return [];
}

function sectionHasContent(
  snapshot: ImmutableIssueSnapshot,
  heading: SnapshotHeading,
): boolean {
  const section = snapshot.content.body.slice(
    heading.span.endUtf16,
    heading.sectionSpan.endUtf16,
  );
  return section.replaceAll(/[#*_`>\-\s]/gu, "").length > 0;
}

function headingEvidence(
  snapshot: ImmutableIssueSnapshot,
  headings: readonly SnapshotHeading[],
): readonly EvidenceSpan[] {
  return headings.map((heading) =>
    bodyEvidence(
      snapshot,
      heading.sectionSpan.startUtf16,
      heading.sectionSpan.endUtf16,
    ),
  );
}

function regexpEvidence(
  snapshot: ImmutableIssueSnapshot,
  pattern: RegExp,
): readonly EvidenceSpan[] {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  return [...snapshot.content.body.matchAll(matcher)].map((match) =>
    bodyEvidence(snapshot, match.index, match.index + (match[0]?.length ?? 0)),
  );
}

interface NativeReferenceResolution {
  readonly traceOutcome: RuleOutcome;
  readonly contextOutcome: RuleOutcome;
  readonly contextHardPredicateProven: boolean;
}

function nativeReferenceResolution(
  snapshot: ImmutableIssueSnapshot,
  references: readonly EvidenceSpan[],
): NativeReferenceResolution {
  const targets = [
    ...new Set(
      references
        .map((span) => span.quote?.trim() ?? "")
        .filter((target) => target !== ""),
    ),
  ];
  if (targets.length === 0) {
    return {
      traceOutcome: "NOT_APPLICABLE",
      contextOutcome: "NOT_APPLICABLE",
      contextHardPredicateProven: false,
    };
  }
  const byTarget = new Map(
    snapshot.native.references.map((reference) => [
      reference.target,
      reference,
    ]),
  );
  const states = targets.map((target) => byTarget.get(target));
  const unresolved = states.some(
    (state) => state === undefined || state.availability === "UNKNOWN",
  );
  const unavailable = states.some(
    (state) => state?.availability === "UNAVAILABLE",
  );
  const essentialUnavailable = states.some(
    (state) => state?.essential && state.availability === "UNAVAILABLE",
  );
  const essentialUnknown = states.some(
    (state) =>
      state === undefined ||
      (state.essential && state.availability === "UNKNOWN"),
  );
  return {
    traceOutcome: unresolved ? "UNKNOWN" : unavailable ? "FAIL" : "PASS",
    contextOutcome: essentialUnavailable
      ? "FAIL"
      : essentialUnknown
        ? "UNKNOWN"
        : "PASS",
    contextHardPredicateProven: essentialUnavailable,
  };
}

function signal(
  ruleId: string,
  source: string,
  outcome: RuleOutcome,
  evidenceSpans: readonly EvidenceSpan[] = [],
  hardPredicateProven = false,
): RuleSignal {
  return {
    ruleId,
    source,
    outcome,
    evidence: evidenceSpans,
    ...(hardPredicateProven ? { hardPredicateProven: true } : {}),
  };
}

const ACCEPTANCE_HEADING =
  /\b(?:acceptance|success criteria|definition of done|expected outcome)\b|验收|完成条件|成功标准/iu;
const OBSERVED_HEADING =
  /\b(?:observed|actual|current behavior)\b|实际(?:行为|结果)?|当前行为/iu;
const EXPECTED_HEADING =
  /\b(?:expected|desired behavior)\b|预期(?:行为|结果)?/iu;
const REPRODUCTION_HEADING =
  /\b(?:reproduction|steps to reproduce|repro)\b|复现(?:步骤)?/iu;
const VALIDATION_HEADING =
  /\b(?:validation|verification|test plan|testing)\b|验证|测试计划/iu;
const ENVIRONMENT_HEADING =
  /\b(?:environment|prerequisites?|configuration)\b|环境|前置条件|配置/iu;
const GOAL_HEADING =
  /\b(?:goal|task|deliverable|objective)\b|目标|任务|交付物/iu;
const NAVIGATION_HINT =
  /(?:^|[\s(])(?:src|lib|app|apps|packages|test|tests|docs)\/[A-Za-z0-9_.\-/]+|`[A-Za-z_$][A-Za-z0-9_$.]*(?:\([^`]*\))?`/gmu;
const DEPENDENCY_HINT =
  /\b(?:depends on|blocked by|dependency|requires version|package version)\b|依赖|阻塞于/giu;
const VERSION_HINT =
  /\bv?\d+\.\d+(?:\.\d+)?\b|\b(?:deprecated|end[- ]of[- ]life)\b/giu;
const INTERNAL_REFERENCE =
  /(?:^|\s)#\d+\b|https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/\d+/giu;

function deterministicSnapshotSignals(
  snapshot: ImmutableIssueSnapshot,
): readonly RuleSignal[] {
  const signals: RuleSignal[] = [];
  const snapshotValid = verifySnapshot(snapshot);
  if (!snapshotValid) {
    signals.push(
      signal("IR-INP-001", "snapshot-integrity:validation", "FAIL", [], true),
    );
    return signals;
  } else if (
    snapshot.integrity.truncated ||
    snapshot.integrity.omittedBytes > 0
  ) {
    signals.push(
      signal("IR-INP-001", "snapshot-integrity:truncation", "FAIL", [], true),
    );
  } else {
    signals.push(signal("IR-INP-001", "snapshot-integrity:validation", "PASS"));
  }

  if (snapshot.content.title.trim() === "") {
    signals.push(
      signal(
        "IR-DEF-001",
        "issue-title:object-action",
        "FAIL",
        [
          evidence(
            snapshot,
            "issue.title",
            snapshot.content.title,
            0,
            snapshot.content.title.length,
          ),
        ],
        true,
      ),
    );
  } else if (snapshot.content.body.trim() === "") {
    signals.push(
      signal(
        "IR-DEF-001",
        "issue-body:object-action",
        "FAIL",
        [bodyEvidence(snapshot)],
        true,
      ),
    );
  }

  const acceptance = matchingHeadings(snapshot, ACCEPTANCE_HEADING).filter(
    (heading) => sectionHasContent(snapshot, heading),
  );
  if (acceptance.length > 0) {
    signals.push(
      signal(
        "IR-ACC-001",
        "markdown-ast:acceptance-candidate",
        "UNKNOWN",
        headingEvidence(snapshot, acceptance),
      ),
    );
  }

  const observed = matchingHeadings(snapshot, OBSERVED_HEADING).filter(
    (heading) => sectionHasContent(snapshot, heading),
  );
  const expected = matchingHeadings(snapshot, EXPECTED_HEADING).filter(
    (heading) => sectionHasContent(snapshot, heading),
  );
  if (observed.length > 0 && expected.length > 0) {
    signals.push(
      signal(
        "IR-BUG-001",
        "markdown-ast:observed-expected",
        "UNKNOWN",
        headingEvidence(snapshot, [...observed, ...expected]),
      ),
    );
  }

  const reproduction = matchingHeadings(snapshot, REPRODUCTION_HEADING).filter(
    (heading) => sectionHasContent(snapshot, heading),
  );
  if (reproduction.length > 0) {
    signals.push(
      signal(
        "IR-BUG-002",
        "markdown-ast:reproduction",
        "UNKNOWN",
        headingEvidence(snapshot, reproduction),
      ),
    );
  }

  const validation = matchingHeadings(snapshot, VALIDATION_HEADING).filter(
    (heading) => sectionHasContent(snapshot, heading),
  );
  if (validation.length > 0) {
    signals.push(
      signal(
        "IR-VAL-001",
        "markdown-ast:validation-candidate",
        "UNKNOWN",
        headingEvidence(snapshot, validation),
      ),
    );
  }

  const environment = matchingHeadings(snapshot, ENVIRONMENT_HEADING).filter(
    (heading) => sectionHasContent(snapshot, heading),
  );
  if (environment.length > 0) {
    signals.push(
      signal(
        "IR-CTX-002",
        "markdown-ast:environment",
        "UNKNOWN",
        headingEvidence(snapshot, environment),
      ),
    );
  }

  const navigation = [
    ...regexpEvidence(snapshot, NAVIGATION_HINT),
    ...snapshot.content.normalization.links.map((link) =>
      bodyEvidence(snapshot, link.span.startUtf16, link.span.endUtf16),
    ),
  ];
  signals.push(
    signal(
      "IR-CTX-001",
      "markdown-ast:code-symbol-link",
      navigation.length > 0 ? "PASS" : "FAIL",
      navigation,
    ),
  );

  const goalHeadings = matchingHeadings(snapshot, GOAL_HEADING);
  if (goalHeadings.length > 0) {
    const independentGoals = independentlyAcceptedGoals(snapshot, goalHeadings);
    signals.push(
      signal(
        "IR-SCP-001",
        "markdown-ast:goal-structure",
        "UNKNOWN",
        headingEvidence(snapshot, goalHeadings),
      ),
      signal(
        "IR-SCP-002",
        "markdown-ast:independent-goals",
        independentGoals.length > 1 ? "FAIL" : "UNKNOWN",
        headingEvidence(
          snapshot,
          independentGoals.length > 1 ? independentGoals : goalHeadings,
        ),
        independentGoals.length > 1,
      ),
    );
  }

  const references = regexpEvidence(snapshot, INTERNAL_REFERENCE);
  const referenceResolution = nativeReferenceResolution(snapshot, references);
  signals.push(
    signal(
      "IR-TRC-001",
      references.length === 0
        ? "markdown-ast:internal-reference"
        : "github-reference:resolution-state",
      referenceResolution.traceOutcome,
      references,
    ),
    signal(
      "IR-CTX-003",
      references.length === 0
        ? "snapshot-context:availability"
        : "github-reference:access-state",
      referenceResolution.contextOutcome,
      references,
      referenceResolution.contextHardPredicateProven,
    ),
  );

  const dependencies = regexpEvidence(snapshot, DEPENDENCY_HINT);
  const nativeDependencies =
    snapshot.native.blockedBy.length + snapshot.native.blocking.length;
  signals.push(
    signal(
      "IR-DEP-001",
      nativeDependencies > 0
        ? "native-relationships:dependencies"
        : "markdown-ast:dependency-reference",
      dependencies.length === 0 && nativeDependencies === 0
        ? "NOT_APPLICABLE"
        : "UNKNOWN",
      dependencies,
    ),
  );

  const versions = regexpEvidence(snapshot, VERSION_HINT);
  signals.push(
    signal(
      "IR-FRESH-001",
      "native-relationships:state",
      versions.length === 0 ? "NOT_APPLICABLE" : "UNKNOWN",
      versions,
    ),
  );
  return signals;
}

function policyDispositionSignal(
  policyDisposition: PolicyDisposition,
): RuleSignal {
  const strongestReason = [...policyDisposition.reasons]
    .reverse()
    .find((reason) => reason.disposition === policyDisposition.disposition);
  const source =
    strongestReason?.source === "NATIVE_ISSUE_TYPE"
      ? "native-issue-type:mapped-policy"
      : strongestReason?.source === "TRUSTED_LABEL"
        ? "trusted-label:mapped-policy"
        : "repository-policy:delegation-map";
  return {
    ruleId: "IR-POL-001",
    source,
    outcome: policyDisposition.disposition === "CANDIDATE" ? "PASS" : "FAIL",
    evidence: [],
    policyEffect:
      policyDisposition.disposition === "CANDIDATE"
        ? "NONE"
        : policyDisposition.disposition,
    ...(policyDisposition.disposition === "CANDIDATE"
      ? {}
      : {
          hardPredicateProven: true,
          independentHardBoundary: true,
        }),
  };
}

export function executeDeterministicSnapshot(
  input: ExecuteDeterministicSnapshotInput,
): RuleExecutionResult {
  const taskPack = input.taskPacks.find((pack) => pack.id === input.taskType);
  if (taskPack === undefined) {
    throw new TypeError(`Missing registered task pack: ${input.taskType}`);
  }
  const assignedRuleIds = new Set(
    BUCKETS.flatMap((bucket) => taskPack.criteria[bucket]),
  );
  const signals = [
    ...deterministicSnapshotSignals(input.snapshot).filter((candidate) =>
      assignedRuleIds.has(candidate.ruleId),
    ),
    ...(input.policyDisposition === undefined
      ? []
      : [policyDispositionSignal(input.policyDisposition)]),
    ...(input.additionalSignals ?? []),
  ];
  return executeTaskPack({
    taskType: input.taskType,
    rules: input.rules,
    taskPacks: input.taskPacks,
    signals,
    snapshotValid: verifySnapshot(input.snapshot),
  });
}
