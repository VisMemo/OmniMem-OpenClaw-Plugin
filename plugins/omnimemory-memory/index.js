import { resolveOmniCommonConfig } from "./runtime/config.js";
import {
  buildMemoryModePromptHookResult,
  captureConversation,
  createMemoryGetTool,
  createMemorySearchTool,
} from "./runtime/integration.js";

const plugin = {
  id: "omnimemory-memory",
  kind: "memory",
  name: "OmniMemory",
  description: "OmniMemory-backed memory slot plugin for OpenClaw.",
  register(api) {
    const config = resolveOmniCommonConfig(api.pluginConfig);

    api.registerTool(
      (ctx) => [
        createMemorySearchTool({
          config,
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
        }),
        createMemoryGetTool({
          config,
        }),
      ],
      { names: ["memory_search", "memory_get"] },
    );

    api.on("before_prompt_build", async () => {
      return buildMemoryModePromptHookResult();
    });

    api.on("agent_end", async (event, ctx) => {
      await captureConversation({
        config,
        event,
        ctx,
        logger: api.logger,
        wait: false,
      });
    });

    api.on("before_compaction", async (event, ctx) => {
      await captureConversation({
        config,
        event,
        ctx,
        logger: api.logger,
        wait: false,
      });
    });

    api.on("before_reset", async (event, ctx) => {
      await captureConversation({
        config,
        event,
        ctx,
        logger: api.logger,
        wait: true,
      });
    });

    api.registerService({
      id: "omnimemory-memory",
      start() {
        api.logger.info("omnimemory-memory: started");
      },
      stop() {
        api.logger.info("omnimemory-memory: stopped");
      },
    });
  },
};

export default plugin;
