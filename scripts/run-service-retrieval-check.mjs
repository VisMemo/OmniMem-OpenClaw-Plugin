import fs from "node:fs/promises";
import path from "node:path";

import { startOpenClawGatewayForMemorySmoke } from "./lib/openclaw-smoke.mjs";

const DEFAULT_BASE_URL = "https://zdfdulpnyaci.sealoshzh.site/api/v1/memory";

function parseArgs(argv) {
  const options = {
    port: 18931,
    token: "omnimem-retrieval-check-token",
    maxResults: 5,
    apiKeyEnv: "OMNI_MEMORY_API_KEY",
  };
  const args = [...argv];
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--summary-json") {
      options.summaryJson = args.shift();
      continue;
    }
    if (token === "--qa-json") {
      options.qaJson = args.shift();
      continue;
    }
    if (token === "--question-ids") {
      options.questionIds = (args.shift() || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      continue;
    }
    if (token === "--port") {
      options.port = Number(args.shift());
      continue;
    }
    if (token === "--token") {
      options.token = args.shift();
      continue;
    }
    if (token === "--max-results") {
      options.maxResults = Number(args.shift());
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
    if (token === "--out") {
      options.out = args.shift();
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return options;
}

function requireArg(value, name) {
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return String(value).trim();
}

function normalizePositiveInteger(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summaryPath = path.resolve(requireArg(options.summaryJson, "--summary-json"));
  const qaPath = path.resolve(requireArg(options.qaJson, "--qa-json"));
  const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  const qa = JSON.parse(await fs.readFile(qaPath, "utf8"));
  const sessionNamespace = requireArg(summary.sessionNamespace, "summary.sessionNamespace");
  const apiKeyEnv = requireArg(options.apiKeyEnv, "--api-key-env");
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey?.trim()) {
    throw new Error(`Missing ${apiKeyEnv}`);
  }

  const selectedQa = Array.isArray(options.questionIds) && options.questionIds.length > 0
    ? qa.filter((record) => options.questionIds.includes(record.questionId))
    : qa;
  if (!Array.isArray(selectedQa) || selectedQa.length === 0) {
    throw new Error("No QA records selected");
  }

  const gateway = await startOpenClawGatewayForMemorySmoke({
    port: normalizePositiveInteger(options.port, 18931),
    token: requireArg(options.token, "--token"),
    baseUrl: options.baseUrl || DEFAULT_BASE_URL,
    pluginConfig: {
      apiKey,
      failSilent: false,
      recallScope: "session",
      ingestScope: "session",
      timeoutMs: 30000,
    },
  });

  try {
    const records = [];
    for (const record of selectedQa) {
      const searchStartedAt = Date.now();
      const search = await gateway.invokeTool({
        tool: "memory_search",
        args: {
          query: record.question,
          maxResults: normalizePositiveInteger(options.maxResults, 5),
        },
        sessionKey: sessionNamespace,
        sessionId: sessionNamespace,
      });
      const searchMs = Date.now() - searchStartedAt;
      const results = Array.isArray(search?.result?.details?.results)
        ? search.result.details.results
        : [];
      const top = results[0] || null;

      let topText = null;
      let getMs = null;
      if (top?.path) {
        const getStartedAt = Date.now();
        const get = await gateway.invokeTool({
          tool: "memory_get",
          args: { path: top.path },
          sessionKey: sessionNamespace,
          sessionId: sessionNamespace,
        });
        getMs = Date.now() - getStartedAt;
        topText = get?.result?.details?.text || null;
      }

      records.push({
        questionId: record.questionId,
        question: record.question,
        expectedAnswer: record.expectedAnswer,
        searchMs,
        getMs,
        resultCount: results.length,
        topPath: top?.path || null,
        topScore: top?.score ?? null,
        topSnippet: top?.snippet || null,
        topText,
        topResults: results.slice(0, 3),
      });
    }

    const output = {
      summaryJson: summaryPath,
      qaJson: qaPath,
      sessionNamespace,
      convId: summary.convId || null,
      totalQuestions: records.length,
      records,
    };

    if (options.out) {
      const outPath = path.resolve(options.out);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    }

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await gateway.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
