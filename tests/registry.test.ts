import { describe, expect, it } from "vitest";
import {
  isDeepSearchProvider,
  isFetchProvider,
  isSearchProvider,
  ProviderRegistry,
} from "../src/providers/registry.js";
import type {
  DeepSearchProvider,
  FetchProvider,
  FetchResponse,
  ProviderModule,
  SearchProvider,
} from "../src/providers/types.js";

/** Builds a minimal search provider for tests. */
function makeSearchProvider(id: string): SearchProvider {
  return {
    id,
    name: `${id} search`,
    description: "test search provider",
    supportsApiKey: false,
    requiresApiKey: false,
    search: async (query) => ({ query, results: [], provider: id }),
  };
}

/** Builds a minimal fetch provider for tests. */
function makeFetchProvider(id: string): FetchProvider {
  return {
    id,
    name: `${id} fetch`,
    description: "test fetch provider",
    supportsApiKey: false,
    requiresApiKey: false,
    fetch: async (url: string) => ({ url, content: "", provider: id }),
  };
}

/** Builds a minimal deep-search provider for tests. */
function makeDeepSearchProvider(id: string): DeepSearchProvider {
  return {
    id,
    name: `${id} deep-search`,
    description: "test deep-search provider",
    supportsApiKey: true,
    requiresApiKey: true,
    deepSearch: async (query) => ({ query, results: [], provider: id }),
  };
}

/** Builds a triple-capability provider module for tests. */
function makeTripleModule(id: string): ProviderModule {
  return {
    id,
    name: id,
    description: `test module ${id}`,
    capabilities: ["search", "fetch", "deep-search"],
    searchProvider: makeSearchProvider(id),
    fetchProvider: makeFetchProvider(id),
    deepSearchProvider: makeDeepSearchProvider(id),
  };
}

describe("src/providers/registry", () => {
  it("registers providers and returns them via getAllProviders", () => {
    const registry = new ProviderRegistry();
    const exa = makeTripleModule("exa");
    const brave: ProviderModule = {
      id: "brave",
      name: "Brave",
      description: "search only",
      capabilities: ["search"],
      searchProvider: makeSearchProvider("brave"),
    };

    registry.registerProvider(exa);
    registry.registerProvider(brave);

    expect(registry.getAllProviders()).toHaveLength(2);
    expect(registry.getAllProviders().map((m) => m.id)).toEqual(["exa", "brave"]);
  });

  it("replaces a provider when re-registering the same id", () => {
    const registry = new ProviderRegistry();
    const first = makeTripleModule("exa");
    const second: ProviderModule = {
      ...first,
      description: "updated",
    };

    registry.registerProvider(first);
    registry.registerProvider(second);

    expect(registry.getAllProviders()).toHaveLength(1);
    expect(registry.getProvider("exa")?.description).toBe("updated");
  });

  it("returns the module for a known id and undefined otherwise", () => {
    const registry = new ProviderRegistry();
    const exa = makeTripleModule("exa");
    registry.registerProvider(exa);

    expect(registry.getProvider("exa")).toBe(exa);
    expect(registry.getProvider("missing")).toBeUndefined();
  });

  it("filters search providers by capability", () => {
    const registry = new ProviderRegistry();
    const exa = makeTripleModule("exa");
    const jina: ProviderModule = {
      id: "jina",
      name: "Jina",
      description: "fetch only",
      capabilities: ["fetch"],
      fetchProvider: makeFetchProvider("jina"),
    };

    registry.registerProvider(exa);
    registry.registerProvider(jina);

    const searchProviders = registry.getSearchProviders();
    expect(searchProviders).toHaveLength(1);
    expect(searchProviders[0].id).toBe("exa");
  });

  it("filters fetch providers by capability", () => {
    const registry = new ProviderRegistry();
    const jina: ProviderModule = {
      id: "jina",
      name: "Jina",
      description: "fetch only",
      capabilities: ["fetch"],
      fetchProvider: makeFetchProvider("jina"),
    };
    const brave: ProviderModule = {
      id: "brave",
      name: "Brave",
      description: "search only",
      capabilities: ["search"],
      searchProvider: makeSearchProvider("brave"),
    };

    registry.registerProvider(jina);
    registry.registerProvider(brave);

    const fetchProviders = registry.getFetchProviders();
    expect(fetchProviders).toHaveLength(1);
    expect(fetchProviders[0].id).toBe("jina");
  });

  it("filters deep-search providers by capability", () => {
    const registry = new ProviderRegistry();
    const exa = makeTripleModule("exa");
    const brave: ProviderModule = {
      id: "brave",
      name: "Brave",
      description: "search only",
      capabilities: ["search"],
      searchProvider: makeSearchProvider("brave"),
    };

    registry.registerProvider(exa);
    registry.registerProvider(brave);

    const deepSearchProviders = registry.getDeepSearchProviders();
    expect(deepSearchProviders).toHaveLength(1);
    expect(deepSearchProviders[0].id).toBe("exa");
  });

  it("returns empty lists when no providers are registered", () => {
    const registry = new ProviderRegistry();

    expect(registry.getAllProviders()).toEqual([]);
    expect(registry.getSearchProviders()).toEqual([]);
    expect(registry.getFetchProviders()).toEqual([]);
    expect(registry.getDeepSearchProviders()).toEqual([]);
  });

  it("resolves a search provider by id", async () => {
    const registry = new ProviderRegistry();
    registry.registerProvider(makeTripleModule("exa"));

    const provider = registry.getSearchProvider("exa");
    expect(provider.id).toBe("exa");

    const response = await provider.search("test query");
    expect(response.provider).toBe("exa");
  });

  it("resolves a fetch provider by id", async () => {
    const registry = new ProviderRegistry();
    registry.registerProvider(makeTripleModule("exa"));

    const provider = registry.getFetchProvider("exa");
    expect(provider.id).toBe("exa");

    const response = (await provider.fetch(
      "https://example.com"
    )) as FetchResponse;
    expect(response.url).toBe("https://example.com");
  });

  it("resolves a deep-search provider by id", async () => {
    const registry = new ProviderRegistry();
    registry.registerProvider(makeTripleModule("exa"));

    const provider = registry.getDeepSearchProvider("exa");
    expect(provider.id).toBe("exa");

    const response = await provider.deepSearch("deep query");
    expect(response.provider).toBe("exa");
  });

  it("throws a descriptive error for an unknown provider", () => {
    const registry = new ProviderRegistry();
    registry.registerProvider(makeTripleModule("exa"));

    expect(() => registry.getSearchProvider("missing")).toThrow(
      /Unknown provider "missing" for capability "search"/
    );
    expect(() => registry.getSearchProvider("missing")).toThrow(/exa/);
  });

  it("throws a descriptive error for an unknown provider when registry is empty", () => {
    const registry = new ProviderRegistry();

    expect(() => registry.getFetchProvider("missing")).toThrow(
      /Unknown provider "missing" for capability "fetch"/
    );
    expect(() => registry.getFetchProvider("missing")).toThrow(
      /No providers are registered/
    );
  });

  it("throws a descriptive error when the provider does not support the capability", () => {
    const registry = new ProviderRegistry();
    const brave: ProviderModule = {
      id: "brave",
      name: "Brave",
      description: "search only",
      capabilities: ["search"],
      searchProvider: makeSearchProvider("brave"),
    };
    registry.registerProvider(brave);

    expect(() => registry.getFetchProvider("brave")).toThrow(
      /Provider "brave" does not support the "fetch" capability/
    );
    expect(() => registry.getFetchProvider("brave")).toThrow(
      /Supported capabilities: search/
    );
    expect(() => registry.getDeepSearchProvider("brave")).toThrow(
      /does not support the "deep-search" capability/
    );
  });

  it("throws a descriptive error when provider has empty capabilities list", () => {
    const registry = new ProviderRegistry();
    const emptyProvider: ProviderModule = {
      id: "empty",
      name: "Empty",
      description: "no capabilities",
      capabilities: [],
    };
    registry.registerProvider(emptyProvider);

    expect(() => registry.getSearchProvider("empty")).toThrow(
      /Provider "empty" does not support the "search" capability\. Supported capabilities: \(none\)\./
    );
  });

  it("throws when a module declares a capability without an implementation", () => {
    const registry = new ProviderRegistry();
    const broken: ProviderModule = {
      id: "broken",
      name: "Broken",
      description: "declares search but has no implementation",
      capabilities: ["search"],
    };
    registry.registerProvider(broken);

    expect(() => registry.getSearchProvider("broken")).toThrow(
      /does not support the "search" capability/
    );
    expect(registry.getSearchProviders()).toEqual([]);
  });

  it("rejects a malformed provider implementation via the type guard", () => {
    const registry = new ProviderRegistry();
    const broken = {
      id: "broken",
      name: "Broken",
      description: "declares search but the implementation is malformed",
      capabilities: ["search"],
      searchProvider: {
        id: "broken",
        name: "Broken",
        description: "malformed search implementation",
        supportsApiKey: "yes",
        requiresApiKey: false,
        search: "not a function",
      },
    } as unknown as ProviderModule;
    registry.registerProvider(broken);

    expect(() => registry.getSearchProvider("broken")).toThrow(
      /Provider "broken" does not support the "search" capability\./
    );
    expect(registry.getSearchProviders()).toEqual([]);
  });

  it("registry source contains no unsafe `as any` assertions", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const source = await readFile(
      fileURLToPath(new URL("../src/providers/registry.ts", import.meta.url)),
      "utf8"
    );
    expect(source).not.toContain("as any");
  });
});

describe("provider type guards", () => {
  const validSearch = makeSearchProvider("exa");
  const validFetch = makeFetchProvider("exa");
  const validDeep = makeDeepSearchProvider("exa");

  it("isSearchProvider accepts a valid search provider", () => {
    expect(isSearchProvider(validSearch)).toBe(true);
  });

  it("isSearchProvider rejects null, undefined and primitives", () => {
    expect(isSearchProvider(null)).toBe(false);
    expect(isSearchProvider(undefined)).toBe(false);
    expect(isSearchProvider("search")).toBe(false);
    expect(isSearchProvider(42)).toBe(false);
    expect(isSearchProvider(true)).toBe(false);
    expect(isSearchProvider([])).toBe(false);
  });

  it("isSearchProvider rejects an object missing the search method", () => {
    const { search, ...rest } = validSearch;
    expect(isSearchProvider(rest)).toBe(false);
  });

  it("isSearchProvider rejects wrong property types", () => {
    expect(isSearchProvider({ ...validSearch, id: 1 })).toBe(false);
    expect(isSearchProvider({ ...validSearch, name: 0 })).toBe(false);
    expect(isSearchProvider({ ...validSearch, description: null })).toBe(false);
    expect(isSearchProvider({ ...validSearch, supportsApiKey: "yes" })).toBe(false);
    expect(isSearchProvider({ ...validSearch, requiresApiKey: "no" })).toBe(false);
    expect(isSearchProvider({ ...validSearch, search: "not a function" })).toBe(false);
    expect(isSearchProvider({})).toBe(false);
  });

  it("isSearchProvider does not accept fetch or deep-search providers", () => {
    expect(isSearchProvider(validFetch)).toBe(false);
    expect(isSearchProvider(validDeep)).toBe(false);
  });

  it("isFetchProvider accepts a valid fetch provider", () => {
    expect(isFetchProvider(validFetch)).toBe(true);
  });

  it("isFetchProvider rejects null, undefined and primitives", () => {
    expect(isFetchProvider(null)).toBe(false);
    expect(isFetchProvider(undefined)).toBe(false);
    expect(isFetchProvider("fetch")).toBe(false);
    expect(isFetchProvider(42)).toBe(false);
    expect(isFetchProvider(false)).toBe(false);
    expect(isFetchProvider([])).toBe(false);
  });

  it("isFetchProvider rejects an object missing the fetch method", () => {
    const { fetch, ...rest } = validFetch;
    expect(isFetchProvider(rest)).toBe(false);
  });

  it("isFetchProvider rejects wrong property types", () => {
    expect(isFetchProvider({ ...validFetch, id: 1 })).toBe(false);
    expect(isFetchProvider({ ...validFetch, name: 0 })).toBe(false);
    expect(isFetchProvider({ ...validFetch, description: null })).toBe(false);
    expect(isFetchProvider({ ...validFetch, supportsApiKey: "yes" })).toBe(false);
    expect(isFetchProvider({ ...validFetch, requiresApiKey: "no" })).toBe(false);
    expect(isFetchProvider({ ...validFetch, fetch: "not a function" })).toBe(false);
    expect(isFetchProvider({})).toBe(false);
  });

  it("isFetchProvider does not accept search or deep-search providers", () => {
    expect(isFetchProvider(validSearch)).toBe(false);
    expect(isFetchProvider(validDeep)).toBe(false);
  });

  it("isDeepSearchProvider accepts a valid deep-search provider", () => {
    expect(isDeepSearchProvider(validDeep)).toBe(true);
  });

  it("isDeepSearchProvider rejects null, undefined and primitives", () => {
    expect(isDeepSearchProvider(null)).toBe(false);
    expect(isDeepSearchProvider(undefined)).toBe(false);
    expect(isDeepSearchProvider("deep-search")).toBe(false);
    expect(isDeepSearchProvider(42)).toBe(false);
    expect(isDeepSearchProvider(false)).toBe(false);
    expect(isDeepSearchProvider([])).toBe(false);
  });

  it("isDeepSearchProvider rejects an object missing the deepSearch method", () => {
    const { deepSearch, ...rest } = validDeep;
    expect(isDeepSearchProvider(rest)).toBe(false);
  });

  it("isDeepSearchProvider rejects wrong property types", () => {
    expect(isDeepSearchProvider({ ...validDeep, id: 1 })).toBe(false);
    expect(isDeepSearchProvider({ ...validDeep, name: 0 })).toBe(false);
    expect(isDeepSearchProvider({ ...validDeep, description: null })).toBe(false);
    expect(isDeepSearchProvider({ ...validDeep, supportsApiKey: "yes" })).toBe(false);
    expect(isDeepSearchProvider({ ...validDeep, requiresApiKey: "no" })).toBe(false);
    expect(
      isDeepSearchProvider({ ...validDeep, deepSearch: "not a function" })
    ).toBe(false);
    expect(isDeepSearchProvider({})).toBe(false);
  });

  it("isDeepSearchProvider does not accept search or fetch providers", () => {
    expect(isDeepSearchProvider(validSearch)).toBe(false);
    expect(isDeepSearchProvider(validFetch)).toBe(false);
  });
});
