export * from "./consistency.js";
export * from "./decoders.js";
export * from "./execution.js";
export * from "./identity.js";
export * from "./native.js";
export * from "./relationships.js";

export const GITHUB_API_VERSION = "2026-03-10";
export const DEFAULT_MAX_PAGES = 20;
export const HARD_MAX_PAGES = 100;
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
export const HARD_MAX_RESPONSE_BYTES = 8_388_608;
export const DEFAULT_MAX_TOTAL_BYTES = 8_388_608;
export const HARD_MAX_TOTAL_BYTES = 33_554_432;
export const DEFAULT_MAX_REQUEST_BYTES = 262_144;
export const HARD_MAX_REQUEST_BYTES = 1_048_576;
export const DEFAULT_MAX_REDIRECTS = 1;
export const HARD_MAX_REDIRECTS = 3;

export type GithubRequestMethod = "GET" | "POST";

export interface GithubReplayRequest {
  readonly method: GithubRequestMethod;
  readonly resource: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface GithubReplayResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly bodyBytes: number;
}

export interface GithubTransport {
  execute(request: GithubReplayRequest): Promise<GithubReplayResponse>;
}

export interface GithubReplayEntry {
  readonly request: {
    readonly method: GithubRequestMethod;
    readonly resource: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string | null;
  };
  readonly response: GithubReplayResponse;
}

export interface GithubReplayTransport extends GithubTransport {
  consumed(): number;
  remaining(): number;
  assertDrained(): void;
}

export type GithubReadUnknownReason =
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "PARTIAL_RESPONSE"
  | "PROTOCOL_ERROR"
  | "BOUNDS_EXCEEDED";

export type GithubReadUnavailableReason =
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_REQUEST"
  | "API_UNSUPPORTED";

export interface GithubRateLimitState {
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: string | null;
  readonly retryAfterSeconds: number | null;
}

interface GithubReadMetadata {
  readonly requests: number;
  readonly etag: string | null;
  readonly rateLimit: GithubRateLimitState;
}

export type GithubReadResult<Value> =
  | (GithubReadMetadata & {
      readonly outcome: "OK";
      readonly data: Value;
    })
  | (GithubReadMetadata & {
      readonly outcome: "NOT_MODIFIED";
      readonly data: null;
    })
  | (GithubReadMetadata & {
      readonly outcome: "UNAVAILABLE";
      readonly reason: GithubReadUnavailableReason;
      readonly data: null;
    })
  | (GithubReadMetadata & {
      readonly outcome: "UNKNOWN";
      readonly reason: GithubReadUnknownReason;
      readonly data: Value | null;
    });

export interface ReadRestCollectionOptions {
  readonly resource: string;
  readonly etag?: string | null;
  readonly maxPages?: number;
  readonly maxResponseBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxRedirects?: number;
}

export interface ReadRestResourceOptions {
  readonly resource: string;
  readonly etag?: string | null;
  readonly maxResponseBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxRedirects?: number;
}

export interface ReadGraphqlOptions {
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  hardMaximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > hardMaximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${hardMaximum}`);
  }
  return selected;
}

function validateResource(resource: string): void {
  if (
    !resource.startsWith("/") ||
    resource.startsWith("//") ||
    resource.includes("#") ||
    resource.includes("\\") ||
    /[\r\n]/u.test(resource)
  ) {
    throw new TypeError("GitHub resource must be a safe origin-relative path");
  }
}

function baseHeaders(): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function rateLimitState(
  headers: Readonly<Record<string, string>>,
): GithubRateLimitState {
  const normalized = normalizeHeaders(headers);
  const resetSeconds = parseNonNegativeInteger(normalized["x-ratelimit-reset"]);
  const resetDate =
    resetSeconds === null ? null : new Date(resetSeconds * 1000);
  return {
    limit: parseNonNegativeInteger(normalized["x-ratelimit-limit"]),
    remaining: parseNonNegativeInteger(normalized["x-ratelimit-remaining"]),
    resetAt:
      resetDate === null || !Number.isFinite(resetDate.getTime())
        ? null
        : resetDate.toISOString(),
    retryAfterSeconds: parseNonNegativeInteger(normalized["retry-after"]),
  };
}

function metadata(
  response: GithubReplayResponse,
  requests: number,
): GithubReadMetadata {
  const headers = normalizeHeaders(response.headers);
  return {
    requests,
    etag: headers["etag"] ?? null,
    rateLimit: rateLimitState(headers),
  };
}

function unavailableReason(
  response: GithubReplayResponse,
): GithubReadUnavailableReason | null {
  const headers = normalizeHeaders(response.headers);
  switch (response.status) {
    case 401:
      return "PERMISSION_DENIED";
    case 403:
      return headers["x-ratelimit-remaining"] === "0"
        ? null
        : "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 410:
      return "API_UNSUPPORTED";
    case 422:
      return "INVALID_REQUEST";
    default:
      return null;
  }
}

function classifyNonSuccess<Value>(
  response: GithubReplayResponse,
  requests: number,
): GithubReadResult<Value> {
  const shared = metadata(response, requests);
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (shared.rateLimit.remaining === 0 ||
        shared.rateLimit.retryAfterSeconds !== null))
  ) {
    return {
      ...shared,
      outcome: "UNKNOWN",
      reason: "RATE_LIMITED",
      data: null,
    };
  }
  if (response.status >= 500 && response.status <= 599) {
    return {
      ...shared,
      outcome: "UNKNOWN",
      reason: "SERVER_ERROR",
      data: null,
    };
  }
  const reason = unavailableReason(response);
  if (reason !== null) {
    return { ...shared, outcome: "UNAVAILABLE", reason, data: null };
  }
  return {
    ...shared,
    outcome: "UNKNOWN",
    reason: "PROTOCOL_ERROR",
    data: null,
  };
}

function responseIsBounded(
  response: GithubReplayResponse,
  maximum: number,
): boolean {
  return (
    Number.isInteger(response.bodyBytes) &&
    response.bodyBytes >= 0 &&
    response.bodyBytes <= maximum
  );
}

function nextResource(
  linkHeader: string | undefined,
  originalPathname: string,
): string | null | undefined {
  if (linkHeader === undefined) return null;
  for (const part of linkHeader.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/u.exec(part);
    if (match?.[2] !== "next") continue;
    let url: URL;
    try {
      url = new URL(match[1] ?? "");
    } catch {
      return undefined;
    }
    if (
      url.origin !== "https://api.github.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.pathname !== originalPathname
    ) {
      return undefined;
    }
    return `${url.pathname}${url.search}`;
  }
  return null;
}

function redirectResource(location: string | undefined): string | undefined {
  if (location === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(location, "https://api.github.com");
  } catch {
    return undefined;
  }
  if (
    url.origin !== "https://api.github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  const resource = `${url.pathname}${url.search}`;
  try {
    validateResource(resource);
  } catch {
    return undefined;
  }
  return resource;
}

export function createReplayTransport(
  entries: readonly GithubReplayEntry[],
): GithubReplayTransport {
  const tape = structuredClone(entries);
  let cursor = 0;
  return {
    async execute(request): Promise<GithubReplayResponse> {
      const entry = tape[cursor];
      if (entry === undefined) {
        throw new Error(`GitHub replay exhausted at request ${cursor + 1}`);
      }
      const expectedHeaders = normalizeHeaders(entry.request.headers ?? {});
      const actualHeaders = normalizeHeaders(request.headers);
      const headersMatch = Object.entries(expectedHeaders).every(
        ([name, value]) => actualHeaders[name] === value,
      );
      const bodyMatches =
        entry.request.body === undefined || entry.request.body === request.body;
      if (
        entry.request.method !== request.method ||
        entry.request.resource !== request.resource ||
        !headersMatch ||
        !bodyMatches
      ) {
        throw new Error(
          `GitHub replay mismatch at request ${cursor + 1}: expected ${entry.request.method} ${entry.request.resource}, received ${request.method} ${request.resource}`,
        );
      }
      cursor += 1;
      return structuredClone(entry.response);
    },
    consumed(): number {
      return cursor;
    },
    remaining(): number {
      return tape.length - cursor;
    },
    assertDrained(): void {
      if (cursor !== tape.length) {
        throw new Error(
          `GitHub replay has ${tape.length - cursor} unconsumed response(s)`,
        );
      }
    },
  };
}

export async function readRestCollection(
  transport: GithubTransport,
  options: ReadRestCollectionOptions,
): Promise<GithubReadResult<readonly unknown[]>> {
  validateResource(options.resource);
  const maxPages = boundedInteger(
    options.maxPages,
    DEFAULT_MAX_PAGES,
    HARD_MAX_PAGES,
    "maxPages",
  );
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    HARD_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const maxTotalBytes = boundedInteger(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    HARD_MAX_TOTAL_BYTES,
    "maxTotalBytes",
  );
  const maxRedirects = boundedInteger(
    options.maxRedirects,
    DEFAULT_MAX_REDIRECTS,
    HARD_MAX_REDIRECTS,
    "maxRedirects",
  );
  let originalPathname = new URL(options.resource, "https://api.github.com")
    .pathname;
  const visited = new Set<string>();
  const data: unknown[] = [];
  let resource: string | null = options.resource;
  let requests = 0;
  let totalBytes = 0;
  let redirects = 0;
  let lastResponse: GithubReplayResponse | null = null;

  while (resource !== null) {
    if (requests >= maxPages || visited.has(resource)) {
      const fallback =
        lastResponse ??
        ({ status: 0, headers: {}, body: null, bodyBytes: 0 } as const);
      return {
        ...metadata(fallback, requests),
        outcome: "UNKNOWN",
        reason: "BOUNDS_EXCEEDED",
        data,
      };
    }
    visited.add(resource);
    const headers = baseHeaders();
    if (requests === 0 && options.etag !== undefined && options.etag !== null) {
      headers["if-none-match"] = options.etag;
    }
    const response = await transport.execute({
      method: "GET",
      resource,
      headers,
      body: null,
    });
    requests += 1;
    lastResponse = response;
    if (
      !responseIsBounded(response, maxResponseBytes) ||
      totalBytes + response.bodyBytes > maxTotalBytes
    ) {
      return {
        ...metadata(response, requests),
        outcome: "UNKNOWN",
        reason: "BOUNDS_EXCEEDED",
        data,
      };
    }
    totalBytes += response.bodyBytes;
    if (response.status === 301) {
      const redirected = redirectResource(
        normalizeHeaders(response.headers)["location"],
      );
      if (redirected === undefined) {
        return {
          ...metadata(response, requests),
          outcome: "UNKNOWN",
          reason: "PROTOCOL_ERROR",
          data,
        };
      }
      if (redirects >= maxRedirects) {
        return {
          ...metadata(response, requests),
          outcome: "UNKNOWN",
          reason: "BOUNDS_EXCEEDED",
          data,
        };
      }
      redirects += 1;
      resource = redirected;
      originalPathname = new URL(redirected, "https://api.github.com").pathname;
      continue;
    }
    if (response.status === 304 && requests === 1) {
      return {
        ...metadata(response, requests),
        outcome: "NOT_MODIFIED",
        data: null,
      };
    }
    if (response.status < 200 || response.status > 299) {
      return classifyNonSuccess(response, requests);
    }
    if (!Array.isArray(response.body)) {
      return {
        ...metadata(response, requests),
        outcome: "UNKNOWN",
        reason: "PROTOCOL_ERROR",
        data,
      };
    }
    data.push(...response.body);
    const normalizedHeaders = normalizeHeaders(response.headers);
    const next = nextResource(normalizedHeaders["link"], originalPathname);
    if (next === undefined) {
      return {
        ...metadata(response, requests),
        outcome: "UNKNOWN",
        reason: "PROTOCOL_ERROR",
        data,
      };
    }
    resource = next;
  }

  const response = lastResponse;
  if (response === null) {
    throw new Error("GitHub REST collection executed no requests");
  }
  return { ...metadata(response, requests), outcome: "OK", data };
}

export async function readRestResource(
  transport: GithubTransport,
  options: ReadRestResourceOptions,
): Promise<GithubReadResult<unknown>> {
  validateResource(options.resource);
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    HARD_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const maxTotalBytes = boundedInteger(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    HARD_MAX_TOTAL_BYTES,
    "maxTotalBytes",
  );
  const maxRedirects = boundedInteger(
    options.maxRedirects,
    DEFAULT_MAX_REDIRECTS,
    HARD_MAX_REDIRECTS,
    "maxRedirects",
  );
  const visited = new Set<string>();
  let resource = options.resource;
  let requests = 0;
  let redirects = 0;
  let totalBytes = 0;
  let lastResponse: GithubReplayResponse | null = null;

  while (true) {
    if (visited.has(resource)) {
      const fallback =
        lastResponse ??
        ({ status: 0, headers: {}, body: null, bodyBytes: 0 } as const);
      return {
        ...metadata(fallback, requests),
        outcome: "UNKNOWN",
        reason: "BOUNDS_EXCEEDED",
        data: null,
      };
    }
    visited.add(resource);
    const headers = baseHeaders();
    if (requests === 0 && options.etag !== undefined && options.etag !== null) {
      headers["if-none-match"] = options.etag;
    }
    const response = await transport.execute({
      method: "GET",
      resource,
      headers,
      body: null,
    });
    lastResponse = response;
    requests += 1;
    if (
      !responseIsBounded(response, maxResponseBytes) ||
      totalBytes + response.bodyBytes > maxTotalBytes
    ) {
      return {
        ...metadata(response, requests),
        outcome: "UNKNOWN",
        reason: "BOUNDS_EXCEEDED",
        data: null,
      };
    }
    totalBytes += response.bodyBytes;
    if (response.status === 301) {
      const redirected = redirectResource(
        normalizeHeaders(response.headers)["location"],
      );
      if (redirected === undefined) {
        return {
          ...metadata(response, requests),
          outcome: "UNKNOWN",
          reason: "PROTOCOL_ERROR",
          data: null,
        };
      }
      if (redirects >= maxRedirects) {
        return {
          ...metadata(response, requests),
          outcome: "UNKNOWN",
          reason: "BOUNDS_EXCEEDED",
          data: null,
        };
      }
      redirects += 1;
      resource = redirected;
      continue;
    }
    if (response.status === 304 && requests === 1) {
      return {
        ...metadata(response, requests),
        outcome: "NOT_MODIFIED",
        data: null,
      };
    }
    if (response.status < 200 || response.status > 299) {
      return classifyNonSuccess(response, requests);
    }
    return {
      ...metadata(response, requests),
      outcome: "OK",
      data: response.body,
    };
  }
}

export async function readGraphql(
  transport: GithubTransport,
  options: ReadGraphqlOptions,
): Promise<GithubReadResult<unknown>> {
  if (options.query.trim() === "" || options.query.length > 65_536) {
    throw new RangeError("GraphQL query must contain 1 to 65536 characters");
  }
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    HARD_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const maxRequestBytes = boundedInteger(
    options.maxRequestBytes,
    DEFAULT_MAX_REQUEST_BYTES,
    HARD_MAX_REQUEST_BYTES,
    "maxRequestBytes",
  );
  const requestBody = JSON.stringify({
    query: options.query,
    variables: options.variables ?? {},
  });
  if (Buffer.byteLength(requestBody, "utf8") > maxRequestBytes) {
    throw new RangeError("GraphQL request exceeds maxRequestBytes");
  }
  const response = await transport.execute({
    method: "POST",
    resource: "/graphql",
    headers: baseHeaders(),
    body: requestBody,
  });
  if (!responseIsBounded(response, maxResponseBytes)) {
    return {
      ...metadata(response, 1),
      outcome: "UNKNOWN",
      reason: "BOUNDS_EXCEEDED",
      data: null,
    };
  }
  if (response.status < 200 || response.status > 299) {
    return classifyNonSuccess(response, 1);
  }
  if (!isRecord(response.body)) {
    return {
      ...metadata(response, 1),
      outcome: "UNKNOWN",
      reason: "PROTOCOL_ERROR",
      data: null,
    };
  }
  const errors = response.body["errors"];
  const data = response.body["data"] ?? null;
  if ("errors" in response.body && !Array.isArray(errors)) {
    return {
      ...metadata(response, 1),
      outcome: "UNKNOWN",
      reason: "PROTOCOL_ERROR",
      data: null,
    };
  }
  if (Array.isArray(errors) && errors.length > 0) {
    return {
      ...metadata(response, 1),
      outcome: "UNKNOWN",
      reason: "PARTIAL_RESPONSE",
      data,
    };
  }
  if (!("data" in response.body)) {
    return {
      ...metadata(response, 1),
      outcome: "UNKNOWN",
      reason: "PROTOCOL_ERROR",
      data: null,
    };
  }
  return { ...metadata(response, 1), outcome: "OK", data };
}
