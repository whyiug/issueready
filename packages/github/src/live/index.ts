import type {
  GithubCredentialBoundaryExecutor,
  GithubCredentialContext,
  GithubReplayRequest,
  GithubReplayResponse,
} from "../read/index.js";

export const DEFAULT_GITHUB_HTTP_MAX_REQUEST_BYTES = 1_048_576;
export const HARD_MAX_GITHUB_HTTP_MAX_REQUEST_BYTES = 1_048_576;
export const DEFAULT_GITHUB_HTTP_MAX_RESPONSE_BYTES = 8_388_608;
export const HARD_MAX_GITHUB_HTTP_MAX_RESPONSE_BYTES = 33_554_432;

export type GithubHttpExecutorErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_CREDENTIAL"
  | "REQUEST_TOO_LARGE"
  | "RESPONSE_TOO_LARGE"
  | "NETWORK_FAILURE";

export class GithubHttpExecutorError extends Error {
  readonly code: GithubHttpExecutorErrorCode;

  constructor(code: GithubHttpExecutorErrorCode) {
    super(`GitHub HTTP executor failed: ${code}`);
    this.code = code;
  }
}

export interface GithubHttpExecutorOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

const REQUEST_HEADERS = new Set([
  "accept",
  "if-none-match",
  "x-github-api-version",
]);
const RESPONSE_HEADERS = [
  "etag",
  "link",
  "location",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
] as const;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return selected;
}

function safeResource(resource: string): boolean {
  return (
    resource.startsWith("/") &&
    !resource.startsWith("//") &&
    !resource.includes("#") &&
    !resource.includes("\\") &&
    !/[\r\n]/u.test(resource)
  );
}

function credentialIsValid(credential: string): boolean {
  return (
    typeof credential === "string" &&
    credential.length >= 1 &&
    credential.length <= 8192 &&
    credential.trim() === credential &&
    !/\s/u.test(credential)
  );
}

function requestHeaders(
  request: GithubReplayRequest,
  credential: string,
): Headers {
  const headers = new Headers();
  const names = new Set<string>();
  for (const [rawName, value] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (
      !REQUEST_HEADERS.has(name) ||
      names.has(name) ||
      typeof value !== "string" ||
      /[\r\n]/u.test(value)
    ) {
      throw new GithubHttpExecutorError("INVALID_REQUEST");
    }
    names.add(name);
    headers.set(name, value);
  }
  if (!headers.has("accept") || !headers.has("x-github-api-version")) {
    throw new GithubHttpExecutorError("INVALID_REQUEST");
  }
  if (request.method === "POST") {
    headers.set("content-type", "application/json");
  }
  headers.set("user-agent", "IssueReady/0.0.0");
  headers.set("authorization", `Bearer ${credential}`);
  return headers;
}

function responseHeaders(response: Response): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
}

async function boundedResponseBody(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^[0-9]+$/u.test(contentLength)) {
    const declared = Number(contentLength);
    if (Number.isSafeInteger(declared) && declared > maximum) {
      await response.body?.cancel().catch(() => undefined);
      throw new GithubHttpExecutorError("RESPONSE_TOO_LARGE");
    }
  }
  if (response.body === null) return new Uint8Array();
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
        throw new GithubHttpExecutorError("RESPONSE_TOO_LARGE");
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
  return body;
}

function parseJson(body: Uint8Array): unknown {
  if (body.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
}

function validateRequest(
  request: GithubReplayRequest,
  context: GithubCredentialContext,
  maxRequestBytes: number,
): URL {
  if (
    (request.method !== "GET" && request.method !== "POST") ||
    !safeResource(request.resource) ||
    (request.method === "GET" && request.body !== null) ||
    (request.method === "POST" && request.body === null)
  ) {
    throw new GithubHttpExecutorError("INVALID_REQUEST");
  }
  if (!credentialIsValid(context.credential)) {
    throw new GithubHttpExecutorError("INVALID_CREDENTIAL");
  }
  const bodyBytes =
    request.body === null
      ? 0
      : new TextEncoder().encode(request.body).byteLength;
  if (bodyBytes > maxRequestBytes) {
    throw new GithubHttpExecutorError("REQUEST_TOO_LARGE");
  }
  if (
    request.resource.includes(context.credential) ||
    request.body?.includes(context.credential) === true
  ) {
    throw new GithubHttpExecutorError("INVALID_REQUEST");
  }
  return new URL(request.resource, "https://api.github.com");
}

export function createGithubHttpExecutor(
  options: GithubHttpExecutorOptions = {},
): GithubCredentialBoundaryExecutor {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const maxRequestBytes = boundedInteger(
    options.maxRequestBytes,
    DEFAULT_GITHUB_HTTP_MAX_REQUEST_BYTES,
    HARD_MAX_GITHUB_HTTP_MAX_REQUEST_BYTES,
    "maxRequestBytes",
  );
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes,
    DEFAULT_GITHUB_HTTP_MAX_RESPONSE_BYTES,
    HARD_MAX_GITHUB_HTTP_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  return {
    async execute(
      request: GithubReplayRequest,
      context: GithubCredentialContext,
    ): Promise<GithubReplayResponse> {
      let url: URL;
      let headers: Headers;
      try {
        url = validateRequest(request, context, maxRequestBytes);
        headers = requestHeaders(request, context.credential);
      } catch (error) {
        if (error instanceof GithubHttpExecutorError) throw error;
        throw new GithubHttpExecutorError("INVALID_REQUEST");
      }
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
          signal: context.signal,
        });
      } catch {
        throw new GithubHttpExecutorError("NETWORK_FAILURE");
      }
      let body: Uint8Array;
      try {
        body = await boundedResponseBody(response, maxResponseBytes);
      } catch (error) {
        if (error instanceof GithubHttpExecutorError) throw error;
        throw new GithubHttpExecutorError("NETWORK_FAILURE");
      }
      return {
        status: response.status,
        headers: responseHeaders(response),
        body: parseJson(body),
        bodyBytes: body.byteLength,
      };
    },
  };
}
