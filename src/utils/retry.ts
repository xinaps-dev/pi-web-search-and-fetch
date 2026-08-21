/**
 * Network resilience utilities: exponential backoff retries, `Retry-After`
 * header parsing, retryable-error discrimination and abort-aware waiting.
 *
 * These helpers centralise retry behaviour for all outbound network calls
 * (search, fetch, deep search) so that rate limits (HTTP 429) and transient
 * failures (5xx, connection resets) are handled consistently.
 */

/**
 * Options controlling the behaviour of {@link withRetry}.
 */
export interface RetryOptions {
  /** Maximum number of retries after the initial attempt. Default: 3. */
  maxRetries?: number;
  /** Delay before the first retry in milliseconds. Default: 1000. */
  initialDelayMs?: number;
  /** Upper bound for a computed delay in milliseconds. Default: 10000. */
  maxDelayMs?: number;
  /** Exponential growth factor. Default: 2. */
  factor?: number;
  /**
   * Jitter applied to the computed delay.
   * - `number`: fraction of the delay to vary by (e.g. 0.2 = ±20%).
   * - `true`: equivalent to 0.2.
   * - `false`: no jitter.
   */
  jitter?: boolean | number;
  /** Abort signal that immediately stops retries when triggered. */
  signal?: AbortSignal;
  /** Custom predicate deciding whether an error should be retried. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Callback invoked before each retry wait. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 10000;
const DEFAULT_FACTOR = 2;
const DEFAULT_JITTER = 0.2;

/** HTTP status codes considered transient and therefore retryable. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** HTTP status codes that must fail immediately without retry. */
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404]);

/** Network error codes considered transient and therefore retryable. */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
]);

/**
 * Extracts the status code from an error object.
 *
 * Checks the `status`, `statusCode` and `status_code` properties on the
 * error itself, on a nested `response` object, and falls back to scanning
 * the error message for an `HTTP <code>` pattern.
 */
function extractStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const candidate = error as Record<string, unknown>;
  const direct = candidate.status ?? candidate.statusCode ?? candidate.status_code;
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  // Some MCP / HTTP error classes (e.g. StreamableHTTPError) store the status code in numeric `code`
  if (typeof candidate.code === "number" && candidate.code >= 100 && candidate.code <= 599) {
    return candidate.code;
  }
  const response = candidate.response;
  if (typeof response === "object" && response !== null) {
    const r = response as Record<string, unknown>;
    const fromResponse = r.status ?? r.statusCode ?? r.status_code;
    if (typeof fromResponse === "number" && Number.isFinite(fromResponse)) {
      return fromResponse;
    }
  }
  const cause = candidate.cause;
  if (typeof cause === "object" && cause !== null) {
    const fromCause = extractStatusCode(cause);
    if (fromCause !== null) {
      return fromCause;
    }
  }
  if (typeof candidate.message === "string") {
    const match = candidate.message.match(/HTTP\s*(\d{3})/i);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * Extracts a network error code (e.g. `ECONNRESET`) from an error object.
 */
function extractNetworkCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.code === "string") {
    return candidate.code;
  }
  const cause = candidate.cause;
  if (typeof cause === "object" && cause !== null) {
    const fromCause = extractNetworkCode(cause);
    if (fromCause !== null) {
      return fromCause;
    }
  }
  return null;
}

/**
 * Returns `true` when the error represents an aborted request.
 */
function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as Record<string, unknown>;
  if (candidate.name === "AbortError" || candidate.code === "ABORT_ERR") {
    return true;
  }
  if (typeof candidate.message === "string" && /aborted/i.test(candidate.message)) {
    return true;
  }
  return false;
}

/**
 * Determines whether an error is transient and therefore worth retrying.
 *
 * Retryable:
 * - HTTP 429, 500, 502, 503, 504.
 * - Network errors: `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND`,
 *   `ECONNREFUSED`.
 *
 * Not retryable:
 * - HTTP 400, 401, 403, 404.
 * - Aborted requests (`AbortError`).
 *
 * @param error - The unknown error thrown by a network operation.
 * @returns Whether the operation should be retried.
 */
export function isRetryableError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  const status = extractStatusCode(error);
  if (status !== null) {
    if (NON_RETRYABLE_STATUS_CODES.has(status)) {
      return false;
    }
    if (RETRYABLE_STATUS_CODES.has(status)) {
      return true;
    }
    // Other 5xx codes are treated as transient.
    return status >= 500;
  }
  const code = extractNetworkCode(error);
  if (code !== null && RETRYABLE_NETWORK_CODES.has(code)) {
    return true;
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") {
      for (const networkCode of RETRYABLE_NETWORK_CODES) {
        if (message.includes(networkCode)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Parses a `Retry-After` header value into a delay in milliseconds.
 *
 * Supported formats:
 * - Integer seconds (e.g. `"30"` or `"3000"` when the value is numeric).
 * - HTTP-Date (RFC 7231), e.g. `Date.parse`-able strings.
 *
 * @param headerValue - Raw `Retry-After` header value.
 * @returns The delay in milliseconds (>= 0), or `null` when the value is
 *   absent, empty, or unparseable.
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
): number | null {
  if (headerValue === null || headerValue === undefined) {
    return null;
  }
  const trimmed = headerValue.trim();
  if (trimmed === "") {
    return null;
  }
  // Integer seconds.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Math.max(0, seconds * 1000);
  }
  // HTTP-Date (RFC 7231).
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.max(0, parsed - Date.now());
}

/**
 * Extracts a `Retry-After` delay (ms) from an error object, if present.
 */
function extractRetryAfter(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const candidate = error as Record<string, unknown>;

  // Direct numeric property.
  if (typeof candidate.retryAfter === "number" && Number.isFinite(candidate.retryAfter)) {
    return Math.max(0, candidate.retryAfter * 1000);
  }

  // Headers object or Headers instance with a `retry-after` entry
  const headers = candidate.headers;
  if (typeof headers === "object" && headers !== null) {
    if (typeof (headers as { get?: unknown }).get === "function") {
      const value = parseRetryAfter((headers as { get: (name: string) => string | null }).get("retry-after"));
      if (value !== null) {
        return value;
      }
    } else {
      const h = headers as Record<string, unknown>;
      const key = Object.keys(h).find((k) => k.toLowerCase() === "retry-after");
      if (key !== undefined) {
        const value = parseRetryAfter(h[key] as string);
        if (value !== null) {
          return value;
        }
      }
    }
  }

  // Nested response object.
  const response = candidate.response;
  if (typeof response === "object" && response !== null) {
    const r = response as Record<string, unknown>;
    if (typeof r.retryAfter === "number" && Number.isFinite(r.retryAfter)) {
      return Math.max(0, r.retryAfter * 1000);
    }
    const rHeaders = r.headers;
    if (typeof rHeaders === "object" && rHeaders !== null) {
      if (typeof (rHeaders as { get?: unknown }).get === "function") {
        const value = parseRetryAfter((rHeaders as { get: (name: string) => string | null }).get("retry-after"));
        if (value !== null) {
          return value;
        }
      } else {
        const rh = rHeaders as Record<string, unknown>;
        const key = Object.keys(rh).find((k) => k.toLowerCase() === "retry-after");
        if (key !== undefined) {
          const value = parseRetryAfter(rh[key] as string);
          if (value !== null) {
            return value;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Resolves the jitter fraction from a `RetryOptions.jitter` value.
 */
function resolveJitter(jitter: boolean | number | undefined): number {
  if (jitter === false) {
    return 0;
  }
  if (jitter === true) {
    return DEFAULT_JITTER;
  }
  if (typeof jitter === "number" && Number.isFinite(jitter) && jitter >= 0) {
    return jitter;
  }
  return DEFAULT_JITTER;
}

/**
 * Returns a promise that resolves after `delayMs` milliseconds, or rejects
 * immediately when the provided `signal` is (or becomes) aborted.
 */
function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(new DOMException("Aborted", "AbortError"));
    };
    timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, delayMs);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Executes `operation` with exponential backoff retries and jitter.
 *
 * Behaviour:
 * - Attempts run from 1 to `maxRetries + 1` (inclusive).
 * - If `signal` is already aborted at the start of an attempt, the promise
 *   rejects immediately.
 * - On failure, retries are aborted when:
 *   - the signal was aborted,
 *   - no retries remain,
 *   - `shouldRetry` (when provided) or {@link isRetryableError} returns
 *     `false`.
 * - The delay honours a `Retry-After` header found on the error (via
 *   `error.retryAfter`, `error.headers`, or `error.response.headers`),
 *   otherwise it uses exponential backoff:
 *   `initialDelayMs * factor^(attempt - 1)` clamped to `maxDelayMs`, with
 *   optional jitter.
 * - `onRetry` is invoked before each wait with the error, the failed
 *   attempt number, and the delay in milliseconds.
 *
 * @param operation - The async operation to execute. Receives the 1-based
 *   attempt number.
 * @param options - Retry configuration.
 * @returns The result of the first successful attempt.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialDelayMs = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const factor = options?.factor ?? DEFAULT_FACTOR;
  const jitterAmount = resolveJitter(options?.jitter);
  const signal = options?.signal;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    let result: T;
    try {
      result = await operation(attempt);
      return result;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      if (attempt >= maxRetries + 1) {
        throw error;
      }
      const shouldRetry = options?.shouldRetry
        ? options.shouldRetry(error, attempt)
        : isRetryableError(error);
      if (!shouldRetry) {
        throw error;
      }

      let delayMs = extractRetryAfter(error);
      if (delayMs === null) {
        const base = initialDelayMs * Math.pow(factor, attempt - 1);
        const clamped = Math.min(base, maxDelayMs);
        if (jitterAmount > 0) {
          const variance = Math.random() * 2 - 1; // [-1, 1]
          delayMs = clamped * (1 + variance * jitterAmount);
        } else {
          delayMs = clamped;
        }
      }
      delayMs = Math.max(0, delayMs);

      options?.onRetry?.(error, attempt, delayMs);
      await abortableDelay(delayMs, signal);
    }
  }

  // Unreachable: the loop either returns, throws, or retries.
  throw new Error("withRetry: exceeded maximum attempts");
}
