import fs from "node:fs/promises";
import path from "node:path";

import { callOpenRouterBinaryJudge } from "../../Openclaw_OmniMem/benchmarks/locomo_l3/scripts/lib/judge.ts";
import { resolveOmniCommonConfig } from "../src/runtime/config.js";
import { ingestMessages } from "../src/runtime/omni-client.js";
import { startOpenClawGatewayForMemorySmoke } from "./lib/openclaw-smoke.mjs";

const DEFAULT_BASE_URL = "https://zdfdulpnyaci.sealoshzh.site/api/v1/memory";

function parseArgs(argv) {
  const options = {
    port: 18941,
    token: "omnimem-service-retrieval-benchmark-token",
    maxResults: 20,
    baseUrl: DEFAULT_BASE_URL,
    omniApiKeyEnv: "OMNI_MEMORY_API_KEY",
    judgeApiKeyEnv: "OPENROUTER_API_KEY",
    skipIngest: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--fixture") {
      options.fixture = args.shift();
      continue;
    }
    if (token === "--out-dir") {
      options.outDir = args.shift();
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
    if (token === "--base-url") {
      options.baseUrl = args.shift();
      continue;
    }
    if (token === "--max-results") {
      options.maxResults = Number(args.shift());
      continue;
    }
    if (token === "--answer-top-n") {
      options.answerTopN = Number(args.shift());
      continue;
    }
    if (token === "--session-namespace") {
      options.sessionNamespace = args.shift();
      continue;
    }
    if (token === "--skip-ingest") {
      options.skipIngest = true;
      continue;
    }
    if (token === "--omni-api-key-env") {
      options.omniApiKeyEnv = args.shift();
      continue;
    }
    if (token === "--judge-api-key-env") {
      options.judgeApiKeyEnv = args.shift();
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

function mean(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values, p) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function classifyFailure(record) {
  if (record.judgeLabel === "CORRECT") {
    return "correct";
  }
  if (record.resultCount === 0) {
    return "no_results";
  }
  if (String(record.aiResponse || "").startsWith("[ERROR]")) {
    return "execution_error";
  }
  if (/date|day|month|year|time/i.test(record.judgeReasoning || "")) {
    return "time_mismatch";
  }
  return "retrieval_miss";
}

function buildRetrievedAnswer(retrievedItems) {
  if (!Array.isArray(retrievedItems) || retrievedItems.length === 0) {
    return "[ERROR] retrieval returned no usable evidence";
  }
  return retrievedItems
    .map((item, index) => {
      const body = item?.text || item?.snippet || "";
      return `Evidence ${index + 1}:\n${body}`.trim();
    })
    .filter(Boolean)
    .join("\n\n");
}

function logProgress(message) {
  process.stderr.write(`[service-retrieval-benchmark] ${message}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixturePath = path.resolve(requireArg(options.fixture, "--fixture"));
  const outDir = path.resolve(requireArg(options.outDir, "--out-dir"));
  const omniApiKey = process.env[requireArg(options.omniApiKeyEnv, "--omni-api-key-env")];
  const judgeApiKey = process.env[requireArg(options.judgeApiKeyEnv, "--judge-api-key-env")];
  if (!omniApiKey?.trim()) {
    throw new Error(`Missing ${options.omniApiKeyEnv}`);
  }
  if (!judgeApiKey?.trim()) {
    throw new Error(`Missing ${options.judgeApiKeyEnv}`);
  }

  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const sessionNamespace = options.sessionNamespace?.trim()
    ? options.sessionNamespace.trim()
    : `agent:main:locomo:${fixture.convId}:service-retrieval:${Date.now()}`;
  const maxResults = normalizePositiveInteger(options.maxResults, 20);
  const answerTopN = normalizePositiveInteger(options.answerTopN, maxResults);
  const port = normalizePositiveInteger(options.port, 18941);

  const ingestStatePath = path.join(outDir, ".omni-ingest-state.json");
  const retrievalOut = path.join(outDir, "retrieval.json");
  const judgedOut = path.join(outDir, "judged.json");
  const reportOut = path.join(outDir, "report.json");

  await fs.mkdir(outDir, { recursive: true });

  const omniConfig = resolveOmniCommonConfig(
    {
      apiKey: omniApiKey,
      baseUrl: options.baseUrl || DEFAULT_BASE_URL,
      failSilent: false,
      timeoutMs: 600000,
      recallScope: "session",
      ingestScope: "session",
    },
    process.env,
  );

  let ingestResult;
  let ingestDurationMs = 0;
  if (options.skipIngest) {
    logProgress(`skipping ingest and reusing session ${sessionNamespace}`);
    ingestResult = {
      skipped: true,
      reason: "skip-ingest",
      sessionId: sessionNamespace,
      committedTurns: 0,
      jobId: null,
    };
  } else {
    logProgress(`ingesting ${fixture.turns.length} turns into session ${sessionNamespace}`);
    const ingestStartedAt = Date.now();
    ingestResult = await ingestMessages({
      config: omniConfig,
      sessionKey: sessionNamespace,
      sessionId: sessionNamespace,
      messages: fixture.turns.map((turn) => ({
        role: turn.role,
        text: turn.content,
        name: turn.speaker,
        timestampIso: turn.timestamp,
      })),
      statePath: ingestStatePath,
      wait: true,
    });
    ingestDurationMs = Date.now() - ingestStartedAt;
  }

  logProgress("starting OpenClaw gateway");
  const gateway = await startOpenClawGatewayForMemorySmoke({
    port,
    token: requireArg(options.token, "--token"),
    baseUrl: options.baseUrl || DEFAULT_BASE_URL,
    pluginConfig: {
      apiKey: omniApiKey,
      failSilent: false,
      recallScope: "session",
      ingestScope: "session",
      autoCapture: false,
      timeoutMs: 30000,
    },
  });

  try {
    const retrievalRecords = [];
    const judgedRecords = [];

    for (const question of fixture.questions) {
      logProgress(`retrieving ${question.questionId}`);
      const searchStartedAt = Date.now();
      const search = await gateway.invokeTool({
        tool: "memory_search",
        args: { query: question.question, maxResults },
        sessionKey: sessionNamespace,
        sessionId: sessionNamespace,
      });
      const searchMs = Date.now() - searchStartedAt;
      const searchDetails = search?.result?.details || {};
      const results = Array.isArray(searchDetails.results) ? searchDetails.results : [];

      const retrievedItems = [];
      const getLatencies = [];
      for (const item of results.slice(0, answerTopN)) {
        if (!item?.path) {
          continue;
        }
        const getStartedAt = Date.now();
        const get = await gateway.invokeTool({
          tool: "memory_get",
          args: { path: item.path },
          sessionKey: sessionNamespace,
          sessionId: sessionNamespace,
        });
        getLatencies.push(Date.now() - getStartedAt);
        retrievedItems.push({
          path: item.path,
          score: item.score ?? null,
          snippet: item.snippet ?? null,
          text: get?.result?.details?.text || null,
        });
      }

      const aiResponse = buildRetrievedAnswer(retrievedItems);
      const qaRecord = {
        variant: "omni",
        convId: fixture.convId,
        checkpointId: "cp-final",
        questionId: question.questionId,
        question: question.question,
        expectedAnswer: question.expectedAnswer,
        aiResponse,
        labels: question.labels,
        evidence: question.evidence,
        qaDurationMs: searchMs + getLatencies.reduce((sum, value) => sum + value, 0),
      };

      const judged = await callOpenRouterBinaryJudge(qaRecord, {
        apiKey: judgeApiKey,
        model: "openai/gpt-4o-mini",
        title: "OmniMem OpenClaw Plugin Service Retrieval Benchmark",
      });

      const retrievalRecord = {
        questionId: question.questionId,
        question: question.question,
        expectedAnswer: question.expectedAnswer,
        searchMs,
        getLatencies,
        resultCount: results.length,
        topResults: results.slice(0, maxResults),
        retrievedItems,
        aiResponse,
      };

      retrievalRecords.push(retrievalRecord);
      judgedRecords.push({
        ...judged,
        searchMs,
        getLatencies,
        resultCount: results.length,
        failureKind: classifyFailure({ ...judged, resultCount: results.length }),
      });
    }

    await fs.writeFile(retrievalOut, `${JSON.stringify(retrievalRecords, null, 2)}\n`, "utf8");
    await fs.writeFile(judgedOut, `${JSON.stringify(judgedRecords, null, 2)}\n`, "utf8");

    const searchLatencies = retrievalRecords.map((record) => record.searchMs);
    const getLatencies = retrievalRecords.flatMap((record) => record.getLatencies);
    const correct = judgedRecords.filter((record) => record.judgeLabel === "CORRECT").length;
    const failureKinds = judgedRecords
      .filter((record) => record.judgeLabel !== "CORRECT")
      .reduce((accumulator, record) => {
        accumulator[record.failureKind] = (accumulator[record.failureKind] || 0) + 1;
        return accumulator;
      }, {});

    const report = {
      fixture: fixturePath,
      convId: fixture.convId,
      sessionNamespace,
      turnCount: fixture.turns.length,
      questionCount: fixture.questions.length,
      ingest: {
        ...ingestResult,
        durationMs: ingestDurationMs,
      },
      retrieval: {
        maxResults,
        answerTopN,
        avgSearchMs: mean(searchLatencies),
        p50SearchMs: percentile(searchLatencies, 50),
        p95SearchMs: percentile(searchLatencies, 95),
        avgGetMs: mean(getLatencies),
        p50GetMs: percentile(getLatencies, 50),
        p95GetMs: percentile(getLatencies, 95),
      },
      judge: {
        total: judgedRecords.length,
        correct,
        wrong: judgedRecords.length - correct,
        accuracy: judgedRecords.length > 0 ? correct / judgedRecords.length : 0,
        failureKinds,
      },
      outputs: {
        retrieval: retrievalOut,
        judged: judgedOut,
      },
      failedQuestions: judgedRecords
        .filter((record) => record.judgeLabel !== "CORRECT")
        .map((record) => ({
          questionId: record.questionId,
          question: record.question,
          expectedAnswer: record.expectedAnswer,
          failureKind: record.failureKind,
          judgeReasoning: record.judgeReasoning,
          aiResponse: record.aiResponse,
        })),
    };

    await fs.writeFile(reportOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await gateway.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
