import { access, readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateIssue,
  loadPolicy,
  normalizeIssue,
  renderReport,
  type EvaluationAssets,
  type NormalizeIssueInput,
} from "@issueready/core";
import {
  TASK_TYPES,
  type EvidenceSpan,
  type Sha256Digest,
  type TaskType,
} from "@issueready/domain";
import type { RuleSignal } from "@issueready/rules";
import type {
  CuratedIssueFixtureCatalogV1Alpha1,
  IssueReadyPolicyV1Alpha1,
  IssueReadyReportV1Alpha1,
  LocaleBundleV1Alpha1,
  RuleManifestV1Alpha1,
  TaskPackManifestV1Alpha1,
} from "@issueready/schema";

export const CLI_VERSION = "0.1.0";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_ISSUE_BYTES = 131_072;
const MAX_GITHUB_RESPONSE_BYTES = 1_048_576;
const GITHUB_TIMEOUT_MS = 15_000;

export type CliFormat = "summary" | "markdown" | "json";
export type DemoName = "ready" | "needs-info";

export interface CliEnvironment {
  readonly GITHUB_TOKEN?: string;
  readonly GH_TOKEN?: string;
}

export interface EvaluateTargetOptions {
  readonly cwd: string;
  readonly environment?: CliEnvironment;
  readonly fetch?: typeof globalThis.fetch;
  readonly taskType?: TaskType;
  readonly includeEvidenceQuotes?: boolean;
  readonly now?: () => Date;
}

export interface CliEvaluation {
  readonly report: IssueReadyReportV1Alpha1;
  readonly localeBundle: LocaleBundleV1Alpha1;
  readonly sourceLabel: string;
  readonly blockingRuleIds: readonly string[];
}

export interface CliIo {
  readonly stdout: { write(value: string): void };
  readonly stderr: { write(value: string): void };
}

type Fixture = CuratedIssueFixtureCatalogV1Alpha1["fixtures"][number];
type EvidenceBinding = Fixture["semanticSignals"][number]["evidence"][number];

interface LoadedSource {
  readonly input: NormalizeIssueInput;
  readonly sourceLabel: string;
  readonly inferredTaskType?: TaskType;
  readonly truncated?: boolean;
  readonly omittedBytes?: number;
}

interface ParsedArguments {
  readonly command: "help" | "version" | "evaluate" | "demo";
  readonly target?: string;
  readonly demo?: DemoName;
  readonly format: CliFormat;
  readonly taskType?: TaskType;
  readonly includeEvidenceQuotes: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assetRoot(): Promise<string> {
  const packaged = fileURLToPath(new URL("./assets/", import.meta.url));
  if (await pathExists(resolve(packaged, "rules/catalog/v1alpha1"))) {
    return packaged;
  }
  return fileURLToPath(new URL("../../../", import.meta.url));
}

async function readJson<Value>(root: string, path: string): Promise<Value> {
  return JSON.parse(await readFile(resolve(root, path), "utf8")) as Value;
}

async function readJsonDirectory<Value>(
  root: string,
  path: string,
): Promise<readonly Value[]> {
  const directory = resolve(root, path);
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  return Promise.all(
    files.map((name) => readJson<Value>(root, resolve(path, name))),
  );
}

async function loadAssets(): Promise<{
  readonly root: string;
  readonly evaluation: EvaluationAssets;
  readonly policy: IssueReadyPolicyV1Alpha1;
}> {
  const root = await assetRoot();
  const [rules, taskPacks, localeBundle, policy] = await Promise.all([
    readJsonDirectory<RuleManifestV1Alpha1>(root, "rules/catalog/v1alpha1"),
    readJsonDirectory<TaskPackManifestV1Alpha1>(
      root,
      "rules/task-packs/v1alpha1",
    ),
    readJson<LocaleBundleV1Alpha1>(root, "locales/en/v1alpha1.json"),
    readJson<IssueReadyPolicyV1Alpha1>(root, "fixtures/policies/default.json"),
  ]);
  return {
    root,
    evaluation: { rules, taskPacks, localeBundle },
    policy,
  };
}

function titleFromMarkdown(body: string): string {
  return (
    body
      .split(/\r?\n/u)
      .find((line) => line.startsWith("# "))
      ?.slice(2)
      .trim() ?? "Local issue"
  );
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function inferTaskType(labels: readonly string[]): TaskType | undefined {
  const normalized = new Set(labels.map((label) => label.trim().toLowerCase()));
  if (normalized.has("bug")) return "bug";
  if (normalized.has("documentation") || normalized.has("docs")) return "docs";
  if (normalized.has("dependencies") || normalized.has("dependency")) {
    return "dependency";
  }
  if (normalized.has("refactor")) return "refactor";
  if (normalized.has("ci") || normalized.has("tests")) return "test-ci";
  if (normalized.has("operations") || normalized.has("ops")) {
    return "operations";
  }
  if (normalized.has("enhancement") || normalized.has("feature")) {
    return "feature";
  }
  return undefined;
}

async function loadLocalIssue(
  target: string,
  cwd: string,
): Promise<LoadedSource> {
  const path = resolve(cwd, target);
  const metadata = await stat(path).catch(() => {
    throw new Error("Local issue file was not found");
  });
  if (!metadata.isFile()) throw new Error("Local issue input must be a file");
  if (metadata.size > MAX_ISSUE_BYTES) {
    throw new Error(`Local issue exceeds the ${MAX_ISSUE_BYTES}-byte limit`);
  }
  const body = await readFile(path, "utf8");
  if (Buffer.byteLength(body, "utf8") > MAX_ISSUE_BYTES) {
    throw new Error(`Local issue exceeds the ${MAX_ISSUE_BYTES}-byte limit`);
  }
  return {
    input: {
      source: {
        kind: "local",
        path: normalizePath(relative(cwd, path) || target),
        updatedAt: metadata.mtime.toISOString(),
      },
      title: titleFromMarkdown(body),
      body,
    },
    sourceLabel: normalizePath(relative(cwd, path) || target),
  };
}

interface GithubLocator {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly label: string;
}

function validGithubName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/u.test(value) && value !== "." && value !== "..";
}

export function parseGithubLocator(target: string): GithubLocator | null {
  const shorthand =
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/u.exec(target);
  if (shorthand !== null) {
    const [, owner = "", repository = "", rawNumber = ""] = shorthand;
    const number = Number(rawNumber);
    if (
      validGithubName(owner) &&
      validGithubName(repository) &&
      Number.isSafeInteger(number)
    ) {
      return {
        owner,
        repository,
        number,
        label: `https://github.com/${owner}/${repository}/issues/${number}`,
      };
    }
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[2] !== "issues") return null;
  const [owner = "", repository = "", , rawNumber = ""] = segments;
  const number = Number(rawNumber);
  if (
    !validGithubName(owner) ||
    !validGithubName(repository) ||
    !/^[1-9][0-9]*$/u.test(rawNumber) ||
    !Number.isSafeInteger(number)
  ) {
    return null;
  }
  return {
    owner,
    repository,
    number,
    label: url.toString(),
  };
}

async function boundedResponseText(
  response: Response,
  maximum: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^[0-9]+$/u.test(contentLength)) {
    const declared = Number(contentLength);
    if (Number.isSafeInteger(declared) && declared > maximum) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("GitHub response exceeded the configured size limit");
    }
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new Error("GitHub response exceeded the configured size limit");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("GitHub returned a non-UTF-8 response");
  }
}

function githubToken(environment: CliEnvironment): string | undefined {
  const token = environment.GITHUB_TOKEN ?? environment.GH_TOKEN;
  if (token === undefined || token === "") return undefined;
  if (token.length > 8192 || token.trim() !== token || /\s/u.test(token)) {
    throw new Error("The configured GitHub token is malformed");
  }
  return token;
}

function githubLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((label) => {
    if (typeof label === "string") return [label];
    if (!isRecord(label) || typeof label["name"] !== "string") return [];
    return [label["name"]];
  });
}

function boundedUtf8(
  value: string,
  maximum: number,
): {
  readonly value: string;
  readonly truncated: boolean;
  readonly omittedBytes: number;
} {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximum) {
    return { value, truncated: false, omittedBytes: 0 };
  }
  let end = maximum;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) end -= 1;
  const bounded = bytes.subarray(0, end).toString("utf8");
  return {
    value: bounded,
    truncated: true,
    omittedBytes: bytes.byteLength - Buffer.byteLength(bounded, "utf8"),
  };
}

async function loadGithubIssue(
  locator: GithubLocator,
  environment: CliEnvironment,
  fetchImplementation: typeof globalThis.fetch,
): Promise<LoadedSource> {
  const token = githubToken(environment);
  const headers = new Headers({
    accept: "application/vnd.github+json",
    "user-agent": `IssueReady/${CLI_VERSION}`,
    "x-github-api-version": GITHUB_API_VERSION,
  });
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.repository)}/issues/${locator.number}`,
      {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      },
    );
  } catch {
    throw new Error("Unable to read the GitHub issue");
  }
  const raw = await boundedResponseText(response, MAX_GITHUB_RESPONSE_BYTES);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "GitHub denied the request; set GITHUB_TOKEN for private repositories or higher rate limits",
      );
    }
    if (response.status === 404) throw new Error("GitHub issue was not found");
    throw new Error(`GitHub returned HTTP ${response.status}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("GitHub returned malformed JSON");
  }
  if (
    !isRecord(data) ||
    typeof data["title"] !== "string" ||
    (typeof data["body"] !== "string" && data["body"] !== null) ||
    typeof data["updated_at"] !== "string"
  ) {
    throw new Error("GitHub returned an unsupported issue response");
  }
  if (data["pull_request"] !== undefined) {
    throw new Error(
      "Pull request URLs are not supported; provide a GitHub issue",
    );
  }
  const labels = githubLabels(data["labels"]);
  const inferredTaskType = inferTaskType(labels);
  const body = boundedUtf8(data["body"] ?? "", MAX_ISSUE_BYTES);
  const authorAssociation =
    typeof data["author_association"] === "string"
      ? data["author_association"]
      : undefined;
  return {
    input: {
      source: {
        kind: "github",
        owner: locator.owner,
        repository: locator.repository,
        number: locator.number,
        updatedAt: data["updated_at"],
        apiVersion: GITHUB_API_VERSION,
        etag: response.headers.get("etag"),
      },
      title: data["title"],
      body: body.value,
      labels,
      ...(authorAssociation === undefined
        ? {}
        : { accessContext: { authorAssociation } }),
    },
    sourceLabel: locator.label,
    ...(inferredTaskType === undefined ? {} : { inferredTaskType }),
    ...(body.truncated
      ? { truncated: true, omittedBytes: body.omittedBytes }
      : {}),
  };
}

async function loadTarget(
  target: string,
  options: EvaluateTargetOptions,
): Promise<LoadedSource> {
  const locator = parseGithubLocator(target);
  if (locator === null) return loadLocalIssue(target, options.cwd);
  return loadGithubIssue(
    locator,
    options.environment ?? {},
    options.fetch ?? globalThis.fetch,
  );
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function bindEvidence(
  fixture: Fixture,
  binding: EvidenceBinding,
  snapshotDigest: Sha256Digest,
): EvidenceSpan {
  const source =
    binding.document === "issue.title"
      ? fixture.input.title
      : fixture.input.body;
  const startUtf16 = source.indexOf(binding.quote);
  if (startUtf16 < 0) throw new Error("Bundled demo evidence is invalid");
  const endUtf16 = startUtf16 + binding.quote.length;
  return {
    document: binding.document,
    startUtf16,
    endUtf16,
    lineStart: lineAt(source, startUtf16),
    lineEnd: lineAt(source, Math.max(startUtf16, endUtf16 - 1)),
    quote: binding.quote,
    snapshotDigest,
  };
}

function evaluationOptions(
  assets: EvaluationAssets,
  generatedAt: string,
  includeEvidenceQuotes: boolean,
) {
  return {
    assets,
    coreVersion: CLI_VERSION,
    agentCapabilityProfile: "generic-coding-agent-v1",
    supervisionProfile: "maintainer-review-v1",
    generatedAt,
    includeEvidenceQuotes,
  } as const;
}

function blockingRuleIds(
  report: IssueReadyReportV1Alpha1,
  rules: readonly RuleManifestV1Alpha1[],
): readonly string[] {
  const effects = new Map(
    rules.map((rule) => [rule.id, rule.onFail.specEffect] as const),
  );
  return report.canonicalFindings
    .filter(
      (finding) =>
        finding.outcome === "FAIL" && effects.get(finding.ruleId) !== "NONE",
    )
    .map((finding) => finding.ruleId)
    .sort();
}

export async function evaluateTarget(
  target: string,
  options: EvaluateTargetOptions,
): Promise<CliEvaluation> {
  const [assets, source] = await Promise.all([
    loadAssets(),
    loadTarget(target, options),
  ]);
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const snapshot = normalizeIssue(source.input, {
    evaluatedAt: generatedAt,
    truncated: source.truncated ?? false,
    omittedBytes: source.omittedBytes ?? 0,
  });
  const selectedTaskType = options.taskType ?? source.inferredTaskType;
  const report = evaluateIssue(
    snapshot,
    loadPolicy([{ source: "BUILT_IN", policy: assets.policy }]),
    {
      ...evaluationOptions(
        assets.evaluation,
        generatedAt,
        options.includeEvidenceQuotes ?? false,
      ),
      ...(selectedTaskType === undefined
        ? {}
        : { deterministicTaskHint: selectedTaskType }),
    },
  );
  return {
    report,
    localeBundle: assets.evaluation.localeBundle,
    sourceLabel: source.sourceLabel,
    blockingRuleIds: blockingRuleIds(report, assets.evaluation.rules),
  };
}

const DEMO_IDS: Readonly<Record<DemoName, string>> = {
  ready: "curated-bug-reconnect-deduplication",
  "needs-info": "curated-feature-export-date-filter",
};

export async function evaluateDemo(
  name: DemoName,
  options: Pick<EvaluateTargetOptions, "includeEvidenceQuotes"> = {},
): Promise<CliEvaluation> {
  const assets = await loadAssets();
  const catalog = await readJson<CuratedIssueFixtureCatalogV1Alpha1>(
    assets.root,
    "fixtures/issues/curated-semantic.v1alpha1.json",
  );
  const fixture = catalog.fixtures.find(
    (candidate) => candidate.id === DEMO_IDS[name],
  );
  if (fixture === undefined) throw new Error("Bundled demo fixture is missing");
  const generatedAt = "2026-07-19T00:00:00Z";
  const snapshot = normalizeIssue(
    {
      source: {
        kind: "local",
        path: `bundled-demo/${name}.md`,
        updatedAt: null,
      },
      title: fixture.input.title,
      body: fixture.input.body,
      labels: fixture.input.labels,
    },
    { evaluatedAt: generatedAt },
  );
  const semanticRuleSignals: readonly RuleSignal[] =
    fixture.semanticSignals.map((semanticSignal) => ({
      ruleId: semanticSignal.ruleId,
      source: semanticSignal.source,
      outcome: semanticSignal.outcome,
      evidence: semanticSignal.evidence.map((binding) =>
        bindEvidence(
          fixture,
          binding,
          snapshot.integrity.snapshotDigest as Sha256Digest,
        ),
      ),
    }));
  const report = evaluateIssue(
    snapshot,
    loadPolicy([{ source: "BUILT_IN", policy: assets.policy }]),
    {
      ...evaluationOptions(
        assets.evaluation,
        generatedAt,
        options.includeEvidenceQuotes ?? false,
      ),
      explicitTaskType: fixture.taskType,
      changedPaths: fixture.input.changedPaths,
      adapters: {
        semanticRuleSignals,
        semanticProfileDigest: catalog.semanticProfile.digest as Sha256Digest,
      },
    },
  );
  return {
    report,
    localeBundle: assets.evaluation.localeBundle,
    sourceLabel: `bundled demo: ${name}`,
    blockingRuleIds: blockingRuleIds(report, assets.evaluation.rules),
  };
}

function displayVerdict(value: string | null): string {
  return value ?? "INDETERMINATE";
}

export function renderSummary(evaluation: CliEvaluation): string {
  const { report } = evaluation;
  const otherFailures = report.canonicalFindings
    .filter((finding) => finding.outcome === "FAIL")
    .map((finding) => finding.ruleId)
    .filter((ruleId) => !evaluation.blockingRuleIds.includes(ruleId))
    .sort();
  const unknowns = report.canonicalFindings.filter(
    (finding) => finding.outcome === "UNKNOWN",
  ).length;
  const lines = [
    `IssueReady ${CLI_VERSION}`,
    `Source:        ${evaluation.sourceLabel}`,
    `Task:          ${report.taskType.id}`,
    `Evaluation:    ${report.evaluationStatus}`,
    `Specification: ${displayVerdict(report.specVerdict)}`,
    `Delegation:    ${report.delegationDisposition}`,
    `Blocking checks: ${evaluation.blockingRuleIds.length === 0 ? "none" : evaluation.blockingRuleIds.join(", ")}`,
  ];
  if (otherFailures.length > 0) {
    lines.push(`Other failed checks: ${otherFailures.join(", ")}`);
  }
  if (unknowns > 0) lines.push(`Unknown checks: ${unknowns}`);
  if (report.evaluationReasons.includes("IR-SEM-000")) {
    lines.push(
      "Note: semantic coverage was not supplied; deterministic evidence is still reported.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderEvaluation(
  evaluation: CliEvaluation,
  format: CliFormat,
): string {
  if (format === "summary") return renderSummary(evaluation);
  return `${renderReport(evaluation.report, format, {
    localeBundle: evaluation.localeBundle,
    prettyJson: format === "json",
  }).trimEnd()}\n`;
}

function parseTaskType(value: string): TaskType {
  if (!(TASK_TYPES as readonly string[]).includes(value)) {
    throw new Error(`Unknown task type: ${value}`);
  }
  return value as TaskType;
}

function parseFormat(value: string): CliFormat {
  if (value !== "summary" && value !== "markdown" && value !== "json") {
    throw new Error(`Unknown output format: ${value}`);
  }
  return value;
}

export function parseArguments(arguments_: readonly string[]): ParsedArguments {
  if (arguments_.length === 0 || arguments_.includes("--help")) {
    return { command: "help", format: "summary", includeEvidenceQuotes: false };
  }
  if (arguments_.includes("--version")) {
    return {
      command: "version",
      format: "summary",
      includeEvidenceQuotes: false,
    };
  }
  let format: CliFormat = "summary";
  let taskType: TaskType | undefined;
  let includeEvidenceQuotes = false;
  const positional: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    if (argument === "--include-quotes") {
      includeEvidenceQuotes = true;
      continue;
    }
    if (argument === "--format" || argument === "--task-type") {
      const value = arguments_[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      if (argument === "--format") format = parseFormat(value);
      else taskType = parseTaskType(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--format=")) {
      format = parseFormat(argument.slice("--format=".length));
      continue;
    }
    if (argument.startsWith("--task-type=")) {
      taskType = parseTaskType(argument.slice("--task-type=".length));
      continue;
    }
    if (argument.startsWith("-"))
      throw new Error(`Unknown option: ${argument}`);
    positional.push(argument);
  }
  if (positional[0] === "demo") {
    const demo = positional[1];
    if (demo !== "ready" && demo !== "needs-info") {
      throw new Error("Demo must be either ready or needs-info");
    }
    if (positional.length !== 2) throw new Error("Demo accepts one name");
    return {
      command: "demo",
      demo,
      format,
      ...(taskType === undefined ? {} : { taskType }),
      includeEvidenceQuotes,
    };
  }
  if (positional.length !== 1) {
    throw new Error("Provide one local Markdown file or GitHub issue URL");
  }
  const target = positional[0];
  if (target === undefined) {
    throw new Error("Provide one local Markdown file or GitHub issue URL");
  }
  return {
    command: "evaluate",
    target,
    format,
    ...(taskType === undefined ? {} : { taskType }),
    includeEvidenceQuotes,
  };
}

export function helpText(): string {
  return `IssueReady ${CLI_VERSION}

Evidence-backed readiness checks for GitHub issues.

Usage:
  issueready <issue.md|github-issue-url|owner/repo#number> [options]
  issueready demo <ready|needs-info> [options]

Options:
  --format <summary|markdown|json>  Output format (default: summary)
  --task-type <type>                Override task classification
  --include-quotes                  Include redacted evidence quotes
  --help                            Show help
  --version                         Show version

GitHub reads are bounded and read-only. Set GITHUB_TOKEN for private issues or
higher API rate limits; credentials are never accepted as command arguments.
`;
}

export async function main(
  arguments_: readonly string[],
  io: CliIo,
  options: {
    readonly cwd: string;
    readonly environment?: CliEnvironment;
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => Date;
  },
): Promise<number> {
  try {
    const parsed = parseArguments(arguments_);
    if (parsed.command === "help") {
      io.stdout.write(helpText());
      return 0;
    }
    if (parsed.command === "version") {
      io.stdout.write(`${CLI_VERSION}\n`);
      return 0;
    }
    const evaluation =
      parsed.command === "demo"
        ? await evaluateDemo(parsed.demo ?? "ready", {
            includeEvidenceQuotes: parsed.includeEvidenceQuotes,
          })
        : await evaluateTarget(parsed.target ?? "", {
            cwd: options.cwd,
            ...(options.environment === undefined
              ? {}
              : { environment: options.environment }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(parsed.taskType === undefined
              ? {}
              : { taskType: parsed.taskType }),
            includeEvidenceQuotes: parsed.includeEvidenceQuotes,
          });
    io.stdout.write(renderEvaluation(evaluation, parsed.format));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    io.stderr.write(`IssueReady: ${message}\n`);
    return 1;
  }
}
