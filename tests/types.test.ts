import { describe, expect, it } from "vitest";
import type {
  ToolState,
  ToolStatus,
  WebSearchSuppression,
  WsSubcommand,
  WsToolId,
  WsToolKey,
} from "../src/types.js";

describe("src/types", () => {
  it("defines the three exposed tool identifiers", () => {
    const toolIds: WsToolId[] = ["web_search", "web_fetch", "web_deep_search"];
    expect(new Set(toolIds)).toEqual(
      new Set(["web_search", "web_fetch", "web_deep_search"])
    );
  });

  it("defines the short tool keys used by /ws provider", () => {
    const keys: WsToolKey[] = ["search", "fetch", "deep"];
    expect(keys).toHaveLength(3);
  });

  it("defines the on/off tool states", () => {
    const states: ToolState[] = ["on", "off"];
    expect(states).toHaveLength(2);
  });

  it("defines the /ws subcommands", () => {
    const subcommands: WsSubcommand[] = [
      "status",
      "search",
      "fetch",
      "deep",
      "provider",
      "config",
      "help",
      "hub",
    ];
    expect(subcommands).toHaveLength(8);
  });

  it("describes the web_search suppression result", () => {
    const suppression: WebSearchSuppression = {
      shouldSuppress: true,
      reason: "requesty native search",
    };
    expect(suppression.shouldSuppress).toBe(true);
    expect(suppression.reason).toBe("requesty native search");
  });

  it("describes a tool status snapshot", () => {
    const status: ToolStatus = {
      toolId: "web_search",
      enabled: true,
      providerId: "exa",
    };
    expect(status.toolId).toBe("web_search");
    expect(status.enabled).toBe(true);
    expect(status.providerId).toBe("exa");
  });
});
