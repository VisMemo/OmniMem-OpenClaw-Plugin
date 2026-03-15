import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startMockOmniServer } from "../scripts/lib/mock-omni-server.mjs";
import { buildOverlayRecallContext, captureConversation } from "../src/runtime/integration.js";
import { resolveOmniCommonConfig } from "../src/runtime/config.js";

function createLogger() {
  return {
    warn() {},
    info() {},
    debug() {},
    error() {},
  };
}

test("overlay recall and capture talk to mock Omni server", async () => {
  const mock = await startMockOmniServer();
  const config = resolveOmniCommonConfig({
    apiKey: "test-key",
    baseUrl: mock.baseUrl,
    autoRecall: true,
    autoCapture: true,
    writeWait: true,
  });

  try {
    const recall = await buildOverlayRecallContext({
      config,
      event: { prompt: "What did Caroline mention about the support group?" },
      ctx: { sessionKey: "agent:main:test:overlay" },
      logger: createLogger(),
    });
    assert.ok(recall?.prependContext?.includes("support group"));
    assert.equal(mock.state.retrievalRequests.length, 1);

    const capture = await captureConversation({
      config,
      event: {
        messages: [
          { role: "user", content: "I went to a support group yesterday.", timestamp: "2026-01-14T10:00:00Z" },
          { role: "assistant", content: "That sounds meaningful.", timestamp: "2026-01-14T10:01:00Z" },
        ],
      },
      ctx: { sessionKey: "agent:main:test:overlay" },
      logger: createLogger(),
      wait: true,
    });
    assert.equal(capture.skipped, false);
    assert.equal(mock.state.ingestRequests.length, 1);
    assert.equal(mock.state.ingestRequests[0].session_id, "agent:main:test:overlay");
  } finally {
    await mock.close();
  }
});

test("captureConversation falls back to sessionFile and skips duplicate re-ingest", async () => {
  const mock = await startMockOmniServer();
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-overlay-workspace-"));
  const sessionFile = path.join(workspaceDir, "session.jsonl");
  await writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "I went to a support group yesterday." }],
          timestamp: "2026-01-14T10:00:00Z",
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "That sounds meaningful." }],
          timestamp: "2026-01-14T10:01:00Z",
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const config = resolveOmniCommonConfig({
    apiKey: "test-key",
    baseUrl: mock.baseUrl,
    autoCapture: true,
    writeWait: true,
    captureRoles: ["user", "assistant"],
    captureStrategy: "full_session",
  });

  try {
    const first = await captureConversation({
      config,
      event: { sessionFile },
      ctx: { sessionKey: "agent:main:test:overlay:file", workspaceDir },
      logger: createLogger(),
      wait: true,
    });
    assert.equal(first.skipped, false);
    assert.equal(mock.state.ingestRequests.length, 1);
    assert.equal(mock.state.ingestRequests[0].turns.length, 2);

    const second = await captureConversation({
      config,
      event: { sessionFile },
      ctx: { sessionKey: "agent:main:test:overlay:file", workspaceDir },
      logger: createLogger(),
      wait: true,
    });
    assert.equal(second.skipped, true);
    assert.equal(second.reason, "duplicate");
    assert.equal(mock.state.ingestRequests.length, 1);
  } finally {
    await mock.close();
  }
});
