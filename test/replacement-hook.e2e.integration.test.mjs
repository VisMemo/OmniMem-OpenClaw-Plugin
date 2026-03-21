import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startMockOmniServer } from "../scripts/lib/mock-omni-server.mjs";
import { startOpenClawGatewayForMemoryHookSmoke } from "../scripts/lib/openclaw-smoke.mjs";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, { timeoutMs = 40_000, intervalMs = 400, message = "condition timeout" } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
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

async function createBeforeResetObserverPlugin(outputPath) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnimem-before-reset-observer-"));
  await writeFile(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: "omnimemory-test-before-reset-observer",
        name: "OmniMemory Test Before Reset Observer",
        description: "Writes before_reset hook payloads to disk for runtime verification.",
        configSchema: {
          type: "object",
          additionalProperties: false,
          required: ["outputPath"],
          properties: {
            outputPath: {
              type: "string",
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(dir, "index.js"),
    [
      'import { writeFile } from "node:fs/promises";',
      "",
      "const plugin = {",
      '  id: "omnimemory-test-before-reset-observer",',
      '  name: "OmniMemory Test Before Reset Observer",',
      "  register(api) {",
      '    api.on("before_reset", async (event, ctx) => {',
      '      const outputPath = api.pluginConfig?.outputPath;',
      '      if (!outputPath) {',
      "        return;",
      "      }",
      "      await writeFile(",
      "        outputPath,",
      "        JSON.stringify({",
      "          reason: event?.reason,",
      "          sessionFile: event?.sessionFile,",
      "          sessionId: ctx?.sessionId,",
      "          sessionKey: ctx?.sessionKey,",
      "          messageCount: Array.isArray(event?.messages) ? event.messages.length : 0,",
      "          messages: Array.isArray(event?.messages) ? event.messages : [],",
      "        }, null, 2),",
      '        "utf8",',
      "      );",
      "    });",
      "  },",
      "};",
      "",
      "export default plugin;",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

test("replacement hook e2e: OpenClaw /hooks/agent triggers agent_end capture for memory slot plugin", async () => {
  const mock = await startMockOmniServer();
  let gateway;
  const sessionKey = "agent:main:replacement:e2e:agent-end";
  const marker = "replacement-agent-end-marker-001";

  try {
    gateway = await startOpenClawGatewayForMemoryHookSmoke({
      port: 18912,
      token: "omnimem-replacement-e2e-token",
      hookToken: "omnimem-replacement-hook-token",
      baseUrl: mock.baseUrl,
      pluginConfig: {
        autoCapture: true,
        captureRoles: ["user"],
        captureStrategy: "last_turn",
      },
    });

    const hook = await gateway.invokeHookAgent({
      message: `Please remember this replacement hook marker. ${marker}`,
      sessionKey,
      name: "replacement-hook-agent-end-check",
      timeoutSeconds: 4,
      idempotencyKey: "replacement-hook-agent-end-check-1",
      deliver: false,
    });
    assert.equal(hook.ok, true);
    assert.equal(typeof hook.runId, "string");

    await waitFor(() => Boolean(findIngestByTurnMarker(mock.state.ingestRequests, marker)), {
      message: "expected replacement agent_end capture to reach Omni ingest",
    });

    const ingest = findIngestByTurnMarker(mock.state.ingestRequests, marker);
    assert.ok(ingest);
    assert.equal(typeof ingest.session_id, "string");
    assert.notEqual(ingest.session_id, sessionKey);
    assert.ok(Array.isArray(ingest.turns));
    assert.ok(ingest.turns.length >= 1);
  } finally {
    if (gateway) {
      await gateway.close();
    }
    await mock.close();
  }
});

test.skip("replacement hook e2e [known gap]: sidecar plugin observes before_reset on the real /new chat path", async () => {
  const mock = await startMockOmniServer();
  let gateway;
  let rpc;
  const sessionKey = "agent:main:main";
  const seededSessionId = "replacement-reset-session-observer-001";
  const marker = "replacement-before-reset-observer-marker-001";
  const observerOutput = path.join(
    await mkdtemp(path.join(os.tmpdir(), "omnimem-before-reset-output-")),
    "before-reset.json",
  );
  const observerPluginDir = await createBeforeResetObserverPlugin(observerOutput);

  try {
    gateway = await startOpenClawGatewayForMemoryHookSmoke({
      port: 18914,
      token: "omnimem-replacement-e2e-token-observer",
      hookToken: "omnimem-replacement-hook-token-observer",
      baseUrl: mock.baseUrl,
      extraPluginPaths: [observerPluginDir],
      extraPluginEntries: {
        "omnimemory-test-before-reset-observer": {
          enabled: true,
          config: {
            outputPath: observerOutput,
          },
        },
      },
      pluginConfig: {
        autoCapture: true,
        captureRoles: ["user", "assistant"],
        captureStrategy: "full_session",
      },
      seedSessions: [
        {
          storeKey: sessionKey,
          aliases: ["main"],
          sessionId: seededSessionId,
          messages: [
            {
              role: "user",
              content: `Please keep this reset observer marker around. ${marker}`,
              timestamp: "2026-03-21T10:00:00.000Z",
            },
            {
              role: "assistant",
              content: "Acknowledged. I will keep it in the prior session transcript.",
              timestamp: "2026-03-21T10:00:01.000Z",
            },
          ],
        },
      ],
    });

    rpc = await gateway.openRpcClient();
    const reset = await rpc.request(
      "chat.send",
      {
        sessionKey: "main",
        message: "/new",
        idempotencyKey: "replacement-before-reset-observer-chat-send-1",
      },
      10_000,
    );
    assert.equal(reset.ok, true, JSON.stringify(reset));

    await waitFor(
      async () => {
        try {
          await access(observerOutput);
          return true;
        } catch {
          return false;
        }
      },
      {
        message: "expected the sidecar before_reset observer to write its payload",
      },
    );

    const payload = JSON.parse(await readFile(observerOutput, "utf8"));
    assert.equal(payload.reason, "new");
    assert.equal(payload.sessionId, seededSessionId);
    assert.ok(Array.isArray(payload.messages));
    assert.ok(payload.messages.some((message) => JSON.stringify(message).includes(marker)));
  } finally {
    if (rpc) {
      await rpc.close();
    }
    if (gateway) {
      await gateway.close();
    }
    await mock.close();
  }
});

test.skip("replacement hook e2e [known gap]: chat.send /new triggers before_reset capture from the previous session transcript", async () => {
  const mock = await startMockOmniServer();
  let gateway;
  let rpc;
  const sessionKey = "agent:main:main";
  const seededSessionId = "replacement-reset-session-001";
  const marker = "replacement-before-reset-marker-001";

  try {
    gateway = await startOpenClawGatewayForMemoryHookSmoke({
      port: 18913,
      token: "omnimem-replacement-e2e-token-reset",
      hookToken: "omnimem-replacement-hook-token-reset",
      baseUrl: mock.baseUrl,
      pluginConfig: {
        autoCapture: true,
        captureRoles: ["user", "assistant"],
        captureStrategy: "full_session",
      },
      seedSessions: [
        {
          storeKey: sessionKey,
          aliases: ["main"],
          sessionId: seededSessionId,
          messages: [
            {
              role: "user",
              content: `Please keep this reset marker around. ${marker}`,
              timestamp: "2026-03-21T10:00:00.000Z",
            },
            {
              role: "assistant",
              content: "Acknowledged. I will keep it in the prior session transcript.",
              timestamp: "2026-03-21T10:00:01.000Z",
            },
          ],
        },
      ],
    });

    rpc = await gateway.openRpcClient();
    const reset = await rpc.request(
      "chat.send",
      {
        sessionKey: "main",
        message: "/new",
        idempotencyKey: "replacement-before-reset-chat-send-1",
      },
      10_000,
    );
    assert.equal(reset.ok, true, JSON.stringify(reset));

    await waitFor(() => Boolean(findIngestByTurnMarker(mock.state.ingestRequests, marker)), {
      message: "expected before_reset capture to ingest the seeded transcript marker",
    });

    const ingest = findIngestByTurnMarker(mock.state.ingestRequests, marker);
    assert.ok(ingest);
    assert.equal(ingest.session_id, seededSessionId);
    assert.ok(Array.isArray(ingest.turns));
    assert.ok(ingest.turns.length >= 2);
  } finally {
    if (rpc) {
      await rpc.close();
    }
    if (gateway) {
      await gateway.close();
    }
    await mock.close();
  }
});
