import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startMockOmniServer } from "./lib/mock-omni-server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const openclawRoot = path.resolve(pluginRoot, "..", "openclaw");
const manageScript = path.join(pluginRoot, "scripts", "omnimemory-manage.mjs");

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    mode: "replacement",
    port: 18920,
    token: "omnimem-standard-smoke-token",
    openclawRoot,
    pluginRoot,
    applyPatch: false,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--mode") {
      options.mode = args.shift();
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
    if (token === "--openclaw-root") {
      options.openclawRoot = path.resolve(args.shift());
      continue;
    }
    if (token === "--plugin-root") {
      options.pluginRoot = path.resolve(args.shift());
      continue;
    }
    if (token === "--apply-patch") {
      options.applyPatch = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  if (!["overlay", "replacement"].includes(options.mode)) {
    throw new Error("--mode must be overlay or replacement");
  }
  return options;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcessTree(child) {
  if (!child || typeof child.pid !== "number") {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await wait(600);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

function runNode(args, env) {
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: {
      ...env,
      NODE_NO_WARNINGS: "1",
    },
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0) {
    throw new Error(output || `node ${args.join(" ")} failed`);
  }
  return output;
}

function runOpenClaw(openclawDir, args, env, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [path.join(openclawDir, "openclaw.mjs"), ...args], {
    encoding: "utf8",
    env: {
      ...env,
      NODE_NO_WARNINGS: "1",
    },
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0 && !allowFailure) {
    throw new Error(output || `openclaw ${args.join(" ")} failed`);
  }
  return { ok: result.status === 0, output };
}

function parseMaybeJson(text, fallback = null) {
  if (!text || !text.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    const trimmed = text.trim();
    const ranges = [
      [trimmed.indexOf("{"), trimmed.lastIndexOf("}")],
      [trimmed.indexOf("["), trimmed.lastIndexOf("]")],
      [trimmed.lastIndexOf("\n{") + 1, trimmed.lastIndexOf("}")],
      [trimmed.lastIndexOf("\n[") + 1, trimmed.lastIndexOf("]")],
    ];
    for (const [start, end] of ranges) {
      if (start >= 0 && end >= start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
          // keep trying
        }
      }
    }
    return fallback;
  }
}

async function waitForGateway({ port, token, timeoutMs = 30_000 }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if ([200, 401].includes(response.status)) {
        return;
      }
    } catch {
      // retry
    }
    await wait(400);
  }
  throw new Error(`gateway did not become ready on port ${port}`);
}

async function startGateway({ openclawDir, env, port, token }) {
  const child = spawn(
    process.execPath,
    [
      path.join(openclawDir, "openclaw.mjs"),
      "gateway",
      "run",
      "--allow-unconfigured",
      "--bind",
      "loopback",
      "--port",
      String(port),
      "--auth",
      "token",
      "--token",
      token,
    ],
    {
      cwd: openclawDir,
      detached: true,
      env: {
        ...env,
        OPENCLAW_SKIP_CHANNELS: "1",
        CLAWDBOT_SKIP_CHANNELS: "1",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitForGateway({ port, token });
  } catch (error) {
    await terminateProcessTree(child);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }

  return {
    child,
    getLogs() {
      return { stdout, stderr };
    },
    async invokeTool(tool, args, sessionKey) {
      const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tool, args, sessionKey }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(`${response.status} ${JSON.stringify(payload)}`);
      }
      return payload;
    },
    async close() {
      await terminateProcessTree(child);
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omnimem-standard-smoke-"));
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: path.join(tempRoot, "openclaw.json"),
    OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
    OMNI_MEMORY_API_KEY: "qbk_smoke_test",
  };

  const mock = await startMockOmniServer();
  let gateway;
  try {
    runNode(
      [
        manageScript,
        "install",
        "--mode",
        options.mode,
        "--plugin-root",
        options.pluginRoot,
        "--openclaw-root",
        options.openclawRoot,
        "--base-url",
        mock.baseUrl,
        "--skip-restart",
        ...(options.applyPatch && options.mode === "replacement" ? ["--apply-patch"] : []),
      ],
      env,
    );

    runOpenClaw(options.openclawRoot, ["config", "set", "gateway.mode", "local"], env);
    runOpenClaw(options.openclawRoot, ["config", "set", "gateway.bind", "loopback"], env);
    runOpenClaw(
      options.openclawRoot,
      ["config", "set", "gateway.port", JSON.stringify(options.port), "--strict-json"],
      env,
    );
    runOpenClaw(options.openclawRoot, ["config", "set", "gateway.auth.mode", "token"], env);
    runOpenClaw(options.openclawRoot, ["config", "set", "gateway.auth.token", options.token], env);
    runOpenClaw(options.openclawRoot, ["config", "validate", "--json"], env);

    gateway = await startGateway({
      openclawDir: options.openclawRoot,
      env,
      port: options.port,
      token: options.token,
    });

    const pluginId = options.mode === "overlay" ? "omnimemory-overlay" : "omnimemory-memory";
    const info = parseMaybeJson(
      runOpenClaw(options.openclawRoot, ["plugins", "info", pluginId, "--json"], env).output,
    );
    if (!info) {
      throw new Error(`failed to parse plugin info for ${pluginId}`);
    }
    const slot = runOpenClaw(
      options.openclawRoot,
      ["config", "get", "plugins.slots.memory"],
      env,
      { allowFailure: true },
    ).output;

    let toolCheck = null;
    if (options.mode === "replacement") {
      const search = await gateway.invokeTool(
        "memory_search",
        { query: "What did Caroline mention about the support group?", maxResults: 3 },
        "agent:main:standard-smoke:memory",
      );
      const pathValue = search?.result?.details?.results?.[0]?.path;
      const get = await gateway.invokeTool(
        "memory_get",
        { path: pathValue },
        "agent:main:standard-smoke:memory",
      );
      toolCheck = {
        search,
        get,
      };
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: options.mode,
          plugin: {
            id: info.id,
            status: info.status,
            origin: info.origin,
            hookCount: info.hookCount,
            toolNames: info.toolNames,
            services: info.services,
          },
          slot,
          gateway: {
            reachable: true,
            port: options.port,
            authMode: "token",
          },
          toolCheck,
          mock: {
            retrievalRequests: mock.state.retrievalRequests.length,
            ingestRequests: mock.state.ingestRequests.length,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    if (gateway) {
      await gateway.close();
    }
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
