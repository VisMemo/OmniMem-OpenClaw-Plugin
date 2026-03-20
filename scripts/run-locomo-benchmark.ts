import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { clearConfigCache, loadConfig } from "../../openclaw/src/config/config.ts";
import { runEmbeddedPiAgent } from "../../openclaw/src/agents/pi-embedded.ts";
import { resolveDefaultModelForAgent } from "../../openclaw/src/agents/model-selection.ts";
import { runTasksWithConcurrency } from "../../openclaw/src/utils/run-with-concurrency.ts";
import {
  callOpenRouterBinaryJudge,
} from "../../Openclaw_OmniMem/benchmarks/locomo_l3/scripts/lib/judge.ts";
import type {
  JudgedQaResultRecord,
  LocomoConversationFixture,
  QaResultRecord,
} from "../../Openclaw_OmniMem/benchmarks/locomo_l3/scripts/lib/types.ts";
import { ingestMessages } from "../src/runtime/omni-client.js";
import { resolveOmniCommonConfig } from "../src/runtime/config.js";

type CliArgs = {
  fixture?: string;
  outDir?: string;
  questionLimit?: number;
  questionIds?: string[];
  modelRef?: string;
  recallScope?: "global" | "agent" | "session";
  ingestScope?: "global" | "agent" | "session";
  noJudge?: boolean;
  timeoutMs?: number;
  omniTimeoutMs?: number;
  concurrency?: number;
  judgeConcurrency?: number;
  baseUrl?: string;
};

type OpenClawConfig = ReturnType<typeof loadConfig>;

function logProgress(message: string) {
  process.stderr.write(`[locomo-benchmark] ${message}\n`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--fixture" && next) {
      args.fixture = next;
      index += 1;
    } else if (token === "--out-dir" && next) {
      args.outDir = next;
      index += 1;
    } else if (token === "--question-limit" && next) {
      args.questionLimit = Number.parseInt(next, 10);
      index += 1;
    } else if (token === "--question-ids" && next) {
      args.questionIds = next
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
    } else if (token === "--model-ref" && next) {
      args.modelRef = next;
      index += 1;
    } else if (token === "--recall-scope" && next) {
      if (next === "global" || next === "agent" || next === "session") {
        args.recallScope = next;
      }
      index += 1;
    } else if (token === "--ingest-scope" && next) {
      if (next === "global" || next === "agent" || next === "session") {
        args.ingestScope = next;
      }
      index += 1;
    } else if (token === "--timeout-ms" && next) {
      args.timeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else if (token === "--omni-timeout-ms" && next) {
      args.omniTimeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else if (token === "--concurrency" && next) {
      args.concurrency = Number.parseInt(next, 10);
      index += 1;
    } else if (token === "--judge-concurrency" && next) {
      args.judgeConcurrency = Number.parseInt(next, 10);
      index += 1;
    } else if (token === "--base-url" && next) {
      args.baseUrl = next;
      index += 1;
    } else if (token === "--no-judge") {
      args.noJudge = true;
    }
  }
  return args;
}

function requireArg(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value.trim();
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function extractAnswerText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  const errorPayload = payloads?.find((payload) => payload.isError && payload.text?.trim());
  if (errorPayload?.text) {
    throw new Error(errorPayload.text);
  }
  return (payloads ?? [])
    .map((payload) => payload.text?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n\n")
    .trim();
}

function usageField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function withBenchmarkQaAgentConfig(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  modelRef: string;
}): OpenClawConfig {
  const workspaceDir = path.resolve(params.workspaceDir);
  const allow = ["read", "memory_search", "memory_get"];
  const defaults = params.cfg.agents?.defaults ?? {};
  return {
    ...params.cfg,
    agents: {
      ...(params.cfg.agents ?? {}),
      defaults: {
        ...defaults,
        workspace: workspaceDir,
        model: {
          ...(defaults.model ?? {}),
          primary: params.modelRef,
        },
        models: {
          ...(defaults.models ?? {}),
          [params.modelRef]: {
            alias: "LoCoMo Benchmark Model",
          },
        },
        tools: {
          ...(defaults.tools ?? {}),
          allow,
        },
      },
    },
  };
}

function pickQuestions(fixture: LocomoConversationFixture, args: CliArgs) {
  if (Array.isArray(args.questionIds) && args.questionIds.length > 0) {
    const selected = fixture.questions.filter((question) => args.questionIds?.includes(question.questionId));
    if (selected.length === 0) {
      throw new Error(`No questions matched --question-ids for fixture ${fixture.convId}`);
    }
    return selected;
  }
  if (typeof args.questionLimit === "number" && Number.isFinite(args.questionLimit)) {
    return fixture.questions.slice(0, normalizePositiveInteger(args.questionLimit, fixture.questions.length));
  }
  return fixture.questions;
}

function buildTemporaryConfig(params: {
  workspaceDir: string;
  pluginPath: string;
  recallScope: "global" | "agent" | "session";
  ingestScope: "global" | "agent" | "session";
  omniTimeoutMs: number;
  baseUrl: string;
  modelRef: string;
  openRouterModelId: string;
}) {
  return {
    models: {
      mode: "merge",
      providers: {
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "${OPENROUTER_API_KEY}",
          api: "openai-completions",
          models: [
            {
              id: params.openRouterModelId,
              name: params.openRouterModelId,
              reasoning: true,
              input: ["text"],
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              contextWindow: 256000,
              maxTokens: 16384,
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: params.modelRef,
        },
        models: {
          [params.modelRef]: {
            alias: "LoCoMo Benchmark Model",
          },
        },
        workspace: params.workspaceDir,
        compaction: {
          mode: "safeguard",
        },
      },
    },
    gateway: {
      mode: "local",
      auth: {
        mode: "token",
        token: "locomo-benchmark-local-token",
      },
    },
    plugins: {
      enabled: true,
      load: {
        paths: [params.pluginPath],
      },
      slots: {
        memory: "omnimemory-memory",
      },
      entries: {
        "omnimemory-memory": {
          enabled: true,
          config: {
            apiKey: "${OMNI_MEMORY_API_KEY}",
            baseUrl: params.baseUrl,
            failSilent: false,
            autoCapture: false,
            suppressLocalMemoryBootstrap: true,
            recallScope: params.recallScope,
            ingestScope: params.ingestScope,
            timeoutMs: params.omniTimeoutMs,
          },
        },
      },
    },
  };
}

function summarizeJudgedResults(records: JudgedQaResultRecord[]) {
  const correct = records.filter((record) => record.judgeLabel === "CORRECT").length;
  const wrong = records.length - correct;
  return {
    total: records.length,
    correct,
    wrong,
    accuracy: records.length > 0 ? correct / records.length : 0,
  };
}

function resolveOpenRouterModelId(modelRef: string): string {
  const trimmed = modelRef.trim();
  if (!trimmed.toLowerCase().startsWith("openrouter/")) {
    throw new Error(`Only openrouter/* model refs are supported right now, got: ${modelRef}`);
  }
  return trimmed.slice("openrouter/".length);
}

async function runQaQuestion(params: {
  question: LocomoConversationFixture["questions"][number];
  fixture: LocomoConversationFixture;
  workspaceDir: string;
  config: OpenClawConfig;
  modelRef: string;
  timeoutMs: number;
  sessionNamespace: string;
}): Promise<QaResultRecord> {
  logProgress(`running QA ${params.question.questionId}`);
  const effectiveConfig = withBenchmarkQaAgentConfig({
    cfg: params.config,
    workspaceDir: params.workspaceDir,
    modelRef: params.modelRef,
  });
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: effectiveConfig,
    agentId: "main",
  });
  const sessionFile = path.join(
    params.workspaceDir,
    ".locomo-benchmark",
    "qa",
    `${params.question.questionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });

  const startedAt = Date.now();
  try {
    const result = await runEmbeddedPiAgent({
      sessionId: params.sessionNamespace,
      sessionKey: params.sessionNamespace,
      agentId: "main",
      trigger: "user",
      sessionFile,
      workspaceDir: params.workspaceDir,
      config: effectiveConfig,
      prompt: params.question.question,
      provider: defaultModelRef.provider,
      model: defaultModelRef.model,
      timeoutMs: params.timeoutMs,
      runId: randomUUID(),
      disableMessageTool: true,
      suppressToolErrorWarnings: true,
    });
    const usage = result.meta?.agentMeta?.lastCallUsage ?? result.meta?.agentMeta?.usage;
    const record: QaResultRecord = {
      variant: "omni",
      convId: params.fixture.convId,
      checkpointId: "cp-final",
      questionId: params.question.questionId,
      question: params.question.question,
      expectedAnswer: params.question.expectedAnswer,
      aiResponse: extractAnswerText(result.payloads),
      labels: params.question.labels,
      evidence: params.question.evidence,
      qaDurationMs: Date.now() - startedAt,
      qaPromptTokens: usageField(usage?.input),
      qaCompletionTokens: usageField(usage?.output),
      qaTotalTokens: usageField(usage?.total),
    };
    logProgress(`completed QA ${params.question.questionId}`);
    return record;
  } catch (error) {
    const record: QaResultRecord = {
      variant: "omni",
      convId: params.fixture.convId,
      checkpointId: "cp-final",
      questionId: params.question.questionId,
      question: params.question.question,
      expectedAnswer: params.question.expectedAnswer,
      aiResponse: `[ERROR] ${error instanceof Error ? error.message : String(error)}`,
      labels: params.question.labels,
      evidence: params.question.evidence,
      qaDurationMs: Date.now() - startedAt,
    };
    logProgress(`QA ${params.question.questionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    return record;
  }
}

function isRetryableJudgeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit|429|timeout|temporarily unavailable|overloaded/i.test(message);
}

async function judgeRecordWithRetries(
  record: QaResultRecord,
  apiKey: string,
): Promise<JudgedQaResultRecord> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callOpenRouterBinaryJudge(record, {
        apiKey,
        model: "openai/gpt-4o-mini",
        title: "OmniMem OpenClaw Plugin LoCoMo Benchmark",
      });
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableJudgeError(error)) {
        throw error;
      }
      await sleep(3000 * attempt);
    }
  }
  throw new Error(`Judge failed for ${record.questionId}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturePath = path.resolve(
    requireArg(
      args.fixture,
      "--fixture",
    ),
  );
  const outDir = path.resolve(
    args.outDir ??
      path.join(
        "/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin",
        "outputs",
        "locomo-benchmark",
        `run-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      ),
  );
  const modelRef = args.modelRef?.trim() || "openrouter/openai/gpt-4o-mini";
  const openRouterModelId = resolveOpenRouterModelId(modelRef);
  const recallScope = args.recallScope ?? "session";
  const ingestScope = args.ingestScope ?? "session";
  const timeoutMs = normalizePositiveInteger(args.timeoutMs, 240000);
  const omniTimeoutMs = normalizePositiveInteger(args.omniTimeoutMs, 600000);
  const concurrency = normalizePositiveInteger(args.concurrency, 1);
  const judgeConcurrency = normalizePositiveInteger(args.judgeConcurrency, concurrency);
  const baseUrl = args.baseUrl?.trim() || "https://zdfdulpnyaci.sealoshzh.site/api/v1/memory";
  const pluginPath = path.resolve(
    "/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/plugins/omnimemory-memory",
  );

  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as LocomoConversationFixture;
  const selectedQuestions = pickQuestions(fixture, args);
  const sessionNamespace = `agent:main:locomo:${fixture.convId}:plugin-benchmark:${Date.now()}`;
  const workspaceDir = path.join(outDir, "workspace", fixture.convId);
  const configPath = path.join(outDir, "openclaw.locomo.benchmark.json");
  const qaOut = path.join(outDir, "qa.json");
  const judgedOut = path.join(outDir, "judged.json");
  const summaryOut = path.join(outDir, "summary.json");
  const ingestStatePath = path.join(outDir, ".omni-ingest-state.json");

  if (!process.env.OMNI_MEMORY_API_KEY?.trim()) {
    throw new Error("Missing OMNI_MEMORY_API_KEY");
  }
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      buildTemporaryConfig({
        workspaceDir,
        pluginPath,
        recallScope,
        ingestScope,
        omniTimeoutMs,
        baseUrl,
        modelRef,
        openRouterModelId,
      }),
      null,
      2,
    )}\n`,
    "utf8",
  );

  logProgress(`loaded fixture ${fixture.convId} with ${fixture.turns.length} turns and ${selectedQuestions.length} QA questions`);
  logProgress(`ingesting benchmark memory state into Omni session ${sessionNamespace}`);
  const omniConfig = resolveOmniCommonConfig(
    {
      apiKey: "${OMNI_MEMORY_API_KEY}",
      baseUrl,
      failSilent: false,
      timeoutMs: omniTimeoutMs,
      recallScope,
      ingestScope,
    },
    process.env,
  );

  const ingestResult = await ingestMessages({
    config: omniConfig,
    sessionId: sessionNamespace,
    sessionKey: sessionNamespace,
    messages: fixture.turns.map((turn) => ({
      role: turn.role,
      text: turn.content,
      name: turn.speaker,
      timestampIso: turn.timestamp,
    })),
    statePath: ingestStatePath,
    wait: true,
  });
  logProgress(
    `ingest complete: committedTurns=${ingestResult.committedTurns ?? 0} sessionId=${ingestResult.sessionId ?? sessionNamespace}`,
  );

  process.env.OPENCLAW_CONFIG_PATH = configPath;
  clearConfigCache();
  const baseConfig = loadConfig();
  logProgress(`loaded OpenClaw config from ${configPath}`);

  const qaTaskResult = await runTasksWithConcurrency({
    tasks: selectedQuestions.map((question) => async () =>
      runQaQuestion({
        question,
        fixture,
        workspaceDir,
        config: baseConfig,
        modelRef,
        timeoutMs,
        sessionNamespace,
      })),
    limit: concurrency,
    errorMode: "continue",
  });
  if (qaTaskResult.hasError && qaTaskResult.firstError) {
    throw qaTaskResult.firstError;
  }
  const qaRecords = qaTaskResult.results.filter((record): record is QaResultRecord => Boolean(record));

  await fs.writeFile(qaOut, `${JSON.stringify(qaRecords, null, 2)}\n`, "utf8");
  logProgress(`wrote QA output to ${qaOut}`);

  let judgedRecords: JudgedQaResultRecord[] | null = null;
  if (!args.noJudge) {
    const judgeTaskResult = await runTasksWithConcurrency({
      tasks: qaRecords.map((record) => async () => {
        logProgress(`judging ${record.questionId}`);
        return await judgeRecordWithRetries(record, process.env.OPENROUTER_API_KEY!);
      }),
      limit: judgeConcurrency,
      errorMode: "continue",
    });
    if (judgeTaskResult.hasError && judgeTaskResult.firstError) {
      throw judgeTaskResult.firstError;
    }
    judgedRecords = judgeTaskResult.results.filter(
      (record): record is JudgedQaResultRecord => Boolean(record),
    );
    await fs.writeFile(judgedOut, `${JSON.stringify(judgedRecords, null, 2)}\n`, "utf8");
    logProgress(`wrote judged output to ${judgedOut}`);
  }

  const summary = {
    fixture: fixturePath,
    convId: fixture.convId,
    sessionNamespace,
    modelRef,
    recallScope,
    ingestScope,
    concurrency,
    judgeConcurrency: judgedRecords ? judgeConcurrency : null,
    turnCount: fixture.turns.length,
    questionCount: qaRecords.length,
    ingestResult,
    qaOutput: qaOut,
    judgedOutput: judgedRecords ? judgedOut : null,
    judgedSummary: judgedRecords ? summarizeJudgedResults(judgedRecords) : null,
  };
  await fs.writeFile(summaryOut, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  logProgress(`wrote summary to ${summaryOut}`);

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
