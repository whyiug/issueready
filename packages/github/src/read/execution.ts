import type {
  GithubReadResult,
  GithubReplayRequest,
  GithubReplayResponse,
  GithubTransport,
} from "./index.js";

export const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 30_000;
export const HARD_MAX_GITHUB_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_GITHUB_RETRY_ATTEMPTS = 3;
export const HARD_MAX_GITHUB_RETRY_ATTEMPTS = 5;
export const DEFAULT_GITHUB_RETRY_DELAY_BUDGET_SECONDS = 120;
export const HARD_MAX_GITHUB_RETRY_DELAY_BUDGET_SECONDS = 600;
export const DEFAULT_GITHUB_RETRY_BASE_DELAY_SECONDS = 1;
export const HARD_MAX_GITHUB_RETRY_BASE_DELAY_SECONDS = 60;

export type GithubTransportBoundaryErrorCode =
  | "CREDENTIAL_UNAVAILABLE"
  | "REQUEST_TIMEOUT"
  | "EXECUTOR_FAILURE"
  | "SCHEDULER_FAILURE";

export class GithubTransportBoundaryError extends Error {
  readonly code: GithubTransportBoundaryErrorCode;

  constructor(code: GithubTransportBoundaryErrorCode) {
    super(`GitHub transport boundary failed: ${code}`);
    this.code = code;
  }
}

export interface GithubCredentialContext {
  readonly credential: string;
  readonly signal: AbortSignal;
}

export interface GithubCredentialBoundaryExecutor {
  execute(
    request: GithubReplayRequest,
    context: GithubCredentialContext,
  ): Promise<GithubReplayResponse>;
}

export type GithubCredentialProvider = () => string | Promise<string>;

export interface GithubTimer {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface GithubCredentialedTransportOptions {
  readonly executor: GithubCredentialBoundaryExecutor;
  readonly credentialProvider: GithubCredentialProvider;
  readonly timeoutMs?: number;
  readonly timer?: GithubTimer;
}

const SYSTEM_TIMER: GithubTimer = {
  schedule(callback, delayMs): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  },
  cancel(handle): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const TIMEOUT_SENTINEL = Symbol("github-request-timeout");
const INVALID_CREDENTIAL_SENTINEL = Symbol("github-invalid-credential");

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    throw new RangeError(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return selected;
}

function credentialIsValid(credential: string): boolean {
  return (
    typeof credential === "string" &&
    credential.length >= 1 &&
    credential.length <= 8192 &&
    credential.trim() === credential &&
    !/[\r\n]/u.test(credential)
  );
}

export function createCredentialedGithubTransport(
  options: GithubCredentialedTransportOptions,
): GithubTransport {
  const timeoutMs = boundedInteger(
    options.timeoutMs,
    DEFAULT_GITHUB_REQUEST_TIMEOUT_MS,
    1,
    HARD_MAX_GITHUB_REQUEST_TIMEOUT_MS,
    "timeoutMs",
  );
  const timer = options.timer ?? SYSTEM_TIMER;
  return {
    async execute(request): Promise<GithubReplayResponse> {
      const controller = new AbortController();
      let timeoutHandle: unknown;
      let rejectTimeout: ((reason: typeof TIMEOUT_SENTINEL) => void) | null =
        null;
      const timeout = new Promise<never>((_resolve, reject) => {
        rejectTimeout = reject;
      });
      timeoutHandle = timer.schedule(() => {
        controller.abort();
        rejectTimeout?.(TIMEOUT_SENTINEL);
      }, timeoutMs);
      let stage: "CREDENTIAL" | "EXECUTOR" = "CREDENTIAL";
      try {
        const credential = await Promise.race([
          Promise.resolve().then(options.credentialProvider),
          timeout,
        ]);
        if (!credentialIsValid(credential)) {
          throw INVALID_CREDENTIAL_SENTINEL;
        }
        stage = "EXECUTOR";
        return await Promise.race([
          options.executor.execute(structuredClone(request), {
            credential,
            signal: controller.signal,
          }),
          timeout,
        ]);
      } catch (error) {
        if (error === TIMEOUT_SENTINEL) {
          throw new GithubTransportBoundaryError("REQUEST_TIMEOUT");
        }
        if (error === INVALID_CREDENTIAL_SENTINEL) {
          throw new GithubTransportBoundaryError("CREDENTIAL_UNAVAILABLE");
        }
        throw new GithubTransportBoundaryError(
          stage === "CREDENTIAL"
            ? "CREDENTIAL_UNAVAILABLE"
            : "EXECUTOR_FAILURE",
        );
      } finally {
        timer.cancel(timeoutHandle);
      }
    },
  };
}

export type GithubRetryStopReason =
  "FINAL_RESULT" | "ATTEMPT_BOUND" | "DELAY_BOUND";

export interface GithubRetryOptions {
  readonly sleep: (delaySeconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly maxAttempts?: number;
  readonly maxTotalDelaySeconds?: number;
  readonly baseDelaySeconds?: number;
}

export interface GithubRetryExecution<Value> {
  readonly result: GithubReadResult<Value>;
  readonly attempts: number;
  readonly delays: readonly number[];
  readonly stopReason: GithubRetryStopReason;
}

function retryable<Value>(
  result: GithubReadResult<Value>,
): result is Extract<GithubReadResult<Value>, { outcome: "UNKNOWN" }> {
  return (
    result.outcome === "UNKNOWN" &&
    (result.reason === "RATE_LIMITED" || result.reason === "SERVER_ERROR")
  );
}

function retryDelay(
  result: Extract<GithubReadResult<unknown>, { outcome: "UNKNOWN" }>,
  attempt: number,
  baseDelaySeconds: number,
  now: () => number,
): number {
  if (
    result.reason === "RATE_LIMITED" &&
    result.rateLimit.retryAfterSeconds !== null
  ) {
    return result.rateLimit.retryAfterSeconds;
  }
  if (
    result.reason === "RATE_LIMITED" &&
    result.rateLimit.remaining === 0 &&
    result.rateLimit.resetAt !== null
  ) {
    const resetAt = Date.parse(result.rateLimit.resetAt);
    if (Number.isFinite(resetAt)) {
      return Math.ceil(Math.max(0, resetAt - now()) / 1000);
    }
  }
  return baseDelaySeconds * 2 ** Math.max(0, attempt - 1);
}

export async function executeGithubReadWithRetry<Value>(
  operation: () => Promise<GithubReadResult<Value>>,
  options: GithubRetryOptions,
): Promise<GithubRetryExecution<Value>> {
  const maxAttempts = boundedInteger(
    options.maxAttempts,
    DEFAULT_GITHUB_RETRY_ATTEMPTS,
    1,
    HARD_MAX_GITHUB_RETRY_ATTEMPTS,
    "maxAttempts",
  );
  const maxTotalDelaySeconds = boundedInteger(
    options.maxTotalDelaySeconds,
    DEFAULT_GITHUB_RETRY_DELAY_BUDGET_SECONDS,
    0,
    HARD_MAX_GITHUB_RETRY_DELAY_BUDGET_SECONDS,
    "maxTotalDelaySeconds",
  );
  const baseDelaySeconds = boundedInteger(
    options.baseDelaySeconds,
    DEFAULT_GITHUB_RETRY_BASE_DELAY_SECONDS,
    1,
    HARD_MAX_GITHUB_RETRY_BASE_DELAY_SECONDS,
    "baseDelaySeconds",
  );
  const now = options.now ?? Date.now;
  const delays: number[] = [];
  let attempts = 0;
  while (true) {
    attempts += 1;
    const result = await operation();
    if (!retryable(result)) {
      return { result, attempts, delays, stopReason: "FINAL_RESULT" };
    }
    if (attempts >= maxAttempts) {
      return { result, attempts, delays, stopReason: "ATTEMPT_BOUND" };
    }
    const delay = retryDelay(result, attempts, baseDelaySeconds, now);
    const consumedDelay = delays.reduce((total, item) => total + item, 0);
    if (
      !Number.isSafeInteger(delay) ||
      delay < 0 ||
      consumedDelay + delay > maxTotalDelaySeconds
    ) {
      return { result, attempts, delays, stopReason: "DELAY_BOUND" };
    }
    try {
      await options.sleep(delay);
    } catch {
      throw new GithubTransportBoundaryError("SCHEDULER_FAILURE");
    }
    delays.push(delay);
  }
}
