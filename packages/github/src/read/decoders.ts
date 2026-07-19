import type { GithubReadResult } from "./index.js";

const MAX_NATIVE_ITEMS = 100;
const ISSUE_URL =
  /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/(issues|pull)\/([1-9][0-9]*)$/u;
const ISSUE_TYPE_COLORS = new Set([
  "BLUE",
  "GRAY",
  "GREEN",
  "ORANGE",
  "PINK",
  "PURPLE",
  "RED",
  "YELLOW",
]);
const FIELD_DATA_TYPES = new Set([
  "text",
  "single_select",
  "number",
  "date",
  "multi_select",
]);

export const GITHUB_ISSUE_TYPE_QUERY = `
  query IssueReadyIssueType($owner: String!, $repository: String!, $number: Int!) {
    repository(owner: $owner, name: $repository) {
      issue(number: $number) {
        issueType {
          id
          name
          description
          color
          isEnabled
        }
      }
    }
  }
`;

interface DecodeSuccess<Value> {
  readonly ok: true;
  readonly value: Value;
}

interface DecodeFailure {
  readonly ok: false;
}

type DecodeResult<Value> = DecodeSuccess<Value> | DecodeFailure;

export interface GithubDecodedIssue {
  readonly id: number;
  readonly nodeId: string;
  readonly url: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly kind: "ISSUE" | "PULL_REQUEST";
  readonly state: string;
  readonly title: string;
}

export interface GithubDecodedFieldOption {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

export type GithubIssueFieldDataType =
  "text" | "single_select" | "number" | "date" | "multi_select";

export interface GithubDecodedIssueFieldValue {
  readonly id: number;
  readonly nodeId: string;
  readonly name: string;
  readonly dataType: GithubIssueFieldDataType;
  readonly value: string | number | null;
  readonly singleSelectOption?: GithubDecodedFieldOption;
  readonly multiSelectOptions?: readonly GithubDecodedFieldOption[];
}

export type GithubIssueTypeColor =
  "BLUE" | "GRAY" | "GREEN" | "ORANGE" | "PINK" | "PURPLE" | "RED" | "YELLOW";

export interface GithubDecodedIssueType {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly color: GithubIssueTypeColor;
  readonly isEnabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function success<Value>(value: Value): DecodeSuccess<Value> {
  return { ok: true, value };
}

function failure(): DecodeFailure {
  return { ok: false };
}

function protocolError<Value>(
  result: GithubReadResult<unknown>,
): GithubReadResult<Value> {
  return {
    outcome: "UNKNOWN",
    reason: "PROTOCOL_ERROR",
    data: null,
    requests: result.requests,
    etag: result.etag,
    rateLimit: result.rateLimit,
  };
}

function mapDecodedResult<Value>(
  result: GithubReadResult<unknown>,
  decode: (value: unknown) => DecodeResult<Value>,
): GithubReadResult<Value> {
  switch (result.outcome) {
    case "NOT_MODIFIED":
    case "UNAVAILABLE":
      return result;
    case "OK": {
      const decoded = decode(result.data);
      return decoded.ok
        ? { ...result, data: decoded.value }
        : protocolError(result);
    }
    case "UNKNOWN": {
      if (result.data === null) return { ...result, data: null };
      const decoded = decode(result.data);
      return decoded.ok
        ? { ...result, data: decoded.value }
        : protocolError(result);
    }
  }
}

function decodeIssue(value: unknown): DecodeResult<GithubDecodedIssue> {
  if (!isRecord(value)) return failure();
  const id = value["id"];
  const nodeId = value["node_id"];
  const htmlUrl = value["html_url"];
  const number = value["number"];
  const state = value["state"];
  const title = value["title"];
  if (
    !isPositiveInteger(id) ||
    !isNonEmptyString(nodeId) ||
    !isNonEmptyString(htmlUrl) ||
    !isPositiveInteger(number) ||
    !isNonEmptyString(state) ||
    typeof title !== "string"
  ) {
    return failure();
  }
  const match = ISSUE_URL.exec(htmlUrl);
  const urlNumber = match?.[4] === undefined ? null : Number(match[4]);
  if (
    match === null ||
    !Number.isSafeInteger(urlNumber) ||
    urlNumber !== number
  ) {
    return failure();
  }
  const owner = match[1];
  const repository = match[2];
  const pathKind = match[3];
  if (
    owner === undefined ||
    repository === undefined ||
    pathKind === undefined
  ) {
    return failure();
  }
  const pullRequest = value["pull_request"];
  if (pullRequest !== undefined && !isRecord(pullRequest)) return failure();
  const kind = pullRequest === undefined ? "ISSUE" : "PULL_REQUEST";
  if (
    (kind === "ISSUE" && pathKind !== "issues") ||
    (kind === "PULL_REQUEST" && pathKind !== "pull")
  ) {
    return failure();
  }
  return success({
    id,
    nodeId,
    url: htmlUrl,
    owner,
    repository,
    number,
    kind,
    state,
    title,
  });
}

function decodeIssueList(
  value: unknown,
): DecodeResult<readonly GithubDecodedIssue[]> {
  if (!Array.isArray(value) || value.length > MAX_NATIVE_ITEMS)
    return failure();
  const issues: GithubDecodedIssue[] = [];
  const nodeIds = new Set<string>();
  for (const item of value) {
    const issue = decodeIssue(item);
    if (!issue.ok || nodeIds.has(issue.value.nodeId)) return failure();
    nodeIds.add(issue.value.nodeId);
    issues.push(issue.value);
  }
  return success(issues);
}

function decodeFieldOption(
  value: unknown,
): DecodeResult<GithubDecodedFieldOption> {
  if (!isRecord(value)) return failure();
  const id = value["id"];
  const name = value["name"];
  const color = value["color"];
  return isPositiveInteger(id) &&
    isNonEmptyString(name) &&
    isNonEmptyString(color)
    ? success({ id, name, color })
    : failure();
}

function decodeFieldOptions(
  value: unknown,
): DecodeResult<readonly GithubDecodedFieldOption[]> {
  if (!Array.isArray(value) || value.length > MAX_NATIVE_ITEMS)
    return failure();
  const options: GithubDecodedFieldOption[] = [];
  const ids = new Set<number>();
  for (const rawOption of value) {
    const option = decodeFieldOption(rawOption);
    if (!option.ok || ids.has(option.value.id)) return failure();
    ids.add(option.value.id);
    options.push(option.value);
  }
  return success(options);
}

function valueMatchesDataType(
  dataType: GithubIssueFieldDataType,
  value: unknown,
): value is string | number | null {
  if (value === null) return true;
  switch (dataType) {
    case "text":
    case "date":
    case "multi_select":
      return typeof value === "string";
    case "single_select":
    case "number":
      return typeof value === "number" && Number.isFinite(value);
  }
}

function decodeFieldValue(
  value: unknown,
): DecodeResult<GithubDecodedIssueFieldValue> {
  if (!isRecord(value)) return failure();
  const id = value["issue_field_id"];
  const name = value["issue_field_name"];
  const nodeId = value["node_id"];
  const dataType = value["data_type"];
  const fieldValue = value["value"];
  if (
    !isPositiveInteger(id) ||
    !isNonEmptyString(name) ||
    !isNonEmptyString(nodeId) ||
    !isNonEmptyString(dataType) ||
    !FIELD_DATA_TYPES.has(dataType)
  ) {
    return failure();
  }
  const knownDataType = dataType as GithubIssueFieldDataType;
  if (!valueMatchesDataType(knownDataType, fieldValue)) return failure();
  const base = {
    id,
    nodeId,
    name,
    dataType: knownDataType,
    value: fieldValue,
  };
  switch (knownDataType) {
    case "single_select": {
      const rawOption = value["single_select_option"];
      if (fieldValue === null && rawOption === undefined) return success(base);
      const option = decodeFieldOption(rawOption);
      return option.ok && fieldValue === option.value.id
        ? success({ ...base, singleSelectOption: option.value })
        : failure();
    }
    case "multi_select": {
      const rawOptions = value["multi_select_options"];
      if (fieldValue === null && rawOptions === undefined) return success(base);
      const options = decodeFieldOptions(rawOptions);
      return options.ok
        ? success({ ...base, multiSelectOptions: options.value })
        : failure();
    }
    case "text":
    case "number":
    case "date":
      return value["single_select_option"] === undefined &&
        value["multi_select_options"] === undefined
        ? success(base)
        : failure();
  }
}

function decodeFieldValueList(
  value: unknown,
): DecodeResult<readonly GithubDecodedIssueFieldValue[]> {
  if (!Array.isArray(value) || value.length > MAX_NATIVE_ITEMS)
    return failure();
  const fields: GithubDecodedIssueFieldValue[] = [];
  const ids = new Set<number>();
  const nodeIds = new Set<string>();
  for (const rawField of value) {
    const field = decodeFieldValue(rawField);
    if (
      !field.ok ||
      ids.has(field.value.id) ||
      nodeIds.has(field.value.nodeId)
    ) {
      return failure();
    }
    ids.add(field.value.id);
    nodeIds.add(field.value.nodeId);
    fields.push(field.value);
  }
  return success(fields);
}

function decodeIssueType(
  value: unknown,
): DecodeResult<GithubDecodedIssueType | null> {
  if (!isRecord(value)) return failure();
  const repository = value["repository"];
  if (!isRecord(repository)) return failure();
  const issue = repository["issue"];
  if (!isRecord(issue)) return failure();
  const issueType = issue["issueType"];
  if (issueType === null) return success(null);
  if (!isRecord(issueType)) return failure();
  const id = issueType["id"];
  const name = issueType["name"];
  const description = issueType["description"];
  const color = issueType["color"];
  const isEnabled = issueType["isEnabled"];
  if (
    !isNonEmptyString(id) ||
    !isNonEmptyString(name) ||
    (description !== null && typeof description !== "string") ||
    !isNonEmptyString(color) ||
    !ISSUE_TYPE_COLORS.has(color) ||
    typeof isEnabled !== "boolean"
  ) {
    return failure();
  }
  return success({
    id,
    name,
    description,
    color: color as GithubIssueTypeColor,
    isEnabled,
  });
}

export function decodeRestIssueResult(
  result: GithubReadResult<unknown>,
): GithubReadResult<GithubDecodedIssue> {
  return mapDecodedResult(result, decodeIssue);
}

export function decodeRestIssueListResult(
  result: GithubReadResult<unknown>,
): GithubReadResult<readonly GithubDecodedIssue[]> {
  return mapDecodedResult(result, decodeIssueList);
}

export function decodeIssueFieldValuesResult(
  result: GithubReadResult<unknown>,
): GithubReadResult<readonly GithubDecodedIssueFieldValue[]> {
  return mapDecodedResult(result, decodeFieldValueList);
}

export function decodeGraphqlIssueTypeResult(
  result: GithubReadResult<unknown>,
): GithubReadResult<GithubDecodedIssueType | null> {
  return mapDecodedResult(result, decodeIssueType);
}
