/**
 * Central provider registry for the pi-web-search-and-fetch multi-provider
 * architecture.
 *
 * The registry holds the registered `ProviderModule`s in memory and
 * allows filtering by capability (`search`, `fetch`, `deep-search`)
 * and resolving a concrete provider by id.
 *
 * Capability-aware lookups (`getSearchProvider`, `getFetchProvider`,
 * `getDeepSearchProvider`) throw descriptive errors when the requested
 * provider is unknown or does not implement the requested capability,
 * informing about the provider's actual capabilities.
 */

import type {
  DeepSearchProvider,
  FetchProvider,
  ProviderCapability,
  ProviderModule,
  SearchProvider,
} from "./types.js";

/**
 * Type guard for standard web search providers.
 *
 * Validates the required object shape: string `id`, `name` and
 * `description`, boolean `supportsApiKey` / `requiresApiKey` and a
 * callable `search` method.
 */
export function isSearchProvider(provider: unknown): provider is SearchProvider {
  if (typeof provider !== "object" || provider === null) {
    return false;
  }
  const candidate = provider as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.supportsApiKey === "boolean" &&
    typeof candidate.requiresApiKey === "boolean" &&
    typeof candidate.search === "function"
  );
}

/**
 * Type guard for page extraction/fetch providers.
 *
 * Validates the required object shape: string `id`, `name` and
 * `description`, boolean `supportsApiKey` / `requiresApiKey` and a
 * callable `fetch` method.
 */
export function isFetchProvider(provider: unknown): provider is FetchProvider {
  if (typeof provider !== "object" || provider === null) {
    return false;
  }
  const candidate = provider as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.supportsApiKey === "boolean" &&
    typeof candidate.requiresApiKey === "boolean" &&
    typeof candidate.fetch === "function"
  );
}

/**
 * Type guard for deep / multi-query research providers.
 *
 * Validates the required object shape: string `id`, `name` and
 * `description`, boolean `supportsApiKey` / `requiresApiKey` and a
 * callable `deepSearch` method.
 */
export function isDeepSearchProvider(
  provider: unknown
): provider is DeepSearchProvider {
  if (typeof provider !== "object" || provider === null) {
    return false;
  }
  const candidate = provider as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.supportsApiKey === "boolean" &&
    typeof candidate.requiresApiKey === "boolean" &&
    typeof candidate.deepSearch === "function"
  );
}

/**
 * In-memory registry of provider modules.
 */
export class ProviderRegistry {
  /** Registered modules keyed by provider id. */
  private readonly modules = new Map<string, ProviderModule>();

  /**
   * Registers a provider module in memory. Re-registering an existing
   * provider id replaces the previous module.
   */
  registerProvider(module: ProviderModule): void {
    this.modules.set(module.id, module);
  }

  /** Returns all registered provider modules. */
  getAllProviders(): ProviderModule[] {
    return [...this.modules.values()];
  }

  /** Returns the provider module with the given id, or undefined. */
  getProvider(id: string): ProviderModule | undefined {
    return this.modules.get(id);
  }

  /** Returns the search providers (modules implementing "search"). */
  getSearchProviders(): SearchProvider[] {
    return this.getProvidersByCapability("search")
      .map((module) => module.searchProvider)
      .filter(isSearchProvider);
  }

  /** Returns the fetch providers (modules implementing "fetch"). */
  getFetchProviders(): FetchProvider[] {
    return this.getProvidersByCapability("fetch")
      .map((module) => module.fetchProvider)
      .filter(isFetchProvider);
  }

  /** Returns the deep-search providers (modules implementing "deep-search"). */
  getDeepSearchProviders(): DeepSearchProvider[] {
    return this.getProvidersByCapability("deep-search")
      .map((module) => module.deepSearchProvider)
      .filter(isDeepSearchProvider);
  }

  /**
   * Returns the search provider with the given id.
   *
   * @throws Error when the provider is unknown or does not implement
   * the "search" capability.
   */
  getSearchProvider(id: string): SearchProvider {
    return this.getProviderByCapability(id, "search", isSearchProvider);
  }

  /**
   * Returns the fetch provider with the given id.
   *
   * @throws Error when the provider is unknown or does not implement
   * the "fetch" capability.
   */
  getFetchProvider(id: string): FetchProvider {
    return this.getProviderByCapability(id, "fetch", isFetchProvider);
  }

  /**
   * Returns the deep-search provider with the given id.
   *
   * @throws Error when the provider is unknown or does not implement
   * the "deep-search" capability.
   */
  getDeepSearchProvider(id: string): DeepSearchProvider {
    return this.getProviderByCapability(id, "deep-search", isDeepSearchProvider);
  }

  /**
   * Returns the modules that declare the given capability and expose a
   * concrete implementation for it.
   */
  private getProvidersByCapability(capability: ProviderCapability): ProviderModule[] {
    return this.getAllProviders().filter(
      (module) =>
        module.capabilities.includes(capability) &&
        this.getCapabilityImplementation(module, capability) !== undefined
    );
  }

  /**
   * Resolves a module by id and validates that it implements the given
   * capability, throwing a descriptive error otherwise.
   *
   * The capability implementation is verified with the given type guard,
   * so a missing or malformed implementation is rejected with the same
   * descriptive error.
   */
  private getProviderByCapability<T>(
    id: string,
    capability: ProviderCapability,
    guard: (candidate: unknown) => candidate is T
  ): T {
    const module = this.modules.get(id);

    if (module === undefined) {
      const known = this.getAllProviders()
        .map((m) => m.id)
        .join(", ");
      throw new Error(
        `Unknown provider "${id}" for capability "${capability}". ` +
          (known.length > 0
            ? `Registered providers: ${known}.`
            : "No providers are registered.")
      );
    }

    const implementation = this.getCapabilityImplementation(module, capability);
    if (!guard(implementation)) {
      throw new Error(
        `Provider "${id}" does not support the "${capability}" capability. ` +
          `Supported capabilities: ${module.capabilities.join(", ") || "(none)"}.`
      );
    }

    return implementation;
  }

  /** Returns the concrete provider implementation for a capability, or undefined. */
  private getCapabilityImplementation(
    module: ProviderModule,
    capability: ProviderCapability
  ): SearchProvider | FetchProvider | DeepSearchProvider | undefined {
    switch (capability) {
      case "search":
        return module.searchProvider;
      case "fetch":
        return module.fetchProvider;
      case "deep-search":
        return module.deepSearchProvider;
    }
  }
}
