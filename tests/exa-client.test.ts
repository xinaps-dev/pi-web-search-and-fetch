import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeExaApiKey, writeExaApiKey } from "../src/config/auth.js";
import { updateConfig } from "../src/config/index.js";
import {
  EXA_API_KEY_QUERY_PARAM,
  EXA_MCP_ENDPOINT,
  closeExaClient,
  getExaClient,
  getExaMcpUrl,
  maskError,
} from "../src/providers/exa/client.js";

/**
 * Minimal in-process Exa MCP (Streamable HTTP) test server.
 *
 * It answers the MCP `initialize` handshake and keeps GET SSE streams
 * open so tests can observe connection lifecycle (open streams are
 * released when the client closes) and inspect the request URLs the
 * client connects with (API key query param).
 */
interface TestExaServer {
  /** Base URL the client should connect to. */
  url: string;
  /** Number of `initialize` requests received (one per connection). */
  initializeCount: number;
  /** Currently open GET SSE streams. */
  openStreams: number;
  /** `req.url` of every request, in order. */
  requestUrls: string[];
  close(): Promise<void>;
}

async function startTestExaServer(): Promise<TestExaServer> {
  const state = {
    initializeCount: 0,
    openStreams: 0,
    requestUrls: [] as string[],
  };
  const server = http.createServer((req, res) => {
    state.requestUrls.push(req.url ?? "/");
    if (req.method === "GET") {
      // Keep the SSE stream open (no data) until the client aborts it.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      state.openStreams++;
      res.on("close", () => {
        state.openStreams--;
      });
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        let message: { method?: string; id?: number | string };
        try {
          message = JSON.parse(body);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            })
          );
          return;
        }
        if (message.method === "initialize") {
          state.initializeCount++;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                serverInfo: { name: "exa-test-server", version: "0.0.1" },
              },
            })
          );
          return;
        }
        // Notifications (e.g. `notifications/initialized`) and anything
        // else: accepted, no response body.
        res.writeHead(202);
        res.end();
      });
      return;
    }
    res.writeHead(405);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Unexpected server address");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    get initializeCount() {
      return state.initializeCount;
    },
    get openStreams() {
      return state.openStreams;
    },
    requestUrls: state.requestUrls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** Poll `condition` until it is true or fail after `timeoutMs`. */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("src/providers/exa/client", () => {
  let tmpDir: string;
  let server: TestExaServer;
  const prevAgentDir = process.env.PI_AGENT_DIR;
  const prevExaKey = process.env.EXA_API_KEY;
  const prevMcpEndpoint = process.env.EXA_MCP_ENDPOINT;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-exa-client-"));
    process.env.PI_AGENT_DIR = tmpDir;
    delete process.env.EXA_API_KEY;
    await closeExaClient();
    server = await startTestExaServer();
    process.env.EXA_MCP_ENDPOINT = server.url;
  });

  afterEach(async () => {
    await closeExaClient();
    delete process.env.EXA_MCP_ENDPOINT;
    await server.close();
    if (prevAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = prevAgentDir;
    }
    if (prevExaKey === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = prevExaKey;
    }
    if (prevMcpEndpoint === undefined) {
      delete process.env.EXA_MCP_ENDPOINT;
    } else {
      process.env.EXA_MCP_ENDPOINT = prevMcpEndpoint;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getExaMcpUrl", () => {
    it("points at the public Exa MCP endpoint without a key", () => {
      delete process.env.EXA_MCP_ENDPOINT;
      try {
        const url = getExaMcpUrl(null);
        expect(url.origin + url.pathname).toBe("https://mcp.exa.ai/mcp");
        expect(url.searchParams.get("tools")).toBe(
          "web_search_exa,web_search_advanced_exa,web_fetch_exa"
        );
        expect(url.searchParams.has(EXA_API_KEY_QUERY_PARAM)).toBe(false);
      } finally {
        process.env.EXA_MCP_ENDPOINT = server.url;
      }
    });

    it("attaches the API key as the exaApiKey query param", () => {
      delete process.env.EXA_MCP_ENDPOINT;
      try {
        const url = getExaMcpUrl("813a7c54-ee2b-42f4-a940-a9365d298728");
        expect(url.origin + url.pathname).toBe("https://mcp.exa.ai/mcp");
        expect(url.searchParams.get(EXA_API_KEY_QUERY_PARAM)).toBe(
          "813a7c54-ee2b-42f4-a940-a9365d298728"
        );
        expect(url.searchParams.get("tools")).toBe(
          "web_search_exa,web_search_advanced_exa,web_fetch_exa"
        );
      } finally {
        process.env.EXA_MCP_ENDPOINT = server.url;
      }
    });

    it("honors the EXA_MCP_ENDPOINT override", () => {
      const override = "http://127.0.0.1:9999/custom";
      process.env.EXA_MCP_ENDPOINT = override;
      try {
        const url = getExaMcpUrl(null);
        expect(url.origin + url.pathname).toBe("http://127.0.0.1:9999/custom");
        expect(url.searchParams.get("tools")).toBe(
          "web_search_exa,web_search_advanced_exa,web_fetch_exa"
        );
      } finally {
        process.env.EXA_MCP_ENDPOINT = server.url;
      }
    });
  });

  describe("getExaClient", () => {
    it("connects in public free mode without any API key", async () => {
      const client = await getExaClient();

      expect(client).toBeInstanceOf(Client);
      expect(server.initializeCount).toBe(1);
      const postUrl = server.requestUrls.find((u) => u.startsWith("/mcp"));
      expect(postUrl).toBeDefined();
      expect(
        new URL(postUrl as string, "http://x").searchParams.has(
          EXA_API_KEY_QUERY_PARAM
        )
      ).toBe(false);
    });

    it("attaches the stored auth.json API key as query param", async () => {
      writeExaApiKey("stored-key-123");
      await getExaClient();

      const url = new URL(
        server.requestUrls.find((u) => u.includes(EXA_API_KEY_QUERY_PARAM)) ??
          "",
        "http://x"
      );
      expect(url.searchParams.get(EXA_API_KEY_QUERY_PARAM)).toBe(
        "stored-key-123"
      );
    });

    it("falls back to process.env.EXA_API_KEY when no key is stored", async () => {
      process.env.EXA_API_KEY = "env-key-456";
      await getExaClient();

      const url = new URL(
        server.requestUrls.find((u) => u.includes(EXA_API_KEY_QUERY_PARAM)) ??
          "",
        "http://x"
      );
      expect(url.searchParams.get(EXA_API_KEY_QUERY_PARAM)).toBe(
        "env-key-456"
      );
    });

    it("stays in public mode when useApiKey is false, even with a stored key", async () => {
      writeExaApiKey("stored-key-123");
      await updateConfig({ providers: { exa: { useApiKey: false } } });
      await getExaClient();

      expect(
        server.requestUrls.some((u) => u.includes(EXA_API_KEY_QUERY_PARAM))
      ).toBe(false);
    });

    it("returns the same singleton client on repeated calls", async () => {
      const first = await getExaClient();
      const second = await getExaClient();

      expect(first).toBe(second);
      expect(server.initializeCount).toBe(1);
    });

    it("reconnects without the key when the API key is removed", async () => {
      writeExaApiKey("stored-key-123");
      const keyed = await getExaClient();
      expect(server.initializeCount).toBe(1);
      const requestsBefore = server.requestUrls.length;

      removeExaApiKey();
      const publicClient = await getExaClient();

      expect(publicClient).not.toBe(keyed);
      expect(server.initializeCount).toBe(2);
      expect(
        server.requestUrls
          .slice(requestsBefore)
          .some((u) => u.includes(EXA_API_KEY_QUERY_PARAM))
      ).toBe(false);
    });
  });

  describe("closeExaClient", () => {
    it("releases the open connections", async () => {
      await getExaClient();
      await waitFor(() => server.openStreams > 0);
      expect(server.openStreams).toBeGreaterThan(0);

      await closeExaClient();
      await waitFor(() => server.openStreams === 0);
      expect(server.openStreams).toBe(0);
    });

    it("is a no-op when no client is active", async () => {
      await expect(closeExaClient()).resolves.toBeUndefined();
      expect(server.initializeCount).toBe(0);
    });

    it("allows a fresh connection after closing", async () => {
      await getExaClient();
      await closeExaClient();

      const client = await getExaClient();
      expect(client).toBeInstanceOf(Client);
      expect(server.initializeCount).toBe(2);
    });
  });
});

describe("maskError", () => {
  it("redacts exaApiKey query params in the message", () => {
    const err = new Error(
      "connect failed: https://mcp.exa.ai/mcp?exaApiKey=super-secret-123",
    );
    const masked = maskError(err) as Error;
    expect(masked.message).not.toContain("super-secret-123");
    expect(masked.message).toContain("exaApiKey=[REDACTED]");
  });

  it("redacts Bearer tokens in the message", () => {
    const masked = maskError(
      new Error("auth failed: Bearer abc.def.ghi"),
    ) as Error;
    expect(masked.message).not.toContain("abc.def.ghi");
    expect(masked.message).toContain("Bearer [REDACTED]");
  });

  it("redacts x-api-key header values in the message", () => {
    const masked = maskError(
      new Error("headers: x-api-key: my-secret-key"),
    ) as Error;
    expect(masked.message).not.toContain("my-secret-key");
    expect(masked.message).toContain("x-api-key: [REDACTED]");
  });

  it("preserves enumerable own properties, masking string values", () => {
    const err = new Error("boom") as Error & { code: number; detail: string };
    err.code = 500;
    err.detail = "exaApiKey=abc123";
    const masked = maskError(err) as Error & { code: number; detail: string };
    expect(masked.code).toBe(500);
    expect(masked.detail).not.toContain("abc123");
    expect(masked.detail).toContain("[REDACTED]");
  });

  it("preserves the error class so instanceof keeps working", () => {
    class CustomError extends Error {}
    const masked = maskError(new CustomError("boom"));
    expect(masked).toBeInstanceOf(CustomError);
    expect(masked).toBeInstanceOf(Error);
  });

  it("preserves name and masks credentials in stack", () => {
    const err = new Error("boom exaApiKey=stack-key-999");
    err.name = "MyError";
    const masked = maskError(err) as Error;
    expect(masked.name).toBe("MyError");
    expect(masked.stack).toBeDefined();
    expect(masked.stack).not.toContain("stack-key-999");
    expect(masked.stack).toContain("[REDACTED]");
  });

  it("preserves and masks a nested Error cause", () => {
    const inner = new Error("exaApiKey=cause-secret-789");
    const err = new Error("outer", { cause: inner });
    const masked = maskError(err) as Error;
    expect(masked.cause).toBeInstanceOf(Error);
    expect((masked.cause as Error).message).not.toContain("cause-secret-789");
    expect((masked.cause as Error).message).toContain("[REDACTED]");
  });

  it("preserves and masks a string cause", () => {
    const err = new Error("outer", { cause: "exaApiKey=string-cause-111" });
    const masked = maskError(err) as Error;
    expect(masked.cause).not.toContain("string-cause-111");
    expect(masked.cause).toContain("[REDACTED]");
  });

  it("wraps a thrown string in a redacted Error", () => {
    const masked = maskError("exaApiKey=plain-string-key") as Error;
    expect(masked).toBeInstanceOf(Error);
    expect(masked.message).not.toContain("plain-string-key");
    expect(masked.message).toContain("exaApiKey=[REDACTED]");
  });

  it("passes through non-Error, non-string values unchanged", () => {
    expect(maskError(42)).toBe(42);
    expect(maskError(null)).toBe(null);
    expect(maskError(undefined)).toBe(undefined);
    const obj = { a: 1 };
    expect(maskError(obj)).toBe(obj);
  });
});

describe("getExaClient connection error masking", () => {
  let tmpDir: string;
  let failingServer: http.Server;
  const prevAgentDir = process.env.PI_AGENT_DIR;
  const prevExaKey = process.env.EXA_API_KEY;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-exa-mask-"));
    process.env.PI_AGENT_DIR = tmpDir;
    delete process.env.EXA_API_KEY;
    await closeExaClient();
    // A server that always fails `initialize` and echoes the API key back in
    // the 500 body, simulating a server that leaks the credential in its error.
    failingServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const key = url.searchParams.get(EXA_API_KEY_QUERY_PARAM);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: `auth failed for exaApiKey=${key ?? "none"}` }),
      );
    });
    await new Promise<void>((resolve) => {
      failingServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = failingServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Unexpected server address");
    }
    process.env.EXA_MCP_ENDPOINT = `http://127.0.0.1:${address.port}/mcp`;
    // Fail fast: no retries, minimal delay.
    process.env.EXA_RETRY_MAX_RETRIES = "0";
    process.env.EXA_RETRY_INITIAL_DELAY_MS = "1";
    writeExaApiKey("leak-me-456");
  });

  afterEach(async () => {
    await closeExaClient();
    failingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      failingServer.close((err) => (err ? reject(err) : resolve()));
    });
    delete process.env.EXA_MCP_ENDPOINT;
    delete process.env.EXA_RETRY_MAX_RETRIES;
    delete process.env.EXA_RETRY_INITIAL_DELAY_MS;
    if (prevAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = prevAgentDir;
    }
    if (prevExaKey === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = prevExaKey;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("redacts the API key from a failed connection's error message", async () => {
    let thrown: unknown;
    try {
      await getExaClient();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain("leak-me-456");
    expect(message).toContain("[REDACTED]");
  });

  it("redacts the API key from a failed connection's error stack", async () => {
    let thrown: unknown;
    try {
      await getExaClient();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const stack = (thrown as Error).stack;
    if (stack) {
      expect(stack).not.toContain("leak-me-456");
      expect(stack).toContain("[REDACTED]");
    }
  });
});

describe("getExaClient retry recovery on transient failure", () => {
  let tmpDir: string;
  let flakyServer: http.Server;
  let attempts = 0;
  const prevAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-exa-retry-"));
    process.env.PI_AGENT_DIR = tmpDir;
    await closeExaClient();
    attempts = 0;

    flakyServer = http.createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": connected\n\n");
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk: string) => {
          body += chunk;
        });
        req.on("end", () => {
          let message: { method?: string; id?: number | string };
          try {
            message = JSON.parse(body);
          } catch {
            res.writeHead(400);
            res.end();
            return;
          }
          if (message.method === "initialize") {
            attempts++;
            if (attempts === 1) {
              res.writeHead(503, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: 503, message: "Service Unavailable" },
                })
              );
              return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-11-25",
                  capabilities: {},
                  serverInfo: { name: "exa-retry-server", version: "0.0.1" },
                },
              })
            );
            return;
          }
          res.writeHead(202);
          res.end();
        });
        return;
      }
      res.writeHead(405);
      res.end();
    });

    await new Promise<void>((resolve) => {
      flakyServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = flakyServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Unexpected server address");
    }
    process.env.EXA_MCP_ENDPOINT = `http://127.0.0.1:${address.port}/mcp`;
    process.env.EXA_RETRY_MAX_RETRIES = "3";
    process.env.EXA_RETRY_INITIAL_DELAY_MS = "5";
  });

  afterEach(async () => {
    await closeExaClient();
    flakyServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      flakyServer.close((err) => (err ? reject(err) : resolve()));
    });
    delete process.env.EXA_MCP_ENDPOINT;
    delete process.env.EXA_RETRY_MAX_RETRIES;
    delete process.env.EXA_RETRY_INITIAL_DELAY_MS;
    if (prevAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = prevAgentDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recovers and connects successfully after a transient 503 on first attempt", async () => {
    const client = await getExaClient();
    expect(client).toBeInstanceOf(Client);
    expect(attempts).toBe(2);
  });
});
