import test from "node:test";
import assert from "node:assert/strict";

import { startMockOmniServer } from "../scripts/lib/mock-omni-server.mjs";
import { startOpenClawGatewayForMemorySmoke } from "../scripts/lib/openclaw-smoke.mjs";

test("OpenClaw loads omnimemory-memory and serves memory_search/memory_get with tenant-global retrieval by default", async () => {
  const mock = await startMockOmniServer();
  let gateway;
  const sessionKey = "agent:main:integration:memory";
  const sessionId = "memory-session-001";

  try {
    gateway = await startOpenClawGatewayForMemorySmoke({
      port: 18892,
      token: "omnimem-integration-token",
      baseUrl: mock.baseUrl,
    });

    const search = await gateway.invokeTool({
      tool: "memory_search",
      args: { query: "What did Caroline mention about the support group?", maxResults: 3 },
      sessionKey,
      sessionId,
    });

    assert.equal(search.ok, true);
    const searchDetails = search.result?.details;
    assert.ok(searchDetails);
    assert.equal(searchDetails.provider, "omnimemory");
    assert.ok(Array.isArray(searchDetails.results));
    assert.ok(searchDetails.results[0]?.path?.startsWith("omni:event:"));
    assert.equal(mock.state.retrievalRequests.length, 1);
    assert.equal(mock.state.retrievalRequests[0].run_id, undefined);

    const get = await gateway.invokeTool({
      tool: "memory_get",
      args: { path: searchDetails.results[0].path },
      sessionKey,
      sessionId,
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

test("memory slot recall remains tenant-global across different sessions", async () => {
  const mock = await startMockOmniServer();
  let gateway;

  try {
    gateway = await startOpenClawGatewayForMemorySmoke({
      port: 18899,
      token: "omnimem-integration-token-global-recall",
      baseUrl: mock.baseUrl,
    });

    await gateway.invokeTool({
      tool: "memory_search",
      args: { query: "global recall query one" },
      sessionKey: "agent:ops:ticket-alpha",
      sessionId: "ops-run-001",
    });
    await gateway.invokeTool({
      tool: "memory_search",
      args: { query: "global recall query two" },
      sessionKey: "agent:main:ticket-beta",
      sessionId: "main-run-002",
    });

    assert.equal(mock.state.retrievalRequests.length, 2);
    assert.equal(mock.state.retrievalRequests[0].run_id, undefined);
    assert.equal(mock.state.retrievalRequests[1].run_id, undefined);
  } finally {
    if (gateway) {
      await gateway.close();
    }
    await mock.close();
  }
});
