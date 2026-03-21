import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveOmniCommonConfig } from "../src/runtime/config.js";
import { ingestMessages } from "../src/runtime/omni-client.js";
import { fingerprintMessages } from "../src/runtime/messages.js";
import { startMockOmniServer } from "../scripts/lib/mock-omni-server.mjs";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("writeback concurrency: same scope serializes cursor progression for different payloads", async () => {
  const mock = await startMockOmniServer({
    handlers: {
      async ingest() {
        await wait(250);
        return undefined;
      },
    },
  });
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-writeback-concurrency-"));
  const statePath = path.join(workspaceDir, "concurrency-state.json");
  const config = resolveOmniCommonConfig({
    apiKey: "test-key",
    baseUrl: mock.baseUrl,
    timeoutMs: 5_000,
  });
  const scopeId = "agent:main:test:writeback-concurrency";
  const firstMessages = [
    {
      role: "user",
      text: "first concurrent payload",
      timestampIso: "2026-03-21T08:00:00.000Z",
    },
  ];
  const secondMessages = [
    {
      role: "user",
      text: "second concurrent payload",
      timestampIso: "2026-03-21T08:00:01.000Z",
    },
  ];

  try {
    const [first, second] = await Promise.all([
      ingestMessages({
        config,
        sessionKey: scopeId,
        messages: firstMessages,
        statePath,
      }),
      ingestMessages({
        config,
        sessionKey: scopeId,
        messages: secondMessages,
        statePath,
      }),
    ]);

    assert.equal(first.skipped, false);
    assert.equal(second.skipped, false);
    assert.equal(mock.state.ingestRequests.length, 2);
    assert.equal(mock.state.ingestRequests[0].cursor?.base_turn_id, null);
    assert.equal(mock.state.ingestRequests[0].turns[0]?.turn_id, "t0001");
    assert.equal(mock.state.ingestRequests[1].cursor?.base_turn_id, "t0001");
    assert.equal(mock.state.ingestRequests[1].turns[0]?.turn_id, "t0002");

    const persistedState = await readJson(statePath);
    assert.equal(persistedState.sessionId, scopeId);
    assert.equal(persistedState.fingerprint, fingerprintMessages(secondMessages));
  } finally {
    await mock.close();
  }
});

test("writeback concurrency: same scope + same payload only commits once", async () => {
  const mock = await startMockOmniServer({
    handlers: {
      async ingest() {
        await wait(250);
        return undefined;
      },
    },
  });
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-writeback-duplicate-"));
  const statePath = path.join(workspaceDir, "duplicate-state.json");
  const config = resolveOmniCommonConfig({
    apiKey: "test-key",
    baseUrl: mock.baseUrl,
    timeoutMs: 5_000,
  });
  const scopeId = "agent:main:test:writeback-duplicate";
  const duplicateMessages = [
    {
      role: "user",
      text: "duplicate concurrent payload",
      timestampIso: "2026-03-21T08:05:00.000Z",
    },
  ];

  try {
    const [first, second] = await Promise.all([
      ingestMessages({
        config,
        sessionKey: scopeId,
        messages: duplicateMessages,
        statePath,
      }),
      ingestMessages({
        config,
        sessionKey: scopeId,
        messages: duplicateMessages,
        statePath,
      }),
    ]);

    assert.equal(mock.state.ingestRequests.length, 1);
    assert.deepEqual(
      [first, second].map((result) => result.skipped),
      [false, true],
    );
    assert.equal(
      [first, second].filter((result) => result.reason === "duplicate").length,
      1,
      "expected exactly one duplicate short-circuit result",
    );

    const persistedState = await readJson(statePath);
    assert.equal(persistedState.sessionId, scopeId);
    assert.equal(persistedState.fingerprint, fingerprintMessages(duplicateMessages));
  } finally {
    await mock.close();
  }
});
