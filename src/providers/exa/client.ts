/**
 * Singleton Exa MCP client.
 *
 * Wraps `@modelcontextprotocol/sdk` in a lazy singleton so the Exa search,
 * fetch and deep-search implementations share one MCP connection.
 *
 * Endpoint: `https://mcp.exa.ai/mcp` over `StreamableHTTPClientTransport`.
 *
 * API key handling: when an Exa API key is resolved
 * (`providers.exa.useApiKey` enabled, then `auth.json["exa"].key`,
 * then `process.env.EXA_API_KEY`) it is attached to the endpoint as the
 * `exaApiKey` query parameter. When no key is available (or
 * `useApiKey: false`) the client operates in public free mode against the
 * keyless endpoint, subject to Exa's global public limits.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getExaApiKey } from "../../config/auth.js";
import { getConfig } from "../../config/index.js";
import { withRetry, type RetryOptions } from "../../utils/retry.js";
import { maskCredentials } from "../../utils/security.js";

/** Base endpoint of the Exa MCP server. */
export const EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp";

/**
 * Name of the query parameter carrying the Exa API key.
 * Only present when an API key is available and enabled; its absence
 * selects the public free mode.
 */
export const EXA_API_KEY_QUERY_PARAM = "exaApiKey";

/** Identity reported to the Exa MCP server during `initialize`. */
const CLIENT_INFO = { name: "pi-web-scout", version: "1.0.0" };

/** Active singleton client, or `null` when none is connected. */
let activeClient: Client | null = null;
/** API key the active client was created with (`null` = public mode). */
let activeApiKey: string | null = null;
/** In-flight connection, so concurrent callers share one `connect()`. */
let connecting: Promise<Client> | null = null;

/**
 * Build the Exa MCP endpoint URL, appending the API key as the
 * `exaApiKey` query parameter when one is available.
 *
 * The endpoint base may be overridden via `EXA_MCP_ENDPOINT` (used by
 * tests); the default is the public Exa MCP endpoint.
 */
export function getExaMcpUrl(apiKey: string | null): URL {
  const url = new URL(process.env.EXA_MCP_ENDPOINT ?? EXA_MCP_ENDPOINT);
  if (!url.searchParams.has("tools")) {
    url.searchParams.set(
      "tools",
      "web_search_exa,web_search_advanced_exa,web_fetch_exa"
    );
  }
  if (apiKey) {
    url.searchParams.set(EXA_API_KEY_QUERY_PARAM, apiKey);
  }
  return url;
}

/**
 * Redact credentials from a thrown error before it is re-thrown to the
 * caller.
 *
 * The returned error preserves the original class (prototype) so
 * `instanceof` checks keep working, and copies `name`, `stack` and any
 * enumerable own properties (e.g. `code`, `status`, `cause`). Every string
 * value — including `message` — is passed through {@link maskCredentials} so
 * API keys embedded in URLs (e.g. `exaApiKey=...`), `Bearer` tokens, or
 * `x-api-key` headers are redacted.
 *
 * @param error - The error (or thrown value) to redact.
 * @returns A redacted `Error`, or the original value when it is neither an
 *   `Error` nor a string.
 */
export function maskError(error: unknown): unknown {
  if (error instanceof Error) {
    const masked: Error = Object.create(Object.getPrototypeOf(error));
    for (const [key, value] of Object.entries(error)) {
      Object.defineProperty(masked, key, {
        value: typeof value === "string" ? maskCredentials(value) : value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    Object.defineProperty(masked, "message", {
      value: maskCredentials(error.message),
      enumerable: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(masked, "name", {
      value: error.name,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(masked, "stack", {
      value: typeof error.stack === "string" ? maskCredentials(error.stack) : error.stack,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    // `cause` is non-enumerable when set via the constructor option (as Node
    // fetch errors do), so it is preserved explicitly and masked too: a
    // nested cause can carry its own credentials.
    if (error.cause !== undefined) {
      const cause = error.cause;
      const maskedCause =
        cause instanceof Error
          ? maskError(cause)
          : typeof cause === "string"
            ? maskCredentials(cause)
            : cause;
      Object.defineProperty(masked, "cause", {
        value: maskedCause,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    return masked;
  }
  if (typeof error === "string") {
    return new Error(maskCredentials(error));
  }
  return error;
}

/**
 * Resolve the retry options for establishing the MCP connection.
 *
 * Defaults come from {@link withRetry} (maxRetries 3, initial delay 1000ms,
 * max delay 10000ms, factor 2, ±20% jitter). The initial delay and max
 * retries can be overridden via `EXA_RETRY_INITIAL_DELAY_MS` and
 * `EXA_RETRY_MAX_RETRIES` (used by tests to keep the suite fast).
 */
function resolveConnectionRetryOptions(): RetryOptions {
  const options: RetryOptions = {};
  const initialDelayMs = Number(process.env.EXA_RETRY_INITIAL_DELAY_MS);
  if (Number.isFinite(initialDelayMs) && initialDelayMs >= 0) {
    options.initialDelayMs = initialDelayMs;
  }
  const maxRetries = Number(process.env.EXA_RETRY_MAX_RETRIES);
  if (Number.isFinite(maxRetries) && maxRetries >= 0) {
    options.maxRetries = maxRetries;
  }
  return options;
}

/**
 * Resolve the Exa API key to attach to the MCP endpoint:
 * `useApiKey: false` in the extension config → `null` (public free
 * mode); otherwise `auth.json["exa"].key` then `EXA_API_KEY`.
 */
async function resolveExaApiKey(): Promise<string | null> {
  const config = await getConfig();
  return getExaApiKey(config.providers.exa.useApiKey);
}

/**
 * Get the singleton Exa MCP client, connecting lazily on first use.
 *
 * The resolved API key is part of the connection identity: when the key
 * changes (e.g. after `/ws exa` saves a new key or switches to public
 * mode) the previous connection is closed and a new one is established
 * so the query parameter always matches the current credential state.
 *
 * The `initialize` handshake is wrapped in {@link withRetry} so transient
 * network failures (5xx, connection resets) are retried with exponential
 * backoff. A connection that still fails is re-thrown with its
 * credentials redacted via {@link maskError} so API keys never
 * leak into traces.
 */
export async function getExaClient(): Promise<Client> {
  const apiKey = await resolveExaApiKey();
  if (activeClient !== null && activeApiKey === apiKey) {
    return activeClient;
  }
  if (connecting !== null) {
    return connecting;
  }

  const previous = activeClient;
  activeClient = null;
  activeApiKey = null;

  const promise = (async (): Promise<Client> => {
    if (previous !== null) {
      try {
        await previous.close();
      } catch {
        // Best effort: a stale connection must not block a new one.
      }
    }
    let client: Client;
    try {
      // A fresh Client/transport is created per attempt: the SDK's
      // `connect()` closes the transport on failure and the base Protocol
      // refuses to reconnect a Client whose previous transport is still
      // attached, so reusing one instance across retries is unsafe.
      client = await withRetry(
        async (): Promise<Client> => {
          const transport = new StreamableHTTPClientTransport(
            getExaMcpUrl(apiKey),
          );
          const candidate = new Client(CLIENT_INFO, { capabilities: {} });
          await candidate.connect(transport);
          return candidate;
        },
        resolveConnectionRetryOptions(),
      );
    } catch (error) {
      throw maskError(error);
    }
    activeClient = client;
    activeApiKey = apiKey;
    return client;
  })();
  connecting = promise;
  try {
    return await promise;
  } finally {
    connecting = null;
  }
}

/**
 * Close the singleton Exa MCP client and release its connections
 * (invoked on `session_shutdown`). Idempotent: a second call
 * when no client is active is a no-op.
 */
export async function closeExaClient(): Promise<void> {
  const pending = connecting;
  if (pending !== null) {
    try {
      await pending;
    } catch {
      // The connection failed; there is nothing to close.
    }
  }
  const client = activeClient;
  activeClient = null;
  activeApiKey = null;
  if (client === null) {
    return;
  }
  try {
    await client.close();
  } catch {
    // Best effort: shutdown must not fail because the server is gone.
  }
}
