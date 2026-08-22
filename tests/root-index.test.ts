import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import rootExtension from "../index.js";
import { default as srcExtension } from "../src/index.js";

describe("root index.ts", () => {
  it("re-exports the pi-web-search-and-fetch extension factory from src/index.ts by default", () => {
    expect(typeof rootExtension).toBe("function");
    expect(rootExtension).toBe(srcExtension);
  });

  it("acts as the Pi extension entry point (registers tools, command and lifecycle listeners)", () => {
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const on = vi.fn();
    const pi = {
      registerTool,
      registerCommand,
      on,
      setActiveTools: vi.fn((_tools: string[]) => {}),
      getActiveTools: vi.fn(() => []),
    } as unknown as ExtensionAPI;

    rootExtension(pi);

    expect(registerTool).toHaveBeenCalledTimes(3);
    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand.mock.calls[0][0]).toBe("ws");
    expect(on).toHaveBeenCalledTimes(4);
  });
});
