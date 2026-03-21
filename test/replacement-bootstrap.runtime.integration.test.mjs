import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startMockOmniServer } from "../scripts/lib/mock-omni-server.mjs";
import { startMockOpenAiResponsesServer } from "../scripts/lib/mock-openai-responses-server.mjs";
import {
  resetOpenClawBuildCache,
  startOpenClawGatewayForMemoryHookSmoke,
} from "../scripts/lib/openclaw-smoke.mjs";

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(import.meta.dirname, "..");
const openclawRoot = path.resolve(pluginRoot, "..", "openclaw");
const nodeBin = process.execPath;

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

async function applyReplacementPatch() {
  await execFileAsync(nodeBin, [path.join(pluginRoot, "scripts/openclaw-replacement-patch.mjs"), "apply", "--openclaw-root", openclawRoot], {
    env: process.env,
  });
  resetOpenClawBuildCache();
}

async function revertReplacementPatch() {
  await execFileAsync(
    nodeBin,
    [path.join(pluginRoot, "scripts/openclaw-replacement-patch.mjs"), "revert", "--openclaw-root", openclawRoot, "--force"],
    {
      env: process.env,
    },
  );
  resetOpenClawBuildCache();
}

async function runScenario({ suppressLocalMemoryBootstrap, workspaceDir, tracePath }) {
  const mockOmni = await startMockOmniServer();
  const mockModel = await startMockOpenAiResponsesServer({
    responseText: suppressLocalMemoryBootstrap ? "suppressed-ok" : "unsuppressed-ok",
  });
  const observerDir = await createLlmInputRecorderPlugin(tracePath);
  const port = await getFreePort();
  let gateway;

  try {
    gateway = await startOpenClawGatewayForMemoryHookSmoke({
      port,
      token: `omnimem-bootstrap-${suppressLocalMemoryBootstrap ? "suppress" : "keep"}-token`,
      hookToken: `omnimem-bootstrap-${suppressLocalMemoryBootstrap ? "suppress" : "keep"}-hook-token`,
      baseUrl: mockOmni.baseUrl,
      workspaceDir,
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
        suppressLocalMemoryBootstrap,
      },
    });

    await gateway.invokeHookAgent({
      message: "Summarize what is in active memory.",
      sessionKey: `agent:main:bootstrap:${suppressLocalMemoryBootstrap ? "suppress" : "keep"}`,
      agentId: "main",
      name: `bootstrap-${suppressLocalMemoryBootstrap ? "suppress" : "keep"}`,
      timeoutSeconds: 5,
      idempotencyKey: `bootstrap-${suppressLocalMemoryBootstrap ? "suppress" : "keep"}-${Date.now()}`,
      deliver: false,
    });

    await waitFor(async () => {
      try {
        const raw = await readFile(tracePath, "utf8");
        return Boolean(raw.trim());
      } catch {
        return false;
      }
    }, {
      message: `expected llm_input trace for suppressLocalMemoryBootstrap=${String(suppressLocalMemoryBootstrap)}\n${JSON.stringify(gateway.getLogs(), null, 2)}`,
    });

    return JSON.parse(await readFile(tracePath, "utf8"));
  } finally {
    await gateway?.close();
    await mockModel.close();
    await mockOmni.close();
  }
}

test("replacement bootstrap runtime: suppressLocalMemoryBootstrap removes local MEMORY.md from final system prompt", async () => {
  const marker = "replacement-bootstrap-memory-marker-2026-03-21";
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-bootstrap-workspace-"));
  const tracesDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-bootstrap-traces-"));
  const keepTrace = path.join(tracesDir, "keep.json");
  const suppressTrace = path.join(tracesDir, "suppress.json");

  await writeFile(path.join(workspaceDir, "MEMORY.md"), `# Memory\n${marker}\n`, "utf8");

  await applyReplacementPatch();
  try {
    const keepTracePayload = await runScenario({
      suppressLocalMemoryBootstrap: false,
      workspaceDir,
      tracePath: keepTrace,
    });
    const suppressTracePayload = await runScenario({
      suppressLocalMemoryBootstrap: true,
      workspaceDir,
      tracePath: suppressTrace,
    });

    const keepSystemPrompt = String(keepTracePayload?.event?.systemPrompt || "");
    const suppressSystemPrompt = String(suppressTracePayload?.event?.systemPrompt || "");

    assert.ok(
      keepSystemPrompt.includes(marker),
      "expected local MEMORY.md content to remain visible when suppression is disabled",
    );
    assert.ok(
      !suppressSystemPrompt.includes(marker),
      "expected local MEMORY.md content to be removed when suppression is enabled",
    );
  } finally {
    await revertReplacementPatch();
  }
});
