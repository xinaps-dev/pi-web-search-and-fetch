import { describe, expect, it, vi } from "vitest";
import {
  isRetryableError,
  parseRetryAfter,
  withRetry,
} from "../src/utils/retry.js";

/** Fast retry options used across `withRetry` tests. */
const fast = { initialDelayMs: 1, maxDelayMs: 2, jitter: false };

/** Creates an Error with an HTTP status property. */
function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** Creates an Error with a network `code` property. */
function netError(code: string): Error & { code: string } {
  return Object.assign(new Error(`network failure: ${code}`), { code });
}

/** Runs `operation` and collects the thrown error. */
async function expectError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected promise to reject");
  } catch (error) {
    if (error instanceof Error && error.message === "expected promise to reject") {
      throw error;
    }
    return error;
  }
}

describe("src/utils/retry", () => {
  describe("parseRetryAfter", () => {
    it("parses integer seconds into milliseconds", () => {
      expect(parseRetryAfter("30")).toBe(30000);
      expect(parseRetryAfter("5")).toBe(5000);
    });

    it("parses zero seconds to zero delay", () => {
      expect(parseRetryAfter("0")).toBe(0);
    });

    it("trims surrounding whitespace", () => {
      expect(parseRetryAfter(" 12 ")).toBe(12000);
    });

    it("parses a future HTTP-Date (RFC 7231) into a positive delay", () => {
      const future = new Date(Date.now() + 5000).toUTCString();
      const delay = parseRetryAfter(future);
      expect(delay).not.toBeNull();
      expect(delay as number).toBeGreaterThan(4000);
      expect(delay as number).toBeLessThanOrEqual(5000);
    });

    it("clamps a past HTTP-Date to zero", () => {
      const past = new Date(Date.now() - 60000).toUTCString();
      expect(parseRetryAfter(past)).toBe(0);
    });

    it("returns null for null, undefined, empty and invalid values", () => {
      expect(parseRetryAfter(null)).toBeNull();
      expect(parseRetryAfter(undefined)).toBeNull();
      expect(parseRetryAfter("")).toBeNull();
      expect(parseRetryAfter("   ")).toBeNull();
      expect(parseRetryAfter("not-a-date")).toBeNull();
    });
  });

  describe("isRetryableError", () => {
    it.each([429, 500, 502, 503, 504])(
      "treats HTTP %i (direct status) as retryable",
      (status) => {
        expect(isRetryableError(httpError(status))).toBe(true);
      }
    );

    it("treats an error with a nested response.status as retryable", () => {
      const error = Object.assign(new Error("request failed"), {
        response: { status: 503 },
      });
      expect(isRetryableError(error)).toBe(true);
    });

    it("treats an error message containing an HTTP 5xx code as retryable", () => {
      expect(isRetryableError(new Error("Request failed with HTTP 500"))).toBe(
        true
      );
    });

    it.each([
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
      "ECONNREFUSED",
    ])("treats network error %s (code property) as retryable", (code) => {
      expect(isRetryableError(netError(code))).toBe(true);
    });

    it("treats an error message containing a network code as retryable", () => {
      expect(
        isRetryableError(new Error("read ECONNRESET while streaming"))
      ).toBe(true);
    });

    it.each([400, 401, 403, 404])(
      "does not retry HTTP %i",
      (status) => {
        expect(isRetryableError(httpError(status))).toBe(false);
      }
    );

    it("does not retry AbortError (DOMException)", () => {
      const error = new DOMException("This operation was aborted", "AbortError");
      expect(isRetryableError(error)).toBe(false);
    });

    it("does not retry errors named AbortError", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      expect(isRetryableError(error)).toBe(false);
    });

    it("does not retry generic errors", () => {
      expect(isRetryableError(new Error("something else"))).toBe(false);
      expect(isRetryableError("not an object")).toBe(false);
      expect(isRetryableError(null)).toBe(false);
    });
  });

  describe("withRetry", () => {
    it("succeeds on the first attempt without retrying", async () => {
      const operation = vi.fn(async () => "ok");
      const result = await withRetry(operation, fast);
      expect(result).toBe("ok");
      expect(operation).toHaveBeenCalledTimes(1);
      expect(operation).toHaveBeenCalledWith(1);
    });

    it("succeeds after one transient HTTP 500 failure", async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(httpError(500))
        .mockResolvedValueOnce("recovered");
      const result = await withRetry(operation, fast);
      expect(result).toBe("recovered");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("succeeds after two transient failures (HTTP 503, ECONNRESET)", async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(httpError(503))
        .mockRejectedValueOnce(netError("ECONNRESET"))
        .mockResolvedValueOnce("done");
      const result = await withRetry(operation, fast);
      expect(result).toBe("done");
      expect(operation).toHaveBeenCalledTimes(3);
      expect(operation).toHaveBeenNthCalledWith(1, 1);
      expect(operation).toHaveBeenNthCalledWith(2, 2);
      expect(operation).toHaveBeenNthCalledWith(3, 3);
    });

    it("fails immediately without retrying on HTTP 401", async () => {
      const operation = vi.fn(async () => {
        throw httpError(401);
      });
      const error = await expectError(withRetry(operation, fast));
      expect(error).toBeInstanceOf(Error);
      expect((error as { status: number }).status).toBe(401);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("fails immediately without retrying on HTTP 403", async () => {
      const operation = vi.fn(async () => {
        throw httpError(403);
      });
      const error = await expectError(withRetry(operation, fast));
      expect((error as { status: number }).status).toBe(403);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("fails immediately without retrying on HTTP 404", async () => {
      const operation = vi.fn(async () => {
        throw httpError(404);
      });
      const error = await expectError(withRetry(operation, fast));
      expect((error as { status: number }).status).toBe(404);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("throws the last error when maxRetries is exceeded", async () => {
      const operation = vi.fn(async () => {
        throw httpError(500);
      });
      const error = await expectError(
        withRetry(operation, { ...fast, maxRetries: 2 })
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as { status: number }).status).toBe(500);
      // 1 initial attempt + 2 retries.
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it("respects a numeric Retry-After (seconds) on the error object", async () => {
      const error = Object.assign(httpError(429), { retryAfter: 0 });
      const delays: number[] = [];
      const operation = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce("ok");
      await withRetry(operation, {
        ...fast,
        initialDelayMs: 50,
        onRetry: (_err, _attempt, delayMs) => delays.push(delayMs),
      });
      // 0s Retry-After must override the 50ms backoff delay.
      expect(delays).toEqual([0]);
    });

    it("respects a Retry-After HTTP-Date header on error.headers", async () => {
      const error = Object.assign(httpError(503), {
        headers: { "retry-after": new Date(Date.now() - 1000).toUTCString() },
      });
      const delays: number[] = [];
      const operation = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce("ok");
      await withRetry(operation, {
        ...fast,
        initialDelayMs: 50,
        onRetry: (_err, _attempt, delayMs) => delays.push(delayMs),
      });
      // Past HTTP-Date clamps to 0ms instead of the 50ms backoff.
      expect(delays).toEqual([0]);
    });

    it("respects a Retry-After header on error.response.headers", async () => {
      const error = Object.assign(httpError(503), {
        response: { headers: { "Retry-After": "0" } },
      });
      const delays: number[] = [];
      const operation = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce("ok");
      await withRetry(operation, {
        ...fast,
        initialDelayMs: 50,
        onRetry: (_err, _attempt, delayMs) => delays.push(delayMs),
      });
      expect(delays).toEqual([0]);
    });

    it("clamps the exponential backoff to maxDelayMs", async () => {
      const delays: number[] = [];
      const error = httpError(500);
      const operation = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce("ok");
      await withRetry(operation, {
        initialDelayMs: 1,
        maxDelayMs: 2,
        factor: 10,
        jitter: false,
        maxRetries: 3,
        onRetry: (_err, _attempt, delayMs) => delays.push(delayMs),
      });
      // attempt 1: 1 * 10^0 = 1; attempt 2: 1 * 10^1 clamped to 2;
      // attempt 3: 1 * 10^2 clamped to 2.
      expect(delays).toEqual([1, 2, 2]);
    });

    it("calls onRetry with the error, attempt number and delayMs", async () => {
      const error = httpError(503);
      const onRetry = vi.fn();
      const operation = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce("ok");
      await withRetry(operation, { ...fast, onRetry });
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(error, 1, 1);
    });

    it("rejects immediately when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const operation = vi.fn(async () => "never");
      const error = await expectError(
        withRetry(operation, { ...fast, signal: controller.signal })
      );
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
      expect(operation).not.toHaveBeenCalled();
    });

    it("rejects when the signal aborts during the retry delay", async () => {
      const controller = new AbortController();
      const operation = vi.fn(async () => {
        throw httpError(500);
      });
      const pending = withRetry(operation, {
        initialDelayMs: 500,
        maxDelayMs: 1000,
        jitter: false,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 10);
      const error = await expectError(pending);
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("honours a custom shouldRetry predicate that disables retries", async () => {
      const operation = vi.fn(async () => {
        throw httpError(500);
      });
      const shouldRetry = vi.fn(() => false);
      await expectError(
        withRetry(operation, { ...fast, shouldRetry })
      );
      expect(shouldRetry).toHaveBeenCalledTimes(1);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("honours a custom shouldRetry predicate that enables retries", async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(httpError(401))
        .mockResolvedValueOnce("ok");
      const shouldRetry = vi.fn(() => true);
      const result = await withRetry(operation, { ...fast, shouldRetry });
      expect(result).toBe("ok");
      expect(operation).toHaveBeenCalledTimes(2);
    });
  });
});
