import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeExaClient } from "../src/providers/exa/client.js";
import {
  EXA_SEARCH_DEFAULT_NUM_RESULTS,
  EXA_SEARCH_TOOL,
  EXA_SEARCH_ADVANCED_TOOL,
  buildSearchToolInvocation,
  extractRawResults,
  parseTextSearchResults,
  exaSearchProvider,
} from "../src/providers/exa/search.js";

describe("src/providers/exa/search (live Exa MCP)", () => {
  let tmpDir: string;
  let prevAgentDir: string | undefined;
  let prevTimeout: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-exa-search-test-"));
    prevAgentDir = process.env.PI_AGENT_DIR;
    process.env.PI_AGENT_DIR = tmpDir;
    prevTimeout = process.env.EXA_SEARCH_TIMEOUT_MS;
    delete process.env.EXA_MCP_ENDPOINT;
    delete process.env.EXA_API_KEY;
  });

  afterEach(async () => {
    await closeExaClient();
    if (prevAgentDir !== undefined) {
      process.env.PI_AGENT_DIR = prevAgentDir;
    } else {
      delete process.env.PI_AGENT_DIR;
    }
    if (prevTimeout !== undefined) {
      process.env.EXA_SEARCH_TIMEOUT_MS = prevTimeout;
    } else {
      delete process.env.EXA_SEARCH_TIMEOUT_MS;
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
      expect(exaSearchProvider.id).toBe("exa");
      expect(exaSearchProvider.name).toBe("Exa");
      expect(exaSearchProvider.supportsApiKey).toBe(true);
      expect(exaSearchProvider.requiresApiKey).toBe(false);
      expect(typeof exaSearchProvider.description).toBe("string");
    });
  });

  describe("tool invocation builder", () => {
    it("selects web_search_exa for simple queries", () => {
      const { toolName, arguments: args } = buildSearchToolInvocation(
        "vitest",
        { numResults: 5 }
      );
      expect(toolName).toBe(EXA_SEARCH_TOOL);
      expect(args).toEqual({
        query: "vitest",
        numResults: 5,
      });
    });

    it("selects web_search_advanced_exa when advanced filters are present", () => {
      const { toolName, arguments: args } = buildSearchToolInvocation(
        "vitest",
        {
          category: "news",
          includeDomains: ["github.com"],
          excludeDomains: ["reddit.com"],
          startPublishedDate: "2025-01-01",
          endPublishedDate: "2025-12-31",
        }
      );
      expect(toolName).toBe(EXA_SEARCH_ADVANCED_TOOL);
      expect(args).toEqual({
        query: "vitest",
        numResults: EXA_SEARCH_DEFAULT_NUM_RESULTS,
        category: "news",
        includeDomains: ["github.com"],
        excludeDomains: ["reddit.com"],
        startPublishedDate: "2025-01-01",
        endPublishedDate: "2025-12-31",
      });
    });
  });

  describe("live Exa MCP search", () => {
    it("executes a search against live Exa MCP and normalizes results", async () => {
      const response = await exaSearchProvider.search(
        "vitest testing framework",
        { numResults: 3 }
      );

      expect(response.provider).toBe("exa");
      expect(response.query).toBe("vitest testing framework");
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results.length).toBeLessThanOrEqual(3);

      const first = response.results[0];
      expect(first.title).toBeDefined();
      expect(first.url).toMatch(/^https?:\/\//);
      expect(typeof first.snippet).toBe("string");
    }, 20_000);

    it("executes an advanced category search against live Exa MCP", async () => {
      const response = await exaSearchProvider.search("typescript compiler", {
        numResults: 2,
        category: "github",
      });

      expect(response.provider).toBe("exa");
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.metadata?.category).toBe("github");
    }, 20_000);

    it("executes a domain-filtered search against live Exa MCP", async () => {
      const response = await exaSearchProvider.search("vitest", {
        numResults: 2,
        includeDomains: ["github.com"],
      });

      expect(response.provider).toBe("exa");
      expect(response.results.length).toBeGreaterThan(0);
      for (const item of response.results) {
        expect(item.url).toContain("github.com");
      }
    }, 20_000);

    it("dispatches transparently to findSimilar when similarUrl is provided", async () => {
      const response = await exaSearchProvider.search("ignored query", {
        similarUrl: "https://vitest.dev",
        numResults: 2,
      });

      expect(response.provider).toBe("exa");
      expect(response.query).toBe("https://vitest.dev");
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.metadata?.similarUrl).toBe("https://vitest.dev");
    }, 20_000);
  });

  describe("result parsing", () => {
    it("parses text/markdown search blocks separated by ---", () => {
      const sampleText = `Title: Vitest Guide
URL: https://vitest.dev/guide
Published: 2026-01-01
Author: Vitest Team
Highlights:
Next generation testing framework

---

Title: Vitest GitHub
URL: https://github.com/vitest-dev/vitest
Highlights:
Source code for vitest`;

      const results = parseTextSearchResults(sampleText);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        title: "Vitest Guide",
        url: "https://vitest.dev/guide",
        publishedDate: "2026-01-01",
        author: "Vitest Team",
        text: "Next generation testing framework",
      });
      expect(results[1]).toEqual({
        title: "Vitest GitHub",
        url: "https://github.com/vitest-dev/vitest",
        publishedDate: undefined,
        author: undefined,
        text: "Source code for vitest",
      });
    });

    it("extractRawResults parses JSON arrays as well as text", () => {
      const jsonResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              results: [
                {
                  title: "JSON result",
                  url: "https://example.com",
                  text: "Snippet",
                },
              ],
            }),
          },
        ],
      };
      const parsed = extractRawResults(jsonResult as any);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].title).toBe("JSON result");
    });

    it("throws a descriptive error when the tool reports isError", () => {
      const errResult = {
        content: [{ type: "text", text: "Rate limit exceeded" }],
        isError: true,
      };
      expect(() => extractRawResults(errResult as any)).toThrow(
        "Exa search failed: Rate limit exceeded"
      );
    });
  });

  describe("cancellation and timeouts", () => {
    it("rejects immediately when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        exaSearchProvider.search("aborted", undefined, controller.signal)
      ).rejects.toThrow("Exa search aborted before start");
    });

    it("aborts an in-flight call when the caller signal fires", async () => {
      const controller = new AbortController();
      const pending = exaSearchProvider.search(
        "slow query that will abort",
        undefined,
        controller.signal
      );
      // Abort shortly after initiation
      setTimeout(() => controller.abort(), 10);

      await expect(pending).rejects.toThrow(/abort/i);
    });

    it("times out when request timeout expires", async () => {
      process.env.EXA_SEARCH_TIMEOUT_MS = "1";

      await expect(
        exaSearchProvider.search("timeout query")
      ).rejects.toThrow(/timed out after 1ms/);
    });
  });
});
