import test from "node:test";
import assert from "node:assert/strict";

import { startMockOmniServer } from "../scripts/lib/mock-omni-server.mjs";
import {
  startOpenClawGatewayForMemoryHookSmoke,
  startOpenClawGatewayForOverlayHookSmoke,
} from "../scripts/lib/openclaw-smoke.mjs";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, { timeoutMs = 40_000, intervalMs = 400, message = "condition timeout" } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return;
    }
    await wait(intervalMs);
  }
  throw new Error(message);
}

function findIngestByTurnMarker(requests, marker) {
  return requests.find((entry) =>
    (Array.isArray(entry?.turns) ? entry.turns : []).some((turn) =>
      typeof turn?.text === "string" ? turn.text.includes(marker) : false,
    ),
  );
}

test("overlay recall timeout is fail-open and still captures the conversation", async () => {
  let delayedRetrievals = 1;
  const mock = await startMockOmniServer({
    handlers: {
      async retrieval() {
        if (delayedRetrievals > 0) {
          delayedRetrievals -= 1;
          await wait(500);
        }
        return undefined;
      },
    },
  });
  let gateway;
  const marker = "overlay-timeout-fail-open-marker-001";

  try {
    gateway = await startOpenClawGatewayForOverlayHookSmoke({
      port: 18920,
      token: "omnimem-overlay-timeout-token",
      hookToken: "omnimem-overlay-timeout-hook-token",
      baseUrl: mock.baseUrl,
      pluginConfig: {
        timeoutMs: 150,
      },
    });

    await gateway.invokeHookAgent({
      message: `overlay timeout should still fail open ${marker}`,
      sessionKey: "agent:main:overlay:e2e:timeout-fail-open",
      name: "overlay-timeout-fail-open-check",
      timeoutSeconds: 4,
      idempotencyKey: "overlay-timeout-fail-open-check-1",
      deliver: false,
    });

    await waitFor(() => Boolean(findIngestByTurnMarker(mock.state.ingestRequests, marker)), {
      message: "expected ingest despite timed out retrieval",
    });

    assert.equal(mock.state.retrievalRequests.length, 1);
    assert.equal(await gateway.health(), 200);
  } finally {
    if (gateway) {
      await gateway.close();
    }
    await mock.close();
  }
});

test("replacement capture timeout is best-effort and later tool calls still recover", async () => {
  let delayedIngests = 1;
  const mock = await startMockOmniServer({
    handlers: {
      async ingest() {
        if (delayedIngests > 0) {
          delayedIngests -= 1;
          await wait(500);
        }
        return undefined;
      },
    },
  });
  let gateway;
  const firstMarker = "replacement-timeout-best-effort-first-001";
  const secondMarker = "replacement-timeout-best-effort-second-002";

  try {
    gateway = await startOpenClawGatewayForMemoryHookSmoke({
      port: 18921,
      token: "omnimem-replacement-timeout-token",
      hookToken: "omnimem-replacement-timeout-hook-token",
      baseUrl: mock.baseUrl,
      pluginConfig: {
        timeoutMs: 150,
      },
    });

    await gateway.invokeHookAgent({
      message: `first replacement run should hit ingest timeout ${firstMarker}`,
      sessionKey: "agent:main:replacement:e2e:timeout-best-effort",
      name: "replacement-timeout-best-effort-check-1",
      timeoutSeconds: 4,
      idempotencyKey: "replacement-timeout-best-effort-check-1",
      deliver: false,
    });

    await waitFor(() => Boolean(findIngestByTurnMarker(mock.state.ingestRequests, firstMarker)), {
      timeoutMs: 5_000,
      intervalMs: 200,
      message: "expected first ingest request to reach the backend despite client timeout",
    });
    assert.equal(await gateway.health(), 200);

    await gateway.invokeHookAgent({
      message: `second replacement run should still complete ${secondMarker}`,
      sessionKey: "agent:main:replacement:e2e:timeout-best-effort",
      name: "replacement-timeout-best-effort-check-2",
      timeoutSeconds: 4,
      idempotencyKey: "replacement-timeout-best-effort-check-2",
      deliver: false,
    });

    await waitFor(
      () => Boolean(findIngestByTurnMarker(mock.state.ingestRequests, secondMarker)) && mock.state.jobs.size >= 1,
      {
        message: "expected a later replacement ingest to succeed after the timeout",
      },
    );

    const search = await gateway.invokeTool({
      tool: "memory_search",
      args: {
        query: secondMarker,
        maxResults: 5,
      },
      sessionKey: "agent:main:replacement:e2e:timeout-best-effort",
      sessionId: "replacement-timeout-best-effort-session",
    });

    assert.equal(search.ok, true);
    const results = Array.isArray(search?.result?.details?.results) ? search.result.details.results : [];
    assert.ok(
      results.some((entry) => String(entry?.snippet || "").includes(secondMarker)),
      "expected memory_search to keep working after the earlier ingest timeout",
    );
    assert.equal(await gateway.health(), 200);
  } finally {
    if (gateway) {
      await gateway.close();
    }
    await mock.close();
  }
});
