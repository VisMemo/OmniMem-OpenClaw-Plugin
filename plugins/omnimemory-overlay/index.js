import { resolveOmniCommonConfig } from "./runtime/config.js";
import { buildOverlayRecallContext, captureConversation } from "./runtime/integration.js";

const plugin = {
  id: "omnimemory-overlay",
  name: "OmniMemory Overlay",
  description: "Non-destructive external long-term memory overlay for OpenClaw.",
  register(api) {
    const config = resolveOmniCommonConfig(api.pluginConfig);

    api.on("before_prompt_build", async (event, ctx) => {
      return await buildOverlayRecallContext({
        config,
        event,
        ctx,
        logger: api.logger,
      });
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
      id: "omnimemory-overlay",
      start() {
        api.logger.info("omnimemory-overlay: started");
      },
      stop() {
        api.logger.info("omnimemory-overlay: stopped");
      },
    });
  },
};

export default plugin;
