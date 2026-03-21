import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

import { startMockOmniServer } from "../scripts/lib/mock-omni-server.mjs";
import { startMockOpenAiResponsesServer } from "../scripts/lib/mock-openai-responses-server.mjs";
import {
  startOpenClawGatewayForMemoryHookSmoke,
  startOpenClawGatewayForOverlayHookSmoke,
} from "../scripts/lib/openclaw-smoke.mjs";
import { buildMemoryPluginGuidance } from "../plugins/omnimemory-memory/runtime/prompt-composer.js";

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

async function createLlmInputRecorderPlugin(outputPath) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnimem-llm-input-recorder-"));
  await writeFile(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: "omnimemory-test-llm-input-recorder",
        name: "OmniMemory Test LLM Input Recorder",
        description: "Writes llm_input hook payloads to disk for prompt verification.",
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
      '  id: "omnimemory-test-llm-input-recorder",',
      '  name: "OmniMemory Test LLM Input Recorder",',
      "  register(api) {",
      '    api.on("llm_input", async (event, ctx) => {',
      '      const outputPath = api.pluginConfig?.outputPath;',
      '      if (!outputPath) {',
      "        return;",
      "      }",
      "      await writeFile(",
      "        outputPath,",
      "        JSON.stringify({ event, ctx }, null, 2),",
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

function buildMockModelsConfig(baseUrl, { providerId = "mock", modelId = "gpt-test" } = {}) {
  return {
    mode: "replace",
    providers: {
      [providerId]: {
        baseUrl,
        apiKey: "test-model-key",
        api: "openai-responses",
        models: [
          {
            id: modelId,
            name: modelId,
            api: "openai-responses",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
      },
    },
  };
}

async function readJsonWhenPresent(filePath) {
  await waitFor(
    async () => {
      try {
        await access(filePath, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    { message: `expected file to exist: ${filePath}` },
  );
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to resolve free port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

test("prompt injection e2e: overlay recall block reaches final prompt", async () => {
  const recallMarker = "Overlay recall marker 2026-03-21";
  const mockOmni = await startMockOmniServer({
    fixtures: {
      retrievalItems: [
        {
          text: recallMarker,
          score: 0.99,
          timestamp: "2026-03-21T12:00:00Z",
          source: "dialog",
          tkg_event_id: "evt_overlay_prompt_marker",
          entities: [],
        },
      ],
      explainEvents: {},
      entityResolutions: {},
      entityTimelines: {},
    },
  });
  const mockModel = await startMockOpenAiResponsesServer({ responseText: "overlay-prompt-ok" });
  const gatewayPort = await getFreePort();
  const tracePath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "omnimem-overlay-llm-trace-")),
    "llm-input.json",
  );
  const observerDir = await createLlmInputRecorderPlugin(tracePath);
  let gateway;

  try {
    gateway = await startOpenClawGatewayForOverlayHookSmoke({
      port: gatewayPort,
      token: "omnimem-overlay-prompt-token",
      hookToken: "omnimem-overlay-prompt-hook-token",
      baseUrl: mockOmni.baseUrl,
      modelRef: "mock/gpt-test",
      modelsConfig: buildMockModelsConfig(mockModel.baseUrl),
      extraPluginPaths: [observerDir],
      extraPluginEntries: {
        "omnimemory-test-llm-input-recorder": {
          enabled: true,
          config: { outputPath: tracePath },
        },
      },
      pluginConfig: {
        autoRecall: true,
        minPromptChars: 1,
        recallTopK: 5,
      },
    });

    await gateway.invokeHookAgent({
      message: "What do you remember about my earlier note?",
      sessionKey: "agent:main:prompt-injection:overlay",
      agentId: "main",
      name: "overlay-prompt-injection-check",
      timeoutSeconds: 5,
      idempotencyKey: "overlay-prompt-injection-check-1",
      deliver: false,
    });

    const trace = await readJsonWhenPresent(tracePath);
    assert.equal(mockModel.state.requests.length, 1);
    assert.match(trace?.event?.prompt || "", /<omnimemory-recall\b/);
    assert.match(trace?.event?.prompt || "", new RegExp(recallMarker));
    assert.match(
      trace?.event?.systemPrompt || "",
      /OmniMemory overlay is active for external long-term memory recall\./,
    );
  } finally {
    await gateway?.close();
    await mockModel.close();
    await mockOmni.close();
  }
});

test("prompt injection e2e: replacement guidance reaches final system prompt", async () => {
  const mockOmni = await startMockOmniServer();
  const mockModel = await startMockOpenAiResponsesServer({ responseText: "replacement-prompt-ok" });
  const gatewayPort = await getFreePort();
  const tracePath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "omnimem-replacement-llm-trace-")),
    "llm-input.json",
  );
  const observerDir = await createLlmInputRecorderPlugin(tracePath);
  let gateway;

  try {
    gateway = await startOpenClawGatewayForMemoryHookSmoke({
      port: gatewayPort,
      token: "omnimem-replacement-prompt-token",
      hookToken: "omnimem-replacement-prompt-hook-token",
      baseUrl: mockOmni.baseUrl,
      modelRef: "mock/gpt-test",
      modelsConfig: buildMockModelsConfig(mockModel.baseUrl),
      extraPluginPaths: [observerDir],
      extraPluginEntries: {
        "omnimemory-test-llm-input-recorder": {
          enabled: true,
          config: { outputPath: tracePath },
        },
      },
      pluginConfig: {
        autoCapture: false,
      },
    });

    await gateway.invokeHookAgent({
      message: "Please answer from your active memory provider.",
      sessionKey: "agent:main:prompt-injection:replacement",
      agentId: "main",
      name: "replacement-prompt-injection-check",
      timeoutSeconds: 5,
      idempotencyKey: "replacement-prompt-injection-check-1",
      deliver: false,
    });

    const trace = await readJsonWhenPresent(tracePath);
    assert.equal(mockModel.state.requests.length, 1);
    assert.match(trace?.event?.systemPrompt || "", /Active memory provider: OmniMemory\./);
    assert.match(trace?.event?.systemPrompt || "", /Use memory_search before answering questions/);
    assert.equal(
      trace?.event?.systemPrompt?.includes(buildMemoryPluginGuidance()),
      true,
      "replacement guidance should be appended into final system prompt",
    );
  } finally {
    await gateway?.close();
    await mockModel.close();
    await mockOmni.close();
  }
});
