/**
 * Main entry point of the pi-web-scout Pi extension.
 *
 * The default export is the Pi extension factory `(pi: ExtensionAPI) => void`
 * that performs the whole initialization and registration of the extension:
 *
 * 1. **Providers** — registers the provider modules in the in-memory
 *    `ProviderRegistry`; initially only `exa`.
 * 2. **Tools** — registers the tools exposed to the LLM: `web_search`,
 *    `web_fetch` and `web_deep_search`.
 * 3. **Command** — registers the single `/ws` command which opens the
 *    interactive Hub.
 * 4. **Lifecycle listeners**:
 *    - `session_start`: synchronizes the active tools.
 *    - `model_select`: re-evaluates the `pi-requesty` compatibility for the
 *      newly selected model and synchronizes the tools.
 *    - `before_agent_start`: ensures the active tools correspond to the
 *      current model and configuration.
 *    - `session_shutdown`: invokes `closeExaClient()` to release the Exa
 *      MCP connection.
 */

import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { handleWsCommand } from "./commands/index.js";
import { closeExaClient, exaProviderModule } from "./providers/exa/index.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createWebDeepSearchTool } from "./tools/web-deep-search.js";
import { createWebFetchTool } from "./tools/web-fetch.js";
import { createWebSearchTool } from "./tools/web-search.js";
import { syncActiveTools } from "./tools/sync.js";

/**
 * Description of the single `/ws` command shown in Pi's command list.
 */
export const WS_COMMAND_DESCRIPTION =
  "Open the Web Scout interactive control panel and provider settings";

/**
 * Tokenize the raw argument string received by the `/ws` command handler.
 */
export function splitCommandArgs(args: string): string[] {
  const trimmed = args.trim();
  if (trimmed === "") {
    return [];
  }
  return trimmed.split(/\s+/);
}

/**
 * Pi extension factory of pi-web-scout.
 *
 * Registers the providers, tools, the single `/ws` command and the
 * lifecycle listeners described in the module header.
 */
export default function piWebScoutExtension(pi: ExtensionAPI): void {
  // 1. Provider registry: initially only Exa.
  const registry = new ProviderRegistry();
  registry.registerProvider(exaProviderModule);

  // 2. Tools exposed to the LLM.
  pi.registerTool(createWebSearchTool(registry));
  pi.registerTool(createWebFetchTool(registry));
  pi.registerTool(createWebDeepSearchTool(registry));

  // 3. Single /ws command that opens the interactive hub.
  pi.registerCommand("ws", {
    description: WS_COMMAND_DESCRIPTION,
    handler: (args, ctx) =>
      handleWsCommand(ctx, splitCommandArgs(args), registry, pi),
  });

  // 4. Lifecycle listeners.
  pi.on("session_start", async (_event, ctx) => {
    // Synchronize the active tools with the current model and config.
    await syncActiveTools(pi, ctx.model);
  });

  pi.on("model_select", async (event) => {
    // Re-evaluate the pi-requesty compatibility for the newly selected
    // model and synchronize the tools.
    await syncActiveTools(pi, event.model);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // Ensure the active tools correspond to the current model and
    // configuration before each agent run.
    await syncActiveTools(pi, ctx.model);
  });

  pi.on("session_shutdown", async () => {
    // Release the Exa MCP connection.
    await closeExaClient();
  });
}
