import { describe, expect, it } from "vitest";

describe("project dependencies", () => {
  it("provides the MCP SDK transport used by the Exa provider", async () => {
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    expect(typeof StreamableHTTPClientTransport).toBe("function");
  });

  it("provides TypeBox for tool schemas", async () => {
    const { Type } = await import("typebox");
    expect(typeof Type.String).toBe("function");
    expect(typeof Type.Optional).toBe("function");
  });

  it("provides the pi TUI package", async () => {
    const tui = await import("@earendil-works/pi-tui");
    expect(tui).toBeTruthy();
  });
});
