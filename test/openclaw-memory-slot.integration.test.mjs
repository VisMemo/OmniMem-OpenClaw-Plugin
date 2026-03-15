import test from "node:test";
import assert from "node:assert/strict";

import { startMockOmniServer } from "../scripts/lib/mock-omni-server.mjs";
import { startOpenClawGatewayForMemorySmoke } from "../scripts/lib/openclaw-smoke.mjs";

test("OpenClaw loads omnimemory-memory and serves memory_search/memory_get via /tools/invoke", async () => {
  const mock = await startMockOmniServer();
  let gateway;

  try {
    gateway = await startOpenClawGatewayForMemorySmoke({
      port: 18892,
      token: "omnimem-integration-token",
      baseUrl: mock.baseUrl,
    });

    const search = await gateway.invokeTool({
      tool: "memory_search",
      args: { query: "What did Caroline mention about the support group?", maxResults: 3 },
      sessionKey: "agent:main:integration:memory",
    });

    assert.equal(search.ok, true);
    const searchDetails = search.result?.details;
    assert.ok(searchDetails);
    assert.equal(searchDetails.provider, "omnimemory");
    assert.ok(Array.isArray(searchDetails.results));
    assert.ok(searchDetails.results[0]?.path?.startsWith("omni:event:"));
    assert.equal(mock.state.retrievalRequests.length, 1);

    const get = await gateway.invokeTool({
      tool: "memory_get",
      args: { path: searchDetails.results[0].path },
      sessionKey: "agent:main:integration:memory",
    });

    assert.equal(get.ok, true);
    const getDetails = get.result?.details;
    assert.ok(getDetails?.text?.includes("support group"));
  } finally {
    if (gateway) {
      await gateway.close();
    }
    await mock.close();
  }
});
