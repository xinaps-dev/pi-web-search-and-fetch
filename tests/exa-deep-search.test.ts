import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeExaClient } from "../src/providers/exa/client.js";
import { writeExaApiKey } from "../src/config/auth.js";
import {
  EXA_ANSWER_TOOL,
  EXA_DEEP_SEARCH_DEFAULT_NUM_RESULTS,
  EXA_DEEP_SEARCH_DEFAULT_NUM_SOURCES,
  EXA_DEEP_SEARCH_DEFAULT_TIMEOUT_MS,
  EXA_DEEP_SEARCH_TOOL,
  buildDeepSearchQueries,
  exaDeepSearchProvider,
} from "../src/providers/exa/deep-search.js";

/**
 * Minimal in-process Exa MCP (Streamable HTTP) test server that answers
 * the `initialize` handshake and `tools/call` requests, recording the tool
 * name and arguments it receives so tests can verify the parallel
 * multi-query execution and synthesis of the Exa deep search.
 */
interface TestExaServer {
  url: string;
  /** `tools/call` requests in order. */
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Raw results returned for every query not in `resultsByQuery`. */
  results: Array<Record<string, unknown>>;
  /** Per-query raw results (keyed by the `query` tool argument). */
  resultsByQuery: Record<string, Array<Record<string, unknown>>>;
  /** Queries for which the tool response reports `isError: true`. */
  failQueries: Set<string>;
  /** Override the tool response text payload (skips the JSON results). */
  contentText: string | null;
  /** Delay before answering a `tools/call` request, in milliseconds. */
  toolDelayMs: number;
  /** Number of initial `tools/call` POSTs to fail with raw HTTP 503. */
  failFirstHttp503: number;
  /** Number of initial `tools/call` POSTs to fail with raw HTTP 404. */
  failFirstHttp404: number;
  close(): Promise<void>;
}

async function startTestExaServer(): Promise<TestExaServer> {
  const state: TestExaServer = {
    url: "",
    toolCalls: [],
    results: [
      {
        title: "Main result",
        url: "https://example.com/main",
        text: "Main query content.",
        highlights: ["main highlight"],
      },
    ],
    resultsByQuery: {},
    failQueries: new Set(),
    contentText: null,
    toolDelayMs: 0,
    failFirstHttp503: 0,
    failFirstHttp404: 0,
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      // Keep the SSE stream open until the client aborts it.
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
                serverInfo: { name: "exa-test-server", version: "0.0.1" },
              },
            })
          );
          return;
        }
        if (message.method === "tools/call") {
          const params = message.params as
            | { name?: string; arguments?: Record<string, unknown> }
            | undefined;
          const query =
            typeof params?.arguments?.query === "string"
              ? (params.arguments.query as string)
              : "";
          state.toolCalls.push({
            name: params?.name ?? "",
            arguments: params?.arguments ?? {},
          });
          const callIndex = state.toolCalls.length; // 1-based call number
          if (callIndex <= state.failFirstHttp503) {
            res.writeHead(503, { "content-type": "text/plain" });
            res.end("Service Unavailable");
            return;
          }
          if (callIndex <= state.failFirstHttp404) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("Not Found");
            return;
          }
          const respond = () => {
            if (res.writableEnded) {
              return;
            }
            const text =
              state.contentText ??
              JSON.stringify({
                results: state.resultsByQuery[query] ?? state.results,
              });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  content: [{ type: "text", text }],
                  isError: state.failQueries.has(query),
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
        // Notifications (e.g. `notifications/initialized`): accepted, no
        // response body.
        res.writeHead(202);
        res.end();
        return;
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

  state.url = `http://127.0.0.1:${address.port}/mcp`;
  state.close = () =>
    new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  return state;
}

describe("src/providers/exa/deep-search", () => {
  let tmpDir: string;
  let server: TestExaServer;
  const prevAgentDir = process.env.PI_AGENT_DIR;
  const prevExaKey = process.env.EXA_API_KEY;
  const prevMcpEndpoint = process.env.EXA_MCP_ENDPOINT;
  const prevTimeoutMs = process.env.EXA_DEEP_SEARCH_TIMEOUT_MS;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-scout-exa-deep-"));
    process.env.PI_AGENT_DIR = tmpDir;
    delete process.env.EXA_API_KEY;
    delete process.env.EXA_DEEP_SEARCH_TIMEOUT_MS;
    await closeExaClient();
    server = await startTestExaServer();
    process.env.EXA_MCP_ENDPOINT = server.url;
  });

  /** Deep search requires its own API key; store one for the happy path. */
  function enableApiKey(): void {
    writeExaApiKey("test-exa-api-key");
  }

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
    if (prevTimeoutMs === undefined) {
      delete process.env.EXA_DEEP_SEARCH_TIMEOUT_MS;
    } else {
      process.env.EXA_DEEP_SEARCH_TIMEOUT_MS = prevTimeoutMs;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("API key validation", () => {
    it("rejects with a descriptive error when no API key is available", async () => {
      await expect(exaDeepSearchProvider.deepSearch("no key")).rejects.toThrow(
        "Exa deep search requires its own Exa API key"
      );
      expect(server.toolCalls).toHaveLength(0);
    });

    it("rejects when useApiKey is disabled even with a key stored", async () => {
      enableApiKey();
      fs.writeFileSync(
        path.join(tmpDir, "pi-web-scout.json"),
        JSON.stringify({ providers: { exa: { useApiKey: false } } })
      );

      await expect(exaDeepSearchProvider.deepSearch("public mode")).rejects.toThrow(
        "Exa deep search requires its own Exa API key"
      );
      expect(server.toolCalls).toHaveLength(0);
    });

    it("accepts a key stored in auth.json", async () => {
      enableApiKey();

      const response = await exaDeepSearchProvider.deepSearch("auth key");

      expect(response.provider).toBe("exa");
      expect(server.toolCalls).toHaveLength(1);
    });

    it("accepts a key from the EXA_API_KEY environment variable", async () => {
      process.env.EXA_API_KEY = "env-exa-api-key";

      const response = await exaDeepSearchProvider.deepSearch("env key");

      expect(response.provider).toBe("exa");
      expect(server.toolCalls).toHaveLength(1);
    });
  });

  describe("parameter mapping", () => {
    it("invokes web_search_exa with the main query and default numResults 10", async () => {
      enableApiKey();

      const response = await exaDeepSearchProvider.deepSearch("test query");

      expect(server.toolCalls).toHaveLength(1);
      expect(server.toolCalls[0].name).toBe(EXA_DEEP_SEARCH_TOOL);
      expect(server.toolCalls[0].arguments).toEqual({
        query: "test query",
        numResults: EXA_DEEP_SEARCH_DEFAULT_NUM_RESULTS,
      });
      expect(response.query).toBe("test query");
      expect(response.metadata?.numResults).toBe(10);
    });

    it("maps an explicit numResults and category to every query", async () => {
      enableApiKey();

      await exaDeepSearchProvider.deepSearch("main", {
        numResults: 5,
        category: "news",
        additionalQueries: ["extra query"],
      });

      expect(server.toolCalls).toHaveLength(2);
      for (const call of server.toolCalls) {
        expect(call.arguments).toEqual({
          query: call.arguments.query,
          numResults: 5,
          category: "news",
        });
      }
    });

    it("executes the main query and additionalQueries in parallel", async () => {
      enableApiKey();

      const response = await exaDeepSearchProvider.deepSearch("main", {
        additionalQueries: ["first extra", "second extra"],
      });

      const executed = server.toolCalls.map((call) => call.arguments.query);
      expect(executed).toEqual(["main", "first extra", "second extra"]);
      expect(response.subQueriesExecuted).toEqual([
        "main",
        "first extra",
        "second extra",
      ]);
    });

    it("falls back to the default numResults for invalid values", async () => {
      enableApiKey();

      await exaDeepSearchProvider.deepSearch("q", { numResults: 0 });

      expect(server.toolCalls[0].arguments).toEqual({
        query: "q",
        numResults: EXA_DEEP_SEARCH_DEFAULT_NUM_RESULTS,
      });
    });

    it("maps numSources to numResults when numResults is absent", async () => {
      enableApiKey();

      await exaDeepSearchProvider.deepSearch("q", { numSources: 3 });

      expect(server.toolCalls[0].arguments).toEqual({ query: "q", numResults: 3 });
    });

    it("prefers an explicit numResults over numSources", async () => {
      enableApiKey();

      await exaDeepSearchProvider.deepSearch("q", {
        numResults: 8,
        numSources: 3,
      });

      expect(server.toolCalls[0].arguments).toEqual({ query: "q", numResults: 8 });
    });

    it("includes source text by default (includeText true)", async () => {
      enableApiKey();

      const response = await exaDeepSearchProvider.deepSearch("q");

      expect(response.results[0].text).toBe("Main query content.");
      expect(response.metadata?.includeText).toBe(true);
    });

    it("strips source text from results when includeText is false", async () => {
      enableApiKey();

      const response = await exaDeepSearchProvider.deepSearch("q", {
        includeText: false,
      });

      expect(response.results).toHaveLength(1);
      expect("text" in response.results[0]).toBe(false);
      expect(response.results[0].title).toBe("Main result");
      expect(response.metadata?.includeText).toBe(false);
    });
  });

  describe("answer endpoint", () => {
    it("requires its own API key", async () => {
      await expect(
        exaDeepSearchProvider.answer!("no key answer?")
      ).rejects.toThrow("Exa answer requires its own Exa API key");
      expect(server.toolCalls).toHaveLength(0);
    });

    it("falls back to deep search synthesis when the answer tool returns no answer payload", async () => {
      enableApiKey();

      const response = await exaDeepSearchProvider.answer!("what is exa?");

      expect(server.toolCalls.map((call) => call.name)).toEqual([
        EXA_ANSWER_TOOL,
        EXA_DEEP_SEARCH_TOOL,
      ]);
      expect(server.toolCalls[0].arguments).toEqual({
        query: "what is exa?",
        numSources: EXA_DEEP_SEARCH_DEFAULT_NUM_SOURCES,
        text: true,
      });
      expect(response.provider).toBe("exa");
      expect(response.results).toHaveLength(1);
      expect(response.subQueriesExecuted).toEqual(["what is exa?"]);
      expect(response.metadata?.numSources).toBe(
        EXA_DEEP_SEARCH_DEFAULT_NUM_SOURCES
      );
    });

    it("returns the synthesized answer with citations when the answer tool responds", async () => {
      enableApiKey();
      server.contentText = JSON.stringify({
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

      expect(server.toolCalls).toHaveLength(1);
      expect(server.toolCalls[0].name).toBe(EXA_ANSWER_TOOL);
      expect(response.results).toEqual([
        { title: "Exa docs", url: "https://example.com/exa", text: "excerpt one" },
        { title: "Exa blog", url: "https://example.com/exa-2" },
      ]);
      expect(response.metadata?.answer).toBe("Exa is a search API.");
      expect(response.metadata?.numSources).toBe(
        EXA_DEEP_SEARCH_DEFAULT_NUM_SOURCES
      );
    });

    it("maps numSources and includeText to the answer tool arguments and results", async () => {
      enableApiKey();
      server.contentText = JSON.stringify({
        answer: "Short answer.",
        citations: [
          { id: "1", url: "https://example.com/a", title: "A", text: "hidden" },
        ],
      });

      const response = await exaDeepSearchProvider.answer!("q", {
        numSources: 7,
        includeText: false,
      });

      expect(server.toolCalls[0].arguments).toEqual({
        query: "q",
        numSources: 7,
        text: false,
      });
      expect(response.results).toHaveLength(1);
      expect("text" in response.results[0]).toBe(false);
      expect(response.metadata?.includeText).toBe(false);
    });

    it("rejects immediately when the signal is already aborted", async () => {
      enableApiKey();
      const controller = new AbortController();
      controller.abort();

      await expect(
        exaDeepSearchProvider.answer!("aborted", undefined, controller.signal)
      ).rejects.toThrow("Exa answer aborted before start");
      expect(server.toolCalls).toHaveLength(0);
    });
  });

  describe("retry resilience", () => {
    it("retries a transient HTTP 503 transport failure and succeeds", async () => {
      enableApiKey();
      server.failFirstHttp503 = 1;

      const response = await exaDeepSearchProvider.deepSearch("flaky query");

      expect(server.toolCalls.map((call) => call.name)).toEqual([
        EXA_DEEP_SEARCH_TOOL,
        EXA_DEEP_SEARCH_TOOL,
      ]);
      expect(response.results).toHaveLength(1);
    });

    it("fails immediately for a non-retryable HTTP 404 transport error", async () => {
      enableApiKey();
      server.failFirstHttp404 = 1;

      await expect(
        exaDeepSearchProvider.deepSearch("missing")
      ).rejects.toThrow("Streamable HTTP error");
      expect(server.toolCalls).toHaveLength(1);
    });

    it("retries a transient HTTP 503 on the answer tool before answering", async () => {
      enableApiKey();
      server.failFirstHttp503 = 1;
      server.contentText = JSON.stringify({
        answer: "Recovered answer.",
        citations: [],
      });

      const response = await exaDeepSearchProvider.answer!("flaky answer?");

      expect(server.toolCalls.map((call) => call.name)).toEqual([
        EXA_ANSWER_TOOL,
        EXA_ANSWER_TOOL,
      ]);
      expect(response.metadata?.answer).toBe("Recovered answer.");
    });
  });

  describe("buildDeepSearchQueries", () => {
    it("keeps the main query first and deduplicates additional queries", () => {
      expect(
        buildDeepSearchQueries("Main", [
          "Main",
          "  ",
          "extra",
          "EXTRA",
          "extra query",
        ])
      ).toEqual(["Main", "extra", "extra query"]);
    });

    it("returns only the main query when no additional queries are given", () => {
      expect(buildDeepSearchQueries("solo")).toEqual(["solo"]);
    });
  });

  describe("structured synthesis and normalization", () => {
    it("deduplicates results by URL across parallel queries", async () => {
      enableApiKey();
      server.resultsByQuery = {
        main: [
          {
            title: "Shared",
            url: "https://example.com/shared",
            text: "Main text",
            highlights: ["main highlight"],
          },
          {
            title: "Only main",
            url: "https://example.com/only-main",
          },
        ],
        extra: [
          {
            title: "Shared",
            url: "https://example.com/shared",
            highlights: ["extra highlight"],
          },
        ],
      };

      const response = await exaDeepSearchProvider.deepSearch("main", {
        additionalQueries: ["extra"],
      });

      expect(response.provider).toBe("exa");
      expect(response.results).toHaveLength(2);
      const shared = response.results.find(
        (item) => item.url === "https://example.com/shared"
      );
      expect(shared).toEqual({
        title: "Shared",
        url: "https://example.com/shared",
        text: "Main text",
        highlights: ["main highlight", "extra highlight"],
      });
      expect(
        response.results.find(
          (item) => item.url === "https://example.com/only-main"
        )
      ).toMatchObject({ title: "Only main" });
    });

    it("reports a sub-query failure in metadata without failing the run", async () => {
      enableApiKey();
      server.failQueries.add("broken extra");

      const response = await exaDeepSearchProvider.deepSearch("main", {
        additionalQueries: ["broken extra"],
      });

      expect(response.subQueriesExecuted).toEqual(["main"]);
      expect(response.metadata?.failedQueries).toEqual(["broken extra"]);
      expect(response.results).toHaveLength(1);
    });

    it("fails the whole deep search when the main query fails", async () => {
      enableApiKey();
      server.failQueries.add("main");

      await expect(
        exaDeepSearchProvider.deepSearch("main")
      ).rejects.toThrow('Exa deep search failed for "main"');
    });

    it("throws when a query returns no parseable results", async () => {
      enableApiKey();
      server.contentText = "not a JSON payload";

      await expect(
        exaDeepSearchProvider.deepSearch("garbage")
      ).rejects.toThrow('Exa deep search returned no parseable results for "garbage"');
    });
  });

  describe("cancellation and timeouts", () => {
    it("rejects immediately when the signal is already aborted", async () => {
      enableApiKey();
      const controller = new AbortController();
      controller.abort();

      await expect(
        exaDeepSearchProvider.deepSearch(
          "aborted",
          undefined,
          controller.signal
        )
      ).rejects.toThrow("Exa deep search aborted before start");
      expect(server.toolCalls).toHaveLength(0);
    });

    it("aborts in-flight parallel calls when the caller signal fires", async () => {
      enableApiKey();
      server.toolDelayMs = 5_000;
      const controller = new AbortController();
      const started = Date.now();
      const pending = exaDeepSearchProvider.deepSearch(
        "slow main",
        { additionalQueries: ["slow extra"] },
        controller.signal
      );
      setTimeout(() => controller.abort(), 50);

      await expect(pending).rejects.toThrow("Exa deep search aborted");
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("times out when the server does not respond", async () => {
      enableApiKey();
      process.env.EXA_DEEP_SEARCH_TIMEOUT_MS = "100";
      server.toolDelayMs = 5_000;

      await expect(exaDeepSearchProvider.deepSearch("timeout query")).rejects.toThrow(
        "Exa deep search timed out after 100ms"
      );
    });
  });

  describe("provider metadata", () => {
    it("exposes the standard DeepSearchProvider contract", () => {
      expect(exaDeepSearchProvider.id).toBe("exa");
      expect(exaDeepSearchProvider.supportsApiKey).toBe(true);
      // Deep search requires its own API key.
      expect(exaDeepSearchProvider.requiresApiKey).toBe(true);
      expect(typeof exaDeepSearchProvider.deepSearch).toBe("function");
      expect(typeof exaDeepSearchProvider.answer).toBe("function");
    });

    it("defaults to a 60s timeout, 10 results and 5 sources", () => {
      expect(EXA_DEEP_SEARCH_DEFAULT_TIMEOUT_MS).toBe(60_000);
      expect(EXA_DEEP_SEARCH_DEFAULT_NUM_RESULTS).toBe(10);
      expect(EXA_DEEP_SEARCH_DEFAULT_NUM_SOURCES).toBe(5);
    });
  });
});
