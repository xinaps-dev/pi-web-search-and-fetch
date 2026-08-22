import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeExaApiKey, writeExaApiKey } from "../src/config/auth.js";
import { updateConfig } from "../src/config/index.js";
import { closeExaClient } from "../src/providers/exa/client.js";
import {
  EXA_ANSWER_TOOL,
  EXA_DEEP_SEARCH_DEFAULT_NUM_RESULTS,
  EXA_DEEP_SEARCH_DEFAULT_NUM_SOURCES,
  EXA_DEEP_SEARCH_TOOL,
  exaDeepSearchProvider,
} from "../src/providers/exa/deep-search.js";
import {
  EXA_FETCH_DEFAULT_MAX_CHARACTERS,
  EXA_FETCH_TOOL,
  exaFetchProvider,
} from "../src/providers/exa/fetch.js";
import type { FetchResponse } from "../src/providers/types.js";
import {
  EXA_FIND_SIMILAR_TOOL,
  EXA_SEARCH_ADVANCED_TOOL,
  EXA_SEARCH_DEFAULT_NUM_RESULTS,
  EXA_SEARCH_TOOL,
  exaSearchProvider,
} from "../src/providers/exa/search.js";
import { exaProviderModule } from "../src/providers/exa/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";

/**
 * In-process mock Exa MCP server supporting both `web_search_exa` and `web_fetch_exa`.
 * Records requests, query parameters on HTTP URLs (e.g. `?exaApiKey=...`), tool calls,
 * and allows customizing responses, errors, and delays for all Exa capabilities.
 */
interface MockExaMcpServer {
  url: string;
  requestUrls: string[];
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  searchResults: Array<Record<string, unknown>>;
  searchResultsByQuery: Record<string, Array<Record<string, unknown>>>;
  fetchPage: Record<string, unknown>;
  toolIsError: boolean;
  toolErrorMessage?: string;
  failQueries: Set<string>;
  toolDelayMs: number;
  /** Number of initial `tools/call` POSTs to fail with raw HTTP 503. */
  failFirstHttp503: number;
  /** Fetch URLs (matching the `url` tool argument) that fail with `isError`. */
  failFetchUrls: Set<string>;
  /** JSON text payload for `web_answer_exa`; null keeps the tool unavailable. */
  answerPayload: string | null;
  close(): Promise<void>;
}

async function startMockExaMcpServer(): Promise<MockExaMcpServer> {
  const state: MockExaMcpServer = {
    url: "",
    requestUrls: [],
    toolCalls: [],
    searchResults: [
      {
        title: "Default Search Result",
        url: "https://exa.ai/news/article",
        text: "Default search content and snippet.",
        publishedDate: "2025-01-15T10:00:00.000Z",
        author: "Exa Research",
        score: 0.95,
      },
    ],
    searchResultsByQuery: {},
    fetchPage: {
      url: "https://example.com/article",
      title: "Sample Web Page",
      content: "# Heading\n\nFetched page markdown content.",
      truncated: false,
    },
    toolIsError: false,
    failQueries: new Set(),
    toolDelayMs: 0,
    failFirstHttp503: 0,
    failFetchUrls: new Set(),
    answerPayload: null,
    close: async () => {},
  };

  const server = http.createServer((req, res) => {
    state.requestUrls.push(req.url ?? "/");

    if (req.method === "GET") {
      // SSE connection handshake
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
        let message: { method?: string; id?: number | string; params?: unknown };
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
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                serverInfo: { name: "mock-exa-mcp", version: "1.0.0" },
              },
            })
          );
          return;
        }

        if (message.method === "tools/call") {
          const params = message.params as
            | { name?: string; arguments?: Record<string, unknown> }
            | undefined;
          const toolName = params?.name ?? "";
          const args = params?.arguments ?? {};
          state.toolCalls.push({ name: toolName, arguments: args });

          const callIndex = state.toolCalls.length; // 1-based call number
          if (callIndex <= state.failFirstHttp503) {
            res.writeHead(503, { "content-type": "text/plain" });
            res.end("Service Unavailable");
            return;
          }

          const respond = () => {
            if (res.writableEnded) {
              return;
            }

            if (state.toolIsError) {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: state.toolErrorMessage ?? "Exa tool execution failed",
                      },
                    ],
                    isError: true,
                  },
                })
              );
              return;
            }

            if (
              toolName === EXA_SEARCH_TOOL ||
              toolName === EXA_SEARCH_ADVANCED_TOOL ||
              toolName === EXA_FIND_SIMILAR_TOOL
            ) {
              const queryStr = String(args.query ?? "");
              if (state.failQueries.has(queryStr)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                      content: [
                        {
                          type: "text",
                          text: `Query failed: ${queryStr}`,
                        },
                      ],
                      isError: true,
                    },
                  })
                );
                return;
              }

              const results =
                state.searchResultsByQuery[queryStr] ?? state.searchResults;
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({ results }),
                      },
                    ],
                    isError: false,
                  },
                })
              );
              return;
            }

            if (toolName === EXA_FETCH_TOOL) {
              const fetchUrl = Array.isArray(args.urls)
                ? (args.urls[0] as string)
                : String(args.url ?? "");
              if (state.failFetchUrls.has(fetchUrl)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                      content: [
                        {
                          type: "text",
                          text: "HTTP 404 page not found",
                        },
                      ],
                      isError: true,
                    },
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
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify(state.fetchPage),
                      },
                    ],
                    isError: false,
                  },
                })
              );
              return;
            }

            if (toolName === EXA_ANSWER_TOOL) {
              if (state.answerPayload !== null) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                      content: [
                        { type: "text", text: state.answerPayload },
                      ],
                      isError: false,
                    },
                  })
                );
                return;
              }
              // Answer tool unavailable: report an error so the provider
              // falls back to deep search synthesis.
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: `Unknown tool: ${toolName}`,
                      },
                    ],
                    isError: true,
                  },
                })
              );
              return;
            }

            // Unknown tool
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
                  isError: true,
                },
              })
            );
          };

          if (state.toolDelayMs > 0) {
            const timer = setTimeout(respond, state.toolDelayMs);
            timer.unref?.();
          } else {
            respond();
          }
          return;
        }

        // Other notifications
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
    throw new Error("Failed to resolve mock server address");
  }

  state.url = `http://127.0.0.1:${address.port}/mcp`;
  state.close = () =>
    new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    });

  return state;
}

describe("src/providers/exa (tests/exa.test.ts)", () => {
  let tmpDir: string;
  let mockServer: MockExaMcpServer;
  const prevAgentDir = process.env.PI_AGENT_DIR;
  const prevExaKey = process.env.EXA_API_KEY;
  const prevMcpEndpoint = process.env.EXA_MCP_ENDPOINT;
  const prevSearchTimeout = process.env.EXA_SEARCH_TIMEOUT_MS;
  const prevFetchTimeout = process.env.EXA_FETCH_TIMEOUT_MS;
  const prevDeepTimeout = process.env.EXA_DEEP_SEARCH_TIMEOUT_MS;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-exa-test-"));
    process.env.PI_AGENT_DIR = tmpDir;
    delete process.env.EXA_API_KEY;
    delete process.env.EXA_SEARCH_TIMEOUT_MS;
    delete process.env.EXA_FETCH_TIMEOUT_MS;
    delete process.env.EXA_DEEP_SEARCH_TIMEOUT_MS;

    await closeExaClient();
    mockServer = await startMockExaMcpServer();
    process.env.EXA_MCP_ENDPOINT = mockServer.url;
  });

  afterEach(async () => {
    await closeExaClient();
    delete process.env.EXA_MCP_ENDPOINT;
    await mockServer.close();

    if (prevAgentDir !== undefined) {
      process.env.PI_AGENT_DIR = prevAgentDir;
    } else {
      delete process.env.PI_AGENT_DIR;
    }
    if (prevExaKey !== undefined) {
      process.env.EXA_API_KEY = prevExaKey;
    } else {
      delete process.env.EXA_API_KEY;
    }
    if (prevMcpEndpoint !== undefined) {
      process.env.EXA_MCP_ENDPOINT = prevMcpEndpoint;
    } else {
      delete process.env.EXA_MCP_ENDPOINT;
    }
    if (prevSearchTimeout !== undefined) {
      process.env.EXA_SEARCH_TIMEOUT_MS = prevSearchTimeout;
    } else {
      delete process.env.EXA_SEARCH_TIMEOUT_MS;
    }
    if (prevFetchTimeout !== undefined) {
      process.env.EXA_FETCH_TIMEOUT_MS = prevFetchTimeout;
    } else {
      delete process.env.EXA_FETCH_TIMEOUT_MS;
    }
    if (prevDeepTimeout !== undefined) {
      process.env.EXA_DEEP_SEARCH_TIMEOUT_MS = prevDeepTimeout;
    } else {
      delete process.env.EXA_DEEP_SEARCH_TIMEOUT_MS;
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Authentication Modes
  // ---------------------------------------------------------------------------
  describe("Authentication Modes", () => {
    it("Mode 1 (Public / Free mode): operates without API key, search and fetch succeed, deepSearch fails", async () => {
      // 1. Search works in public mode without query param exaApiKey
      const searchRes = await exaSearchProvider.search("typescript tutorials");
      expect(searchRes.provider).toBe("exa");
      expect(searchRes.results).toHaveLength(1);
      expect(searchRes.results[0].title).toBe("Default Search Result");

      // Verify no exaApiKey in connection URLs
      expect(mockServer.requestUrls.length).toBeGreaterThan(0);
      for (const reqUrl of mockServer.requestUrls) {
        expect(reqUrl).not.toContain("exaApiKey");
      }

      // 2. Fetch works in public mode
      const fetchRes = (await exaFetchProvider.fetch(
        "https://example.com/article"
      )) as FetchResponse;
      expect(fetchRes.provider).toBe("exa");
      expect(fetchRes.content).toContain("Fetched page markdown content");

      // 3. Deep search requires user API key and throws descriptive error
      await expect(
        exaDeepSearchProvider.deepSearch("deep query")
      ).rejects.toThrow(/requires its own Exa API key/i);
    });

    it("Mode 2 (auth.json API Key): connects with exaApiKey query param, all 3 methods succeed", async () => {
      writeExaApiKey("stored-secret-key-123");

      // 1. Search with API key
      const searchRes = await exaSearchProvider.search("vitest mocking");
      expect(searchRes.results).toHaveLength(1);

      // Verify exaApiKey was passed in URL
      const hasApiKeyParam = mockServer.requestUrls.some((u) =>
        u.includes("exaApiKey=stored-secret-key-123")
      );
      expect(hasApiKeyParam).toBe(true);

      // 2. Fetch with API key
      const fetchRes = (await exaFetchProvider.fetch(
        "https://example.com/doc"
      )) as FetchResponse;
      expect(fetchRes.content).toContain("Fetched page markdown content");

      // 3. Deep search with API key succeeds
      mockServer.searchResultsByQuery["multi-agent design"] = [
        {
          title: "Multi-Agent System",
          url: "https://example.com/agents",
          text: "Agent architecture overview.",
          highlights: ["Deep agent highlight"],
        },
      ];

      const deepRes = await exaDeepSearchProvider.deepSearch("multi-agent design");
      expect(deepRes.provider).toBe("exa");
      expect(deepRes.results).toHaveLength(1);
      expect(deepRes.results[0].title).toBe("Multi-Agent System");
      expect(deepRes.results[0].highlights).toEqual(["Deep agent highlight"]);
    });

    it("Mode 3 (EXA_API_KEY environment variable): connects with env key, all 3 methods succeed", async () => {
      process.env.EXA_API_KEY = "env-secret-key-456";

      const searchRes = await exaSearchProvider.search("query with env");
      expect(searchRes.results[0].title).toBe("Default Search Result");

      const hasEnvKey = mockServer.requestUrls.some((u) =>
        u.includes("exaApiKey=env-secret-key-456")
      );
      expect(hasEnvKey).toBe(true);

      const deepRes = await exaDeepSearchProvider.deepSearch("query with env");
      expect(deepRes.query).toBe("query with env");
      expect(deepRes.results.length).toBeGreaterThan(0);
    });

    it("Mode 4 (Disabled API Key in config): operates in public mode even if key exists, deepSearch fails", async () => {
      writeExaApiKey("present-but-disabled-key");
      await updateConfig({ providers: { exa: { useApiKey: false } } });

      const searchRes = await exaSearchProvider.search("query disabled key");
      expect(searchRes.results.length).toBe(1);

      // URL should NOT have exaApiKey
      for (const reqUrl of mockServer.requestUrls) {
        expect(reqUrl).not.toContain("exaApiKey");
      }

      await expect(
        exaDeepSearchProvider.deepSearch("deep search disabled key")
      ).rejects.toThrow(/requires its own Exa API key/i);
    });

    it("reconnects when switching authentication mode or updating key", async () => {
      // Step 1: Start in public mode
      await exaSearchProvider.search("public query");
      expect(mockServer.requestUrls.some((u) => u.includes("exaApiKey"))).toBe(false);

      // Step 2: Store API key -> client is invalidated and reconnected
      writeExaApiKey("new-auth-key");
      mockServer.requestUrls.length = 0;

      await exaSearchProvider.search("authenticated query");
      expect(mockServer.requestUrls.some((u) => u.includes("exaApiKey=new-auth-key"))).toBe(true);

      // Step 3: Remove key -> client reconnected in public mode
      removeExaApiKey();
      mockServer.requestUrls.length = 0;

      await exaSearchProvider.search("back to public query");
      expect(mockServer.requestUrls.some((u) => u.includes("exaApiKey"))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Search Provider Method (exaSearchProvider.search)
  // ---------------------------------------------------------------------------
  describe("Search Provider (web_search_exa)", () => {
    it("calls web_search_exa with default parameters (numResults: 10)", async () => {
      expect(EXA_SEARCH_DEFAULT_NUM_RESULTS).toBe(10);
      const response = await exaSearchProvider.search("model context protocol");

      expect(mockServer.toolCalls).toHaveLength(1);
      expect(mockServer.toolCalls[0].name).toBe(EXA_SEARCH_TOOL);
      expect(mockServer.toolCalls[0].arguments).toEqual({
        query: "model context protocol",
        numResults: EXA_SEARCH_DEFAULT_NUM_RESULTS,
      });

      expect(response.query).toBe("model context protocol");
      expect(response.provider).toBe("exa");
      expect(response.results).toEqual([
        {
          title: "Default Search Result",
          url: "https://exa.ai/news/article",
          snippet: "Default search content and snippet.",
          publishedDate: "2025-01-15T10:00:00.000Z",
          author: "Exa Research",
          score: 0.95,
          raw: mockServer.searchResults[0],
        },
      ]);
    });

    it("passes custom numResults and category filter", async () => {
      await exaSearchProvider.search("ai safety", {
        numResults: 5,
        category: "research paper",
      });

      expect(mockServer.toolCalls[0].name).toBe(EXA_SEARCH_ADVANCED_TOOL);
      expect(mockServer.toolCalls[0].arguments).toEqual({
        query: "ai safety",
        numResults: 5,
        category: "publication",
      });
    });

    it("handles tool error responses with descriptive messages", async () => {
      mockServer.toolIsError = true;
      mockServer.toolErrorMessage = "Exa rate limit exceeded";

      await expect(
        exaSearchProvider.search("rate limited search")
      ).rejects.toThrow(/Exa search failed: Exa rate limit exceeded/);
    });

    it("honors pre-aborted and in-flight cancellation signals", async () => {
      const preAborted = AbortSignal.abort("user aborted");
      await expect(
        exaSearchProvider.search("abort search", undefined, preAborted)
      ).rejects.toThrow(/aborted/i);

      const controller = new AbortController();
      mockServer.toolDelayMs = 500;
      const searchPromise = exaSearchProvider.search(
        "in-flight abort",
        undefined,
        controller.signal
      );
      setTimeout(() => controller.abort(new Error("cancelled by user")), 50);

      await expect(searchPromise).rejects.toThrow();
    });

    it("dispatches transparently to findSimilar when similarUrl is provided", async () => {
      const response = await exaSearchProvider.search("ignored query", {
        similarUrl: "https://example.com/reference",
      });

      expect(mockServer.toolCalls).toHaveLength(1);
      expect(mockServer.toolCalls[0].name).toBe(EXA_SEARCH_TOOL);
      expect(mockServer.toolCalls[0].arguments).toEqual({
        query: "https://example.com/reference",
        numResults: EXA_SEARCH_DEFAULT_NUM_RESULTS,
      });
      expect(response.query).toBe("https://example.com/reference");
      expect(response.metadata?.similarUrl).toBe("https://example.com/reference");
    });

    it("maps advanced domain and date filters to the tool arguments", async () => {
      await exaSearchProvider.search("filtered query", {
        includeDomains: ["exa.ai"],
        excludeDomains: ["reddit.com"],
        startPublishedDate: "2025-01-01",
        endPublishedDate: "2025-06-30",
      });

      expect(mockServer.toolCalls[0].name).toBe(EXA_SEARCH_ADVANCED_TOOL);
      expect(mockServer.toolCalls[0].arguments).toEqual({
        query: "filtered query",
        numResults: EXA_SEARCH_DEFAULT_NUM_RESULTS,
        includeDomains: ["exa.ai"],
        excludeDomains: ["reddit.com"],
        startPublishedDate: "2025-01-01",
        endPublishedDate: "2025-06-30",
      });
    });

    it("recovers from a transient HTTP 503 during search", async () => {
      mockServer.failFirstHttp503 = 1;

      const response = await exaSearchProvider.search("flaky search");

      expect(mockServer.toolCalls).toHaveLength(2);
      expect(mockServer.toolCalls[1].name).toBe(EXA_SEARCH_TOOL);
      expect(response.results).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Fetch Provider Method (exaFetchProvider.fetch)
  // ---------------------------------------------------------------------------
  describe("Fetch Provider (web_fetch_exa)", () => {
    it("calls web_fetch_exa with default maxCharacters and normalizes URL", async () => {
      const response = (await exaFetchProvider.fetch(
        "http://example.com/article"
      )) as FetchResponse;

      expect(mockServer.toolCalls).toHaveLength(1);
      expect(mockServer.toolCalls[0].name).toBe(EXA_FETCH_TOOL);
      // HTTP upgraded to HTTPS
      expect(EXA_FETCH_DEFAULT_MAX_CHARACTERS).toBe(5000);
      expect(mockServer.toolCalls[0].arguments).toEqual({
        urls: ["https://example.com/article"],
        maxCharacters: EXA_FETCH_DEFAULT_MAX_CHARACTERS,
      });

      expect(response.url).toBe("https://example.com/article");
      expect(response.title).toBe("Sample Web Page");
      expect(response.content).toBe("# Heading\n\nFetched page markdown content.");
      expect(response.provider).toBe("exa");
    });

    it("passes explicit maxCharacters parameter", async () => {
      await exaFetchProvider.fetch("https://example.com/long-page", {
        maxCharacters: 5000,
      });

      expect(mockServer.toolCalls[0].arguments).toEqual({
        urls: ["https://example.com/long-page"],
        maxCharacters: 5000,
      });
    });

    it("rejects invalid or non-HTTP(S) URLs before calling MCP", async () => {
      await expect(exaFetchProvider.fetch("not-a-valid-url")).rejects.toThrow(
        /fully-formed http\(s\) url/i
      );
      expect(mockServer.toolCalls).toHaveLength(0);
    });

    it("handles tool error responses on fetch", async () => {
      mockServer.toolIsError = true;
      mockServer.toolErrorMessage = "HTTP 404 Not Found";

      await expect(
        exaFetchProvider.fetch("https://example.com/missing")
      ).rejects.toThrow(/Exa fetch failed: HTTP 404 Not Found/);
    });

    it("honors fetch cancellation signal", async () => {
      const preAborted = AbortSignal.abort("fetch aborted");
      await expect(
        exaFetchProvider.fetch("https://example.com/doc", undefined, preAborted)
      ).rejects.toThrow(/aborted/i);
    });

    it("fetches multiple URLs in a batch and preserves order", async () => {
      const response = (await exaFetchProvider.fetch([
        "https://example.com/one",
        "https://example.com/two",
      ])) as FetchResponse[];

      expect(response).toHaveLength(2);
      expect(response.map((r) => r.url)).toEqual([
        "https://example.com/one",
        "https://example.com/two",
      ]);
      expect(mockServer.toolCalls).toHaveLength(2);
      for (const call of mockServer.toolCalls) {
        expect(call.name).toBe(EXA_FETCH_TOOL);
        expect(call.arguments.maxCharacters).toBe(
          EXA_FETCH_DEFAULT_MAX_CHARACTERS
        );
      }
    });

    it("maps a failed URL in a batch to a fallback FetchResponse without sinking the batch", async () => {
      mockServer.failFetchUrls.add("https://example.com/broken");

      const response = (await exaFetchProvider.fetch([
        "https://example.com/one",
        "https://example.com/broken",
      ])) as FetchResponse[];

      expect(response).toHaveLength(2);
      expect(response[0].content).toBe("# Heading\n\nFetched page markdown content.");
      expect(response[1].url).toBe("https://example.com/broken");
      expect(response[1].title).toBe("Error");
      expect(response[1].content).toBe(
        "Failed to fetch https://example.com/broken: Exa fetch failed: HTTP 404 page not found"
      );
    });

    it("truncates fetched content with truncateMarkdown", async () => {
      mockServer.fetchPage.content = "x".repeat(40);

      const response = (await exaFetchProvider.fetch("https://example.com/long", {
        maxCharacters: 10,
      })) as FetchResponse;

      expect(response.content).toBe(
        "x".repeat(10) + "\n\n[... Contenido truncado a 10 caracteres ...]"
      );
      expect(response.metadata?.truncated).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Deep Search Provider Method (exaDeepSearchProvider.deepSearch)
  // ---------------------------------------------------------------------------
  describe("Deep Search Provider (multi-query parallel execution & synthesis)", () => {
    beforeEach(() => {
      writeExaApiKey("deep-search-valid-key");
    });

    it("executes parallel queries and synthesizes results with URL deduplication", async () => {
      mockServer.searchResultsByQuery["quantum computing"] = [
        {
          title: "Quantum Computing 101",
          url: "https://example.com/qc-intro",
          text: "Introduction to qubits and superposition.",
          highlights: ["Superposition allows simultaneous states"],
        },
        {
          title: "Shared Article",
          url: "https://example.com/shared",
          text: "First query text for shared article.",
          highlights: ["Highlight from query 1"],
        },
      ];

      mockServer.searchResultsByQuery["quantum error correction"] = [
        {
          title: "Surface Codes",
          url: "https://example.com/surface-codes",
          text: "Surface codes in topological quantum memory.",
          highlights: ["Fault tolerance threshold"],
        },
        {
          title: "Shared Article",
          url: "https://example.com/shared",
          text: "Duplicate text from query 2",
          highlights: ["Highlight from query 2"],
        },
      ];

      const response = await exaDeepSearchProvider.deepSearch(
        "quantum computing",
        {
          numResults: 5,
          category: "research paper",
          additionalQueries: ["quantum error correction"],
        }
      );

      expect(mockServer.toolCalls).toHaveLength(2);
      expect(response.query).toBe("quantum computing");
      expect(response.provider).toBe("exa");
      expect(response.subQueriesExecuted).toEqual([
        "quantum computing",
        "quantum error correction",
      ]);

      // Result deduplication: shared article merged into single entry with unioned highlights
      expect(response.results).toHaveLength(3);
      const shared = response.results.find((r) => r.url === "https://example.com/shared");
      expect(shared).toBeDefined();
      expect(shared?.highlights).toEqual([
        "Highlight from query 1",
        "Highlight from query 2",
      ]);
    });

    it("is resilient when secondary subquery fails (main query succeeds)", async () => {
      mockServer.failQueries.add("failing subquery");

      const response = await exaDeepSearchProvider.deepSearch("main valid query", {
        additionalQueries: ["failing subquery"],
      });

      expect(response.subQueriesExecuted).toEqual(["main valid query"]);
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.metadata?.failedQueries).toEqual(["failing subquery"]);
    });

    it("fails when the main primary query fails", async () => {
      mockServer.failQueries.add("broken main query");

      await expect(
        exaDeepSearchProvider.deepSearch("broken main query", {
          additionalQueries: ["working secondary query"],
        })
      ).rejects.toThrow(/Query failed: broken main query/);
    });

    it("honors deepSearch cancellation signal", async () => {
      const preAborted = AbortSignal.abort("deep abort");
      await expect(
        exaDeepSearchProvider.deepSearch("abort deep", undefined, preAborted)
      ).rejects.toThrow(/aborted/i);
    });

    it("returns the direct answer with citations from web_answer_exa", async () => {
      mockServer.answerPayload = JSON.stringify({
        answer: "Exa is a search API.",
        citations: [
          {
            id: "1",
            url: "https://example.com/exa",
            title: "Exa docs",
            text: "excerpt one",
          },
          { id: "2", url: "https://example.com/exa-2", title: "Exa blog" },
        ],
      });

      const response = await exaDeepSearchProvider.answer!("what is exa?");

      expect(mockServer.toolCalls).toHaveLength(1);
      expect(mockServer.toolCalls[0].name).toBe(EXA_ANSWER_TOOL);
      expect(mockServer.toolCalls[0].arguments).toEqual({
        query: "what is exa?",
        numSources: EXA_DEEP_SEARCH_DEFAULT_NUM_SOURCES,
        text: true,
      });
      expect(response.results).toEqual([
        { title: "Exa docs", url: "https://example.com/exa", text: "excerpt one" },
        { title: "Exa blog", url: "https://example.com/exa-2" },
      ]);
      expect(response.metadata?.answer).toBe("Exa is a search API.");
      expect(response.metadata?.numSources).toBe(
        EXA_DEEP_SEARCH_DEFAULT_NUM_SOURCES
      );
      expect(response.metadata?.includeText).toBe(true);
    });

    it("falls back to deep search synthesis when the answer tool is unavailable", async () => {
      const response = await exaDeepSearchProvider.answer!("fallback query?");

      expect(mockServer.toolCalls.map((call) => call.name)).toEqual([
        EXA_ANSWER_TOOL,
        EXA_DEEP_SEARCH_TOOL,
      ]);
      expect(response.results).toHaveLength(1);
      expect(response.results[0].title).toBe("Default Search Result");
      expect(response.subQueriesExecuted).toEqual(["fallback query?"]);
      expect(response.metadata?.numSources).toBe(
        EXA_DEEP_SEARCH_DEFAULT_NUM_SOURCES
      );
      expect(response.metadata?.includeText).toBe(true);
      expect(response.metadata?.answer).toBeUndefined();
    });

    it("maps numSources and includeText to the answer tool", async () => {
      mockServer.answerPayload = JSON.stringify({
        answer: "Short answer.",
        citations: [
          { id: "1", url: "https://example.com/a", title: "A", text: "hidden" },
        ],
      });

      const response = await exaDeepSearchProvider.answer!("q", {
        numSources: 3,
        includeText: false,
      });

      expect(mockServer.toolCalls[0].arguments).toEqual({
        query: "q",
        numSources: 3,
        text: false,
      });
      expect(response.results).toHaveLength(1);
      expect("text" in response.results[0]).toBe(false);
      expect(response.metadata?.includeText).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // ProviderRegistry & ProviderModule Integration
  // ---------------------------------------------------------------------------
  describe("ProviderRegistry & ProviderModule Integration", () => {
    it("registers exaProviderModule and resolves all 3 providers correctly", async () => {
      const registry = new ProviderRegistry();
      registry.registerProvider(exaProviderModule);

      expect(registry.getProvider("exa")).toBe(exaProviderModule);

      const searchProv = registry.getSearchProvider("exa");
      expect(searchProv.id).toBe("exa");
      expect(searchProv).toBe(exaSearchProvider);

      const fetchProv = registry.getFetchProvider("exa");
      expect(fetchProv.id).toBe("exa");
      expect(fetchProv).toBe(exaFetchProvider);

      const deepProv = registry.getDeepSearchProvider("exa");
      expect(deepProv.id).toBe("exa");
      expect(deepProv).toBe(exaDeepSearchProvider);

      // Execute search through registry reference
      const searchRes = await searchProv.search("registry query");
      expect(searchRes.results).toHaveLength(1);
    });
  });
});
