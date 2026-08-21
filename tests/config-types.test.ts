import { describe, expect, expectTypeOf, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/constants.js";
import type {
  ExaProviderConfig,
  PiWebScoutConfig,
  ProvidersConfig,
  WsToolConfig,
} from "../src/config/types.js";

describe("src/config/types", () => {
  it("types the default config as PiWebScoutConfig", () => {
    const config: PiWebScoutConfig = DEFAULT_CONFIG;
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
    const config: PiWebScoutConfig = raw;
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
    expectTypeOf<PiWebScoutConfig>().toHaveProperty("search");
    expectTypeOf<PiWebScoutConfig>().toHaveProperty("fetch");
    expectTypeOf<PiWebScoutConfig>().toHaveProperty("deepSearch");
    expectTypeOf<PiWebScoutConfig>().toHaveProperty("providers");
    expectTypeOf<PiWebScoutConfig["search"]>().toEqualTypeOf<WsToolConfig>();
    expectTypeOf<PiWebScoutConfig["fetch"]>().toEqualTypeOf<WsToolConfig>();
    expectTypeOf<PiWebScoutConfig["deepSearch"]>().toEqualTypeOf<WsToolConfig>();
    expectTypeOf<WsToolConfig>().toHaveProperty("enabled");
    expectTypeOf<WsToolConfig>().toHaveProperty("provider");
    expectTypeOf<PiWebScoutConfig["providers"]>().toEqualTypeOf<ProvidersConfig>();
    expectTypeOf<ProvidersConfig["exa"]>().toEqualTypeOf<ExaProviderConfig>();
    expectTypeOf<ExaProviderConfig>().toHaveProperty("useApiKey");
  });
});
