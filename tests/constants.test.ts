import { describe, expect, it } from "vitest";
import { CONFIG_FILE_NAME, DEFAULT_CONFIG, TOOL_IDS } from "../src/config/constants.js";
import type { WsToolId } from "../src/types.js";

describe("src/config/constants", () => {
  it("defines the config file name", () => {
    expect(CONFIG_FILE_NAME).toBe("pi-web-search-and-fetch.json");
  });

  it("enables search by default with the exa provider", () => {
    expect(DEFAULT_CONFIG.search).toEqual({ enabled: true, provider: "exa" });
  });

  it("enables fetch by default with the exa provider", () => {
    expect(DEFAULT_CONFIG.fetch).toEqual({ enabled: true, provider: "exa" });
  });

  it("disables deep search by default with the exa provider", () => {
    expect(DEFAULT_CONFIG.deepSearch).toEqual({ enabled: false, provider: "exa" });
  });

  it("defaults Exa to using its API key", () => {
    expect(DEFAULT_CONFIG.providers.exa.useApiKey).toBe(true);
  });

  it("defines the three exposed tool identifiers", () => {
    const ids: WsToolId[] = [
      TOOL_IDS.search,
      TOOL_IDS.fetch,
      TOOL_IDS.deepSearch,
    ];
    expect(ids).toEqual(["web_search", "web_fetch", "web_deep_search"]);
  });
});
