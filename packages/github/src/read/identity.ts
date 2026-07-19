export interface GithubIssueIdentityObservation {
  readonly repositoryNodeId: string;
  readonly issueNodeId: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly apiVersion: string;
}

export interface GithubIssueCacheIdentity {
  readonly issueKey: string;
  readonly repositoryKey: string;
  readonly locatorKey: string;
  readonly etagKey: string;
}

export interface GithubIssueCacheTransition {
  readonly sameIssue: boolean;
  readonly sameRepository: boolean;
  readonly sameApiVersion: boolean;
  readonly locatorChanged: boolean;
  readonly reuseEntityCache: boolean;
  readonly reuseEtag: boolean;
}

function validateSegment(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[/?#\s]/u.test(value)
  ) {
    throw new TypeError(`${name} must be a non-empty GitHub path segment`);
  }
}

function validateNodeId(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || /\s/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty GitHub node ID`);
  }
}

function validateObservation(value: GithubIssueIdentityObservation): void {
  validateNodeId(value.repositoryNodeId, "repositoryNodeId");
  validateNodeId(value.issueNodeId, "issueNodeId");
  validateSegment(value.owner, "owner");
  validateSegment(value.repository, "repository");
  if (
    typeof value.apiVersion !== "string" ||
    value.apiVersion.length === 0 ||
    /\s/u.test(value.apiVersion)
  ) {
    throw new TypeError("apiVersion must be a non-empty version identifier");
  }
  if (!Number.isSafeInteger(value.number) || value.number < 1) {
    throw new RangeError("number must be a positive safe integer");
  }
}

function encodedKey(namespace: string, values: readonly string[]): string {
  return `${namespace}:${JSON.stringify(values)}`;
}

export function githubIssueCacheIdentity(
  observation: GithubIssueIdentityObservation,
): GithubIssueCacheIdentity {
  validateObservation(observation);
  return {
    issueKey: encodedKey("github-issue", [observation.issueNodeId]),
    repositoryKey: encodedKey("github-repository", [
      observation.repositoryNodeId,
    ]),
    locatorKey: encodedKey("github-locator", [
      observation.owner.toLowerCase(),
      observation.repository.toLowerCase(),
      String(observation.number),
    ]),
    etagKey: encodedKey("github-etag", [
      observation.owner.toLowerCase(),
      observation.repository.toLowerCase(),
      String(observation.number),
      observation.apiVersion,
    ]),
  };
}

export function compareGithubIssueCacheIdentity(
  previous: GithubIssueIdentityObservation,
  current: GithubIssueIdentityObservation,
): GithubIssueCacheTransition {
  const previousIdentity = githubIssueCacheIdentity(previous);
  const currentIdentity = githubIssueCacheIdentity(current);
  const sameIssue = previousIdentity.issueKey === currentIdentity.issueKey;
  const sameRepository =
    previousIdentity.repositoryKey === currentIdentity.repositoryKey;
  const sameApiVersion = previous.apiVersion === current.apiVersion;
  const locatorChanged =
    previousIdentity.locatorKey !== currentIdentity.locatorKey;
  const reuseEtag =
    sameIssue &&
    sameRepository &&
    !locatorChanged &&
    previousIdentity.etagKey === currentIdentity.etagKey;
  return {
    sameIssue,
    sameRepository,
    sameApiVersion,
    locatorChanged,
    reuseEntityCache: sameIssue && sameApiVersion,
    reuseEtag,
  };
}
