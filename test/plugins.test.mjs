import test from "node:test";
import assert from "node:assert/strict";

import overlayPlugin from "../plugins/omnimemory-overlay/index.js";
import memoryPlugin from "../plugins/omnimemory-memory/index.js";

function createMockApi(pluginConfig = {}) {
  const state = {
    hooks: [],
    tools: [],
    services: [],
  };
  return {
    state,
    pluginConfig,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    on(name, handler) {
      state.hooks.push({ name, handler });
    },
    registerTool(tool, opts) {
      state.tools.push({ tool, opts });
    },
    registerService(service) {
      state.services.push(service);
    },
  };
}

test("overlay plugin registers recall/capture hooks", () => {
  const api = createMockApi({ apiKey: "qbk_test" });
  overlayPlugin.register(api);
  assert.deepEqual(
    api.state.hooks.map((entry) => entry.name),
    ["before_prompt_build", "agent_end", "before_compaction", "before_reset"],
  );
  assert.equal(api.state.services.length, 1);
});

test("memory plugin registers memory tools and lifecycle hooks", async () => {
  const api = createMockApi({ apiKey: "qbk_test" });
  memoryPlugin.register(api);
  assert.equal(api.state.tools.length, 1);
  assert.deepEqual(api.state.tools[0].opts.names, ["memory_search", "memory_get"]);
  assert.deepEqual(
    api.state.hooks.map((entry) => entry.name),
    ["before_prompt_build", "agent_end", "before_compaction", "before_reset"],
  );

  const factory = api.state.tools[0].tool;
  const tools = factory({ sessionKey: "agent:main:test", sessionId: "sid" });
  assert.equal(Array.isArray(tools), true);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "memory_search");
  assert.equal(tools[1].name, "memory_get");
});

