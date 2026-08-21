import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import {
  closeExaClient,
  EXA_DEEP_SEARCH_TOOL,
  EXA_FETCH_TOOL,
  EXA_SEARCH_TOOL,
  exaDeepSearchProvider,
  exaFetchProvider,
  exaProviderModule,
  exaSearchProvider,
  getExaClient,
} from "../src/providers/exa/index.js";

describe("src/providers/exa/index", () => {
  it("exports a ProviderModule with id and name 'exa'/'Exa'", () => {
    expect(exaProviderModule.id).toBe("exa");
    expect(exaProviderModule.name).toBe("Exa");
    expect(exaProviderModule.description.length).toBeGreaterThan(0);
  });

  it("declares the triple capability ['search', 'fetch', 'deep-search']", () => {
    expect(exaProviderModule.capabilities).toEqual([
      "search",
      "fetch",
      "deep-search",
    ]);
  });

  it("links each declared capability to its concrete implementation", () => {
    expect(exaProviderModule.searchProvider).toBe(exaSearchProvider);
    expect(exaProviderModule.fetchProvider).toBe(exaFetchProvider);
    expect(exaProviderModule.deepSearchProvider).toBe(exaDeepSearchProvider);
  });

  it("links implementations that identify as the 'exa' provider", () => {
    expect(exaProviderModule.searchProvider?.id).toBe("exa");
    expect(exaProviderModule.fetchProvider?.id).toBe("exa");
    expect(
      exaProviderModule.deepSearchProvider?.id
    ).toBe("exa");
  });

  it("keeps capabilities and linked implementations consistent", () => {
    expect(exaProviderModule.capabilities.includes("search")).toBe(
      exaProviderModule.searchProvider !== undefined
    );
    expect(exaProviderModule.capabilities.includes("fetch")).toBe(
      exaProviderModule.fetchProvider !== undefined
    );
    expect(exaProviderModule.capabilities.includes("deep-search")).toBe(
      exaProviderModule.deepSearchProvider !== undefined
    );
  });

  it("registers in the ProviderRegistry and resolves via capability lookups", () => {
    const registry = new ProviderRegistry();
    registry.registerProvider(exaProviderModule);

    expect(registry.getProvider("exa")).toBe(exaProviderModule);
    expect(registry.getSearchProvider("exa")).toBe(exaSearchProvider);
    expect(registry.getFetchProvider("exa")).toBe(exaFetchProvider);
    expect(registry.getDeepSearchProvider("exa")).toBe(exaDeepSearchProvider);
    expect(registry.getSearchProviders().map((p) => p.id)).toContain("exa");
    expect(registry.getFetchProviders().map((p) => p.id)).toContain("exa");
    expect(
      registry.getDeepSearchProviders().map((p) => p.id)
    ).toContain("exa");
  });

  it("re-exports the shared MCP client lifecycle helpers", () => {
    expect(typeof getExaClient).toBe("function");
    expect(typeof closeExaClient).toBe("function");
  });

  it("re-exports the Exa MCP tool names used by the implementations", () => {
    expect(EXA_SEARCH_TOOL).toBe("web_search_exa");
    expect(EXA_FETCH_TOOL).toBe("web_fetch_exa");
    expect(EXA_DEEP_SEARCH_TOOL).toBe("web_search_exa");
  });

  it("implements the configure method for interactive TUI settings", () => {
    expect(typeof exaProviderModule.configure).toBe("function");
  });
});
