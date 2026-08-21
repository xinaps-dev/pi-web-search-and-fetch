import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeExaClient } from "../src/providers/exa/client.js";
import {
  EXA_FETCH_DEFAULT_MAX_CHARACTERS,
  EXA_FETCH_TOOL,
  exaFetchProvider,
  extractRawFetch,
  normalizeFetchUrl,
  parseTextFetch,
} from "../src/providers/exa/fetch.js";
import type { FetchResponse } from "../src/providers/types.js";

describe("src/providers/exa/fetch (live Exa MCP)", () => {
  let tmpDir: string;
  let prevAgentDir: string | undefined;
  let prevTimeout: string | undefined;
  let server: http.Server;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-exa-fetch-test-"));
    prevAgentDir = process.env.PI_AGENT_DIR;
    process.env.PI_AGENT_DIR = tmpDir;
    prevTimeout = process.env.EXA_FETCH_TIMEOUT_MS;
    delete process.env.EXA_MCP_ENDPOINT;
    delete process.env.EXA_API_KEY;

    server = http.createServer((req, res) => {
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
          let message: any;
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
            const args = message.params?.arguments || {};
            const urlsStr = JSON.stringify(args);
            if (urlsStr.includes("thisdomaindoesnotexistatall123456789.com")) {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    content: [{ type: "text", text: "Failed to fetch: domain not found" }],
                    isError: true,
                  },
                })
              );
              return;
            }
            const targetUrl = (Array.isArray(args.urls) ? args.urls[0] : args.url) || "https://example.com";
            let content = "# Example Domain\n\nThis is example domain content markdown.";
            if (typeof args.maxCharacters === "number") {
              content = content.slice(0, args.maxCharacters);
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
                      text: JSON.stringify({
                        url: targetUrl,
                        title: "Example Domain",
                        content,
                      }),
                    },
                  ],
                },
              })
            );
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        });
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as any;
    process.env.EXA_MCP_ENDPOINT = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterEach(async () => {
    await closeExaClient();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (prevAgentDir !== undefined) {
      process.env.PI_AGENT_DIR = prevAgentDir;
    } else {
      delete process.env.PI_AGENT_DIR;
    }
    if (prevTimeout !== undefined) {
      process.env.EXA_FETCH_TIMEOUT_MS = prevTimeout;
    } else {
      delete process.env.EXA_FETCH_TIMEOUT_MS;
    }
    delete process.env.EXA_MCP_ENDPOINT;
    delete process.env.EXA_API_KEY;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  });

  describe("provider identity", () => {
    it("reports standard provider metadata", () => {
      expect(exaFetchProvider.id).toBe("exa");
      expect(exaFetchProvider.name).toBe("Exa");
      expect(exaFetchProvider.supportsApiKey).toBe(true);
      expect(exaFetchProvider.requiresApiKey).toBe(false);
      expect(typeof exaFetchProvider.description).toBe("string");
    });
  });

  describe("URL validation and normalization", () => {
    it("upgrades HTTP URLs to HTTPS", () => {
      expect(normalizeFetchUrl("http://example.com/page")).toBe(
        "https://example.com/page"
      );
    });

    it("keeps HTTPS URLs intact", () => {
      expect(normalizeFetchUrl("https://example.com/secure")).toBe(
        "https://example.com/secure"
      );
    });

    it("throws a descriptive error for non-HTTP(S) protocols", () => {
      expect(() => normalizeFetchUrl("ftp://example.com/file")).toThrow(
        'Exa fetch requires an http(s) URL, got: "ftp://example.com/file"'
      );
      expect(() => normalizeFetchUrl("file:///tmp/doc.txt")).toThrow(
        'Exa fetch requires an http(s) URL, got: "file:///tmp/doc.txt"'
      );
    });

    it("throws a descriptive error for malformed URLs", () => {
      expect(() => normalizeFetchUrl("not-a-url")).toThrow(
        'Exa fetch requires a fully-formed http(s) URL, got: "not-a-url"'
      );
    });
  });

  describe("live Exa MCP fetch", () => {
    it("fetches a single URL and normalizes markdown content", async () => {
      const response = (await exaFetchProvider.fetch(
        "https://example.com"
      )) as FetchResponse;

      expect(response.provider).toBe("exa");
      expect(response.url).toBe("https://example.com");
      expect(response.content.toLowerCase()).toContain("example domain");
    }, 20_000);

    it("respects maxCharacters truncation", async () => {
      const response = (await exaFetchProvider.fetch("https://example.com", {
        maxCharacters: 50,
      })) as FetchResponse;

      expect(response.provider).toBe("exa");
      expect(response.content.length).toBeLessThanOrEqual(60);
    }, 20_000);

    it("fetches multiple URLs concurrently in batch mode", async () => {
      const responses = (await exaFetchProvider.fetch([
        "https://example.com",
        "https://httpbin.org/get",
      ])) as FetchResponse[];

      expect(Array.isArray(responses)).toBe(true);
      expect(responses).toHaveLength(2);
      expect(responses[0].url).toBe("https://example.com");
      expect(responses[1].url).toBe("https://httpbin.org/get");
    }, 25_000);

    it("handles empty array batch gracefully", async () => {
      const responses = await exaFetchProvider.fetch([]);
      expect(responses).toEqual([]);
    });

    it("maps a failed URL in a batch to a fallback FetchResponse without failing the batch", async () => {
      const responses = (await exaFetchProvider.fetch([
        "https://example.com",
        "https://thisdomaindoesnotexistatall123456789.com",
      ])) as FetchResponse[];

      expect(responses).toHaveLength(2);
      expect(responses[0].url).toBe("https://example.com");
      expect(responses[0].title).not.toBe("Error");

      expect(responses[1].url).toBe(
        "https://thisdomaindoesnotexistatall123456789.com"
      );
      expect(responses[1].title).toBe("Error");
      expect(responses[1].content).toContain("Failed to fetch");
    }, 25_000);
  });

  describe("result parsing", () => {
    it("parses text/markdown format from Exa MCP", () => {
      const sample = `# Sample Title\nURL: https://example.com/page\n\nThis is the markdown body.`;
      const parsed = parseTextFetch(sample, "https://example.com/page");
      expect(parsed).toEqual({
        url: "https://example.com/page",
        title: "Sample Title",
        content: "This is the markdown body.",
      });
    });

    it("extractRawFetch parses JSON payloads", () => {
      const jsonResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: "https://example.com",
              title: "JSON Title",
              content: "JSON body",
            }),
          },
        ],
      };
      const parsed = extractRawFetch(jsonResult as any, "https://example.com");
      expect(parsed).toEqual({
        url: "https://example.com",
        title: "JSON Title",
        content: "JSON body",
      });
    });

    it("throws when tool reports isError", () => {
      const errResult = {
        content: [{ type: "text", text: "Fetch failed: 404 Not Found" }],
        isError: true,
      };
      expect(() =>
        extractRawFetch(errResult as any, "https://example.com")
      ).toThrow("Exa fetch failed: Fetch failed: 404 Not Found");
    });
  });

  describe("cancellation and timeouts", () => {
    it("rejects immediately when caller signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        exaFetchProvider.fetch("https://example.com", undefined, controller.signal)
      ).rejects.toThrow("Exa fetch aborted before start");
    });

    it("times out when timeout expires", async () => {
      process.env.EXA_FETCH_TIMEOUT_MS = "1";

      await expect(
        exaFetchProvider.fetch("https://example.com")
      ).rejects.toThrow(/timed out after 1ms/);
    });
  });
});
