import { describe, expect, expectTypeOf, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/constants.js";
import type {
  ExaProviderConfig,
  PiWebSearchAndFetchConfig,
  ProvidersConfig,
  WsToolConfig,
} from "../src/config/types.js";

describe("src/config/types", () => {
  it("types the default config as PiWebSearchAndFetchConfig", () => {
    const config: PiWebSearchAndFetchConfig = DEFAULT_CONFIG;
    expect(config.search).toEqual({ enabled: true, provider: "exa" });
    expect(config.fetch).toEqual({ enabled: true, provider: "exa" });
    expect(config.deepSearch).toEqual({ enabled: false, provider: "exa" });
    expect(config.providers).toEqual({ exa: { useApiKey: true } });
  });

  it("describes the expected JSON structure", () => {
    const raw = {
      search: { enabled: true, provider: "exa" },
      fetch: { enabled: true, provider: "exa" },
      deepSearch: { enabled: false, provider: "exa" },
      providers: { exa: { useApiKey: true } },
    };
    const config: PiWebSearchAndFetchConfig = raw;
    expect(config.search.enabled).toBe(true);
    expect(config.fetch.provider).toBe("exa");
    expect(config.deepSearch.enabled).toBe(false);
    expect(config.providers.exa.useApiKey).toBe(true);
  });

  it("describes a per-tool config section", () => {
    const tool: WsToolConfig = { enabled: false, provider: "exa" };
    expect(tool.enabled).toBe(false);
    expect(tool.provider).toBe("exa");
  });

  it("describes the Exa provider options", () => {
    const exa: ExaProviderConfig = { useApiKey: false };
    expect(exa.useApiKey).toBe(false);
  });

  it("keeps the config structure exact (compile-time)", () => {
    expectTypeOf<PiWebSearchAndFetchConfig>().toHaveProperty("search");
    expectTypeOf<PiWebSearchAndFetchConfig>().toHaveProperty("fetch");
    expectTypeOf<PiWebSearchAndFetchConfig>().toHaveProperty("deepSearch");
    expectTypeOf<PiWebSearchAndFetchConfig>().toHaveProperty("providers");
    expectTypeOf<PiWebSearchAndFetchConfig["search"]>().toEqualTypeOf<WsToolConfig>();
    expectTypeOf<PiWebSearchAndFetchConfig["fetch"]>().toEqualTypeOf<WsToolConfig>();
    expectTypeOf<PiWebSearchAndFetchConfig["deepSearch"]>().toEqualTypeOf<WsToolConfig>();
    expectTypeOf<WsToolConfig>().toHaveProperty("enabled");
    expectTypeOf<WsToolConfig>().toHaveProperty("provider");
    expectTypeOf<PiWebSearchAndFetchConfig["providers"]>().toEqualTypeOf<ProvidersConfig>();
    expectTypeOf<ProvidersConfig["exa"]>().toEqualTypeOf<ExaProviderConfig>();
    expectTypeOf<ExaProviderConfig>().toHaveProperty("useApiKey");
  });
});
