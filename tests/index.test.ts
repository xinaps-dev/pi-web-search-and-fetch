import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeExaClient } from "../src/providers/exa/client.js";
import {
  WS_COMMAND_DESCRIPTION,
  splitCommandArgs,
  default as piWebScoutExtension,
} from "../src/index.js";

vi.mock("../src/providers/exa/client.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/providers/exa/client.js")
  >();
  return {
    ...actual,
    closeExaClient: vi.fn(async () => {}),
  };
});

/**
 * Build a mock `ExtensionAPI` that records registrations and lifecycle
 * handlers.
 */
function mockPi() {
  const registerTool = vi.fn();
  const registerCommand = vi.fn();
  const on = vi.fn();
  const setActiveTools = vi.fn((_tools: string[]) => {});
  const getActiveTools = vi.fn(() => []);
  const pi = {
    registerTool,
    registerCommand,
    on,
    setActiveTools,
    getActiveTools,
  } as unknown as ExtensionAPI;
  return { pi, registerTool, registerCommand, on, setActiveTools };
}

/** Returns the lifecycle handler registered for the given event name. */
function handlerFor(
  on: ReturnType<typeof vi.fn>,
  event: string
): ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined {
  const call = on.mock.calls.find((args) => args[0] === event);
  return call
    ? (call[1] as (event: unknown, ctx: ExtensionContext) => Promise<void>)
    : undefined;
}

/** Build a mock extension context with a `ui.setStatus` spy. */
function mockCtx(model?: unknown) {
  const setStatus = vi.fn((_key: string, _text: string | undefined) => {});
  const ctx = { ui: { setStatus }, model } as unknown as ExtensionContext;
  return { ctx, setStatus };
}

/** Write a `pi-requesty.json` into the temp agent directory. */
function writeRequestyConfig(data: unknown): void {
  fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.PI_AGENT_DIR as string, "pi-requesty.json"),
    JSON.stringify(data),
    "utf8"
  );
}

describe("src/index", () => {
  let tmpDir: string;
  const prevAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-scout-index-"));
    process.env.PI_AGENT_DIR = tmpDir;
    vi.mocked(closeExaClient).mockClear();
  });

  afterEach(() => {
    if (prevAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = prevAgentDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("splitCommandArgs", () => {
    it("returns an empty list for empty or blank input", () => {
      expect(splitCommandArgs("")).toEqual([]);
      expect(splitCommandArgs("   ")).toEqual([]);
    });

    it("tokenizes a single argument", () => {
      expect(splitCommandArgs("status")).toEqual(["status"]);
    });

    it("tokenizes multiple arguments, collapsing repeated whitespace", () => {
      expect(splitCommandArgs("  search   on  ")).toEqual(["search", "on"]);
    });
  });

  describe("piWebScoutExtension factory", () => {
    it("registers the three Scout tools", () => {
      const { pi, registerTool } = mockPi();
      piWebScoutExtension(pi);
      expect(registerTool).toHaveBeenCalledTimes(3);
      const names = registerTool.mock.calls.map((call) => call[0].name);
      expect(names).toEqual(["web_search", "web_fetch", "web_deep_search"]);
    });

    it("never registers more than the 3 consolidated standard tools", () => {
      const { pi, registerTool } = mockPi();
      piWebScoutExtension(pi);
      const standardTools = new Set([
        "web_search",
        "web_fetch",
        "web_deep_search",
      ]);
      const names = registerTool.mock.calls.map((call) => call[0].name);
      expect(names.length).toBeLessThanOrEqual(3);
      for (const name of names) {
        expect(standardTools.has(name)).toBe(true);
      }
    });

    it("registers the single /ws command with description", () => {
      const { pi, registerCommand } = mockPi();
      piWebScoutExtension(pi);
      expect(registerCommand).toHaveBeenCalledTimes(1);
      const [name, options] = registerCommand.mock.calls[0];
      expect(name).toBe("ws");
      expect(options.description).toBe(WS_COMMAND_DESCRIPTION);
      expect(typeof options.handler).toBe("function");
    });

    it("registers the four lifecycle listeners", () => {
      const { pi, on } = mockPi();
      piWebScoutExtension(pi);
      const events = on.mock.calls.map((call) => call[0]);
      expect(events).toEqual([
        "session_start",
        "model_select",
        "before_agent_start",
        "session_shutdown",
      ]);
    });

    it("session_start: syncs tools", async () => {
      const { pi, on, setActiveTools } = mockPi();
      piWebScoutExtension(pi);
      const { ctx, setStatus } = mockCtx();
      const handler = handlerFor(on, "session_start");
      expect(handler).toBeDefined();
      await handler!({ type: "session_start", reason: "startup" }, ctx);
      expect(setActiveTools).toHaveBeenCalledWith(["web_search", "web_fetch"]);
      expect(setStatus).not.toHaveBeenCalled();
    });

    it("model_select: re-evaluates pi-requesty compatibility and syncs tools", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const { pi, on, setActiveTools } = mockPi();
      piWebScoutExtension(pi);
      const { ctx, setStatus } = mockCtx();
      const handler = handlerFor(on, "model_select");
      expect(handler).toBeDefined();
      await handler!(
        {
          type: "model_select",
          model: {
            provider: "requesty",
            id: "gpt-4o",
            supportsWebSearch: true,
          },
          previousModel: undefined,
          source: "set",
        },
        ctx
      );
      // web_search suppressed, web_fetch kept.
      expect(setActiveTools).toHaveBeenCalledWith(["web_fetch"]);
      expect(setStatus).not.toHaveBeenCalled();
    });

    it("before_agent_start: ensures active tools match model and config", async () => {
      const { pi, on, setActiveTools } = mockPi();
      piWebScoutExtension(pi);
      const { ctx } = mockCtx({
        provider: "requesty",
        id: "gpt-4o",
        supportsWebSearch: true,
      });
      const handler = handlerFor(on, "before_agent_start");
      expect(handler).toBeDefined();
      await handler!(
        { type: "before_agent_start", prompt: "hi", systemPrompt: "" },
        ctx
      );
      // No pi-requesty config file → no suppression.
      expect(setActiveTools).toHaveBeenCalledWith(["web_search", "web_fetch"]);
    });

    it("session_start, model_select and before_agent_start all trigger tool sync", async () => {
      const { pi, on, setActiveTools } = mockPi();
      piWebScoutExtension(pi);
      const { ctx } = mockCtx();
      const sessionStart = handlerFor(on, "session_start");
      const modelSelect = handlerFor(on, "model_select");
      const beforeAgentStart = handlerFor(on, "before_agent_start");
      expect(sessionStart).toBeDefined();
      expect(modelSelect).toBeDefined();
      expect(beforeAgentStart).toBeDefined();
      await sessionStart!({ type: "session_start", reason: "startup" }, ctx);
      expect(setActiveTools).toHaveBeenCalledTimes(1);
      await modelSelect!(
        { type: "model_select", model: undefined, previousModel: undefined, source: "set" },
        ctx
      );
      expect(setActiveTools).toHaveBeenCalledTimes(2);
      await beforeAgentStart!(
        { type: "before_agent_start", prompt: "hi", systemPrompt: "" },
        ctx
      );
      expect(setActiveTools).toHaveBeenCalledTimes(3);
    });

    it("session_shutdown: invokes closeExaClient", async () => {
      const { pi, on } = mockPi();
      piWebScoutExtension(pi);
      const handler = handlerFor(on, "session_shutdown");
      expect(handler).toBeDefined();
      const { ctx } = mockCtx();
      await handler!({ type: "session_shutdown", reason: "quit" }, ctx);
      expect(closeExaClient).toHaveBeenCalledTimes(1);
    });
  });
});
