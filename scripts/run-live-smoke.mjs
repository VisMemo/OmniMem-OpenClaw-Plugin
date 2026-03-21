import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startMockOpenAiResponsesServer } from "./lib/mock-openai-responses-server.mjs";
import {
  startOpenClawGatewayForMemoryHookSmoke,
  startOpenClawGatewayForOverlayHookSmoke,
} from "./lib/openclaw-smoke.mjs";

const DEFAULT_BASE_URL = "https://zdfdulpnyaci.sealoshzh.site/api/v1/memory";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    mode: "overlay",
    baseUrl: DEFAULT_BASE_URL,
    apiKeyEnv: "OMNI_MEMORY_API_KEY",
    timeoutMs: 60_000,
    retryWindowMs: 30_000,
    pollIntervalMs: 3_000,
    maxResults: 20,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--mode") {
      options.mode = args.shift();
      continue;
    }
    if (token === "--base-url") {
      options.baseUrl = args.shift();
      continue;
    }
    if (token === "--api-key-env") {
      options.apiKeyEnv = args.shift();
      continue;
    }
    if (token === "--timeout-ms") {
      options.timeoutMs = Number(args.shift());
      continue;
    }
    if (token === "--retry-window-ms") {
      options.retryWindowMs = Number(args.shift());
      continue;
    }
    if (token === "--poll-interval-ms") {
      options.pollIntervalMs = Number(args.shift());
      continue;
    }
    if (token === "--max-results") {
      options.maxResults = Number(args.shift());
      continue;
    }
    if (token === "--out") {
      options.out = args.shift();
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  if (!["overlay", "replacement"].includes(options.mode)) {
    throw new Error("--mode must be overlay or replacement");
  }
  return options;
}

function normalizePositiveInteger(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizePositiveMs(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function buildMissingApiKeyError(envName) {
  return `Missing ${envName}. Export ${envName} with a real OmniMemory API key, or rerun with --api-key-env <NAME> if you keep the key in a different variable.`;
}

async function createLlmInputRecorderPlugin(outputPath) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnimem-live-llm-recorder-"));
  await writeFile(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: "omnimemory-live-llm-input-recorder",
        name: "OmniMemory Live LLM Input Recorder",
        description: "Appends llm_input hook payloads to jsonl for live smoke checks.",
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
      'import { appendFile } from "node:fs/promises";',
      "",
      "const plugin = {",
      '  id: "omnimemory-live-llm-input-recorder",',
      '  name: "OmniMemory Live LLM Input Recorder",',
      "  register(api) {",
      '    api.on("llm_input", async (event, ctx) => {',
      '      const outputPath = api.pluginConfig?.outputPath;',
      "      if (!outputPath) return;",
      "      await appendFile(outputPath, JSON.stringify({ event, ctx }) + '\\n', 'utf8');",
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

async function readJsonl(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
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

async function runOverlaySmoke(options) {
  const startedAt = Date.now();
  const apiKey = process.env[options.apiKeyEnv];
  if (!apiKey?.trim()) {
    throw new Error(buildMissingApiKeyError(options.apiKeyEnv));
  }

  const marker = `overlay-live-marker-${Date.now()}`;
  const sessionNamespace = `agent:main:live-overlay:${Date.now()}`;
  const tracePath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "omnimem-live-overlay-trace-")),
    "llm-input.jsonl",
  );
  const observerDir = await createLlmInputRecorderPlugin(tracePath);
  const mockModel = await startMockOpenAiResponsesServer({ responseText: "overlay-live-ok" });
  let gateway;

  try {
    gateway = await startOpenClawGatewayForOverlayHookSmoke({
      port: 18940,
      token: "omnimem-live-overlay-token",
      hookToken: "omnimem-live-overlay-hook-token",
      baseUrl: options.baseUrl,
      modelRef: "mock/gpt-test",
      modelsConfig: buildMockModelsConfig(mockModel.baseUrl),
      extraPluginPaths: [observerDir],
      extraPluginEntries: {
        "omnimemory-live-llm-input-recorder": {
          enabled: true,
          config: { outputPath: tracePath },
        },
      },
      pluginConfig: {
        apiKey,
        autoRecall: true,
        autoCapture: true,
        failSilent: false,
        timeoutMs: 30_000,
        minPromptChars: 1,
      },
    });

    await gateway.invokeHookAgent({
      message: `Please remember this exact live smoke marker: ${marker}`,
      sessionKey: sessionNamespace,
      agentId: "main",
      name: "overlay-live-smoke-capture",
      timeoutSeconds: 5,
      idempotencyKey: `overlay-live-capture-${Date.now()}`,
      deliver: false,
    });

    await wait(2_000);

    const retryDeadline = Date.now() + normalizePositiveMs(options.retryWindowMs, 30_000);
    let attempts = 0;
    let latestTrace = null;
    while (Date.now() < retryDeadline) {
      attempts += 1;
      const beforeCount = (await readJsonl(tracePath)).length;
      await gateway.invokeHookAgent({
        message: `What exact live smoke marker did I ask you to remember? ${marker}`,
        sessionKey: sessionNamespace,
        agentId: "main",
        name: "overlay-live-smoke-recall",
        timeoutSeconds: 5,
        idempotencyKey: `overlay-live-recall-${attempts}-${Date.now()}`,
        deliver: false,
      });
      const waitUntil = Date.now() + 12_000;
      while (Date.now() < waitUntil) {
        const events = await readJsonl(tracePath);
        if (events.length > beforeCount) {
          latestTrace = events.at(-1);
          break;
        }
        await wait(400);
      }
      if (String(latestTrace?.event?.prompt || "").includes(marker)) {
        const summary = {
          ok: true,
          mode: "overlay",
          marker,
          sessionNamespace,
          attempts,
          totalMs: Date.now() - startedAt,
          ingestVerified: true,
          retrievalVerified: true,
          gatewayCouplingVerified: true,
          trace: latestTrace,
        };
        return summary;
      }
      await wait(normalizePositiveMs(options.pollIntervalMs, 3_000));
    }

    return {
      ok: false,
      mode: "overlay",
      marker,
      sessionNamespace,
      attempts,
      totalMs: Date.now() - startedAt,
      ingestVerified: true,
      retrievalVerified: false,
      gatewayCouplingVerified: false,
      trace: latestTrace,
      reason: "marker did not reappear in the final overlay prompt within the retry window",
    };
  } finally {
    await gateway?.close();
    await mockModel.close();
  }
}

async function runReplacementSmoke(options) {
  const startedAt = Date.now();
  const apiKey = process.env[options.apiKeyEnv];
  if (!apiKey?.trim()) {
    throw new Error(buildMissingApiKeyError(options.apiKeyEnv));
  }

  const marker = `replacement-live-marker-${Date.now()}`;
  const sessionNamespace = `agent:main:live-replacement:${Date.now()}`;
  const searchQuery = `Please remember this exact live smoke marker ${marker}`;
  const mockModel = await startMockOpenAiResponsesServer({ responseText: "replacement-live-ok" });
  let gateway;

  try {
    gateway = await startOpenClawGatewayForMemoryHookSmoke({
      port: 18941,
      token: "omnimem-live-replacement-token",
      hookToken: "omnimem-live-replacement-hook-token",
      baseUrl: options.baseUrl,
      modelRef: "mock/gpt-test",
      modelsConfig: buildMockModelsConfig(mockModel.baseUrl),
      pluginConfig: {
        apiKey,
        autoCapture: true,
        failSilent: false,
        timeoutMs: 30_000,
        writeWait: true,
      },
    });

    await gateway.invokeHookAgent({
      message: `Please remember this exact live smoke marker: ${marker}`,
      sessionKey: sessionNamespace,
      agentId: "main",
      name: "replacement-live-smoke-capture",
      timeoutSeconds: 5,
      idempotencyKey: `replacement-live-capture-${Date.now()}`,
      deliver: false,
    });

    await wait(2_000);

    const retryDeadline = Date.now() + normalizePositiveMs(options.retryWindowMs, 30_000);
    let attempts = 0;
    let matchedResult = null;
    let fetchedText = null;
    let lastResults = [];
    let checkedPaths = [];
    while (Date.now() < retryDeadline) {
      attempts += 1;
      const search = await gateway.invokeTool({
        tool: "memory_search",
        args: {
          query: searchQuery,
          maxResults: normalizePositiveInteger(options.maxResults, 20),
        },
        sessionKey: sessionNamespace,
        sessionId: sessionNamespace,
      });
      const results = Array.isArray(search?.result?.details?.results) ? search.result.details.results : [];
      lastResults = results;
      checkedPaths = [];
      for (const entry of results) {
        if (!entry?.path) {
          continue;
        }
        checkedPaths.push(entry.path);
        const get = await gateway.invokeTool({
          tool: "memory_get",
          args: { path: entry.path },
          sessionKey: sessionNamespace,
          sessionId: sessionNamespace,
        });
        fetchedText = String(get?.result?.details?.text || "");
        if (fetchedText.includes(marker)) {
          matchedResult = entry;
          return {
            ok: true,
            mode: "replacement",
            marker,
            sessionNamespace,
            attempts,
            totalMs: Date.now() - startedAt,
            ingestVerified: true,
            retrievalVerified: true,
            gatewayCouplingVerified: true,
            matchedResult,
            fetchedText,
            checkedPaths,
          };
        }
      }
      await wait(normalizePositiveMs(options.pollIntervalMs, 3_000));
    }

    return {
      ok: false,
      mode: "replacement",
      marker,
      sessionNamespace,
      attempts,
      totalMs: Date.now() - startedAt,
      ingestVerified: true,
      retrievalVerified: false,
      gatewayCouplingVerified: true,
      matchedResult,
      fetchedText,
      searchQuery,
      lastResults,
      checkedPaths,
      reason: "marker did not appear in replacement memory_search/memory_get within the retry window",
    };
  } finally {
    await gateway?.close();
    await mockModel.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const timeoutMs = normalizePositiveMs(options.timeoutMs, 60_000);
  const runPromise =
    options.mode === "overlay" ? runOverlaySmoke(options) : runReplacementSmoke(options);

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`live smoke exceeded ${timeoutMs}ms`)), timeoutMs);
  });

  const result = await Promise.race([runPromise, timeoutPromise]);
  if (options.out) {
    const outPath = path.resolve(options.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
