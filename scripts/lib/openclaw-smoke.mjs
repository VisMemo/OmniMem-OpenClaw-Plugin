import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "../..");
const workspaceRoot = path.resolve(pluginRoot, "..");
const openclawRoot = path.join(workspaceRoot, "openclaw");
const openclawCliPath = path.join(openclawRoot, "openclaw.mjs");
const openclawTsdownCliPath = path.join(openclawRoot, "node_modules", "tsdown", "dist", "run.mjs");
const memoryPluginPath = path.join(pluginRoot, "plugins", "omnimemory-memory");
const overlayPluginPath = path.join(pluginRoot, "plugins", "omnimemory-overlay");
let openClawBuildPromise;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcessTree(child) {
  if (!child || typeof child.pid !== "number") {
    return;
  }
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await wait(750);
  if (child.exitCode === null) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function waitForGateway({ port, token, timeoutMs = 60_000 }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.status === 200 || response.status === 401) {
        return;
      }
    } catch {
      // retry until timeout
    }
    await wait(400);
  }
  throw new Error(`gateway did not become ready on port ${port}`);
}

async function writeConfig({ port, token, baseUrl, stateDir, pluginConfig = {} }) {
  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
    },
    plugins: {
      enabled: true,
      load: {
        paths: [memoryPluginPath],
      },
      slots: {
        memory: "omnimemory-memory",
      },
      entries: {
        "omnimemory-memory": {
          enabled: true,
          config: {
            apiKey: "test-omni-key",
            baseUrl,
            failSilent: false,
            autoCapture: false,
            timeoutMs: 5000,
            ...pluginConfig,
          },
        },
      },
    },
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnimem-openclaw-config-"));
  const configPath = path.join(dir, "openclaw.mock.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return { dir, configPath };
}

async function writeOverlayConfig({
  port,
  token,
  hookToken,
  baseUrl,
  modelRef = "openai/gpt-5-mini",
  pluginConfig = {},
  extraPluginPaths = [],
  extraPluginEntries = {},
}) {
  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
    },
    hooks: {
      enabled: true,
      token: hookToken,
      allowRequestSessionKey: true,
    },
    plugins: {
      enabled: true,
      load: {
        paths: [...extraPluginPaths, overlayPluginPath],
      },
      entries: {
        ...extraPluginEntries,
        "omnimemory-overlay": {
          enabled: true,
          config: {
            apiKey: "test-omni-key",
            baseUrl,
            failSilent: false,
            autoRecall: true,
            autoCapture: true,
            timeoutMs: 5000,
            recallTopK: 20,
            minPromptChars: 1,
            captureRoles: ["user"],
            writeWait: true,
            ...pluginConfig,
          },
        },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: modelRef,
        },
        timeoutSeconds: 5,
      },
    },
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnimem-openclaw-overlay-config-"));
  const configPath = path.join(dir, "openclaw.overlay.mock.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return { dir, configPath };
}

function gatewayRunArgs({ port, token }) {
  return [
    openclawCliPath,
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
  ];
}

function gatewayRunEnv({ configPath, stateDir, extraEnv = {} }) {
  return {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_SKIP_CHANNELS: "1",
    CLAWDBOT_SKIP_CHANNELS: "1",
    NO_COLOR: "1",
    ...extraEnv,
  };
}

async function ensureOpenClawReady() {
  try {
    await access(openclawCliPath, constants.F_OK);
    await access(openclawTsdownCliPath, constants.F_OK);
    await access(path.join(openclawRoot, "node_modules"), constants.F_OK);
  } catch {
    throw new Error(
      `OpenClaw dependencies are not installed at ${openclawRoot}. Run \"pnpm install\" in the openclaw repo before the integration experiment.`,
    );
  }
}

async function ensureOpenClawBuilt() {
  openClawBuildPromise ??= (async () => {
    const child = spawn(
      process.execPath,
      [openclawTsdownCliPath, "--config-loader", "unrun", "--logLevel", "warn"],
      {
        cwd: openclawRoot,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const logs = attachChildLogs(child);
    const result = await new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    if (result.signal || result.code !== 0) {
      throw new Error(
        `OpenClaw build failed (code=${result.code ?? "null"} signal=${result.signal ?? "none"})\nSTDOUT:\n${logs.getLogs().stdout}\nSTDERR:\n${logs.getLogs().stderr}`,
      );
    }
  })();
  return openClawBuildPromise;
}

function attachChildLogs(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return {
    getLogs() {
      return { stdout, stderr };
    },
  };
}

async function startGatewayProcess({ port, token, configPath, stateDir, extraEnv = {} }) {
  const child = spawn(process.execPath, gatewayRunArgs({ port, token }), {
    cwd: openclawRoot,
    detached: true,
    env: gatewayRunEnv({
      configPath,
      stateDir,
      extraEnv,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = attachChildLogs(child);
  try {
    await waitForGateway({ port, token });
  } catch (error) {
    await terminateProcessTree(child);
    throw new Error(
      `gateway failed to start: ${error instanceof Error ? error.message : String(error)}\nSTDOUT:\n${logs.getLogs().stdout}\nSTDERR:\n${logs.getLogs().stderr}`,
    );
  }
  return { child, logs };
}

export async function startOpenClawGatewayForMemorySmoke({ port, token, baseUrl, pluginConfig }) {
  await ensureOpenClawReady();
  await ensureOpenClawBuilt();

  const stateDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-openclaw-state-"));
  const { dir: configDir, configPath } = await writeConfig({
    port,
    token,
    baseUrl,
    stateDir,
    pluginConfig,
  });

  const { child, logs } = await startGatewayProcess({
    port,
    token,
    configPath,
    stateDir,
  });

  return {
    port,
    token,
    child,
    configPath,
    stateDir,
    getLogs() {
      return logs.getLogs();
    },
    async invokeTool({ tool, args, sessionKey, sessionId }) {
      const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tool,
          args,
          sessionKey,
          sessionId,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(`tool invoke failed: ${response.status} ${JSON.stringify(payload)}`);
      }
      return payload;
    },
    async health() {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      return response.status;
    },
    async close() {
      await terminateProcessTree(child);
      await rm(configDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

export async function startOpenClawGatewayForOverlayHookSmoke({
  port,
  token,
  hookToken,
  baseUrl,
  modelRef,
  pluginConfig,
  extraPluginPaths,
  extraPluginEntries,
}) {
  await ensureOpenClawReady();
  await ensureOpenClawBuilt();

  const stateDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-openclaw-overlay-state-"));
  const { dir: configDir, configPath } = await writeOverlayConfig({
    port,
    token,
    hookToken,
    baseUrl,
    modelRef,
    pluginConfig,
    extraPluginPaths,
    extraPluginEntries,
  });

  const { child, logs } = await startGatewayProcess({
    port,
    token,
    configPath,
    stateDir,
    extraEnv: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || "sk-test-openclaw-smoke",
      NO_PROXY: process.env.NO_PROXY || "*",
      no_proxy: process.env.no_proxy || "*",
    },
  });

  return {
    port,
    token,
    hookToken,
    child,
    configPath,
    stateDir,
    getLogs() {
      return logs.getLogs();
    },
    async invokeHookAgent({
      message,
      sessionKey,
      agentId,
      name = "overlay-hook-smoke",
      timeoutSeconds = 5,
      idempotencyKey,
      deliver = false,
      wakeMode = "next-heartbeat",
    }) {
      const response = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${hookToken}`,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify({
          message,
          sessionKey,
          agentId,
          name,
          timeoutSeconds,
          deliver,
          wakeMode,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(`hook invoke failed: ${response.status} ${JSON.stringify(payload)}`);
      }
      return payload;
    },
    async health() {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      return response.status;
    },
    async close() {
      await terminateProcessTree(child);
      await rm(configDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}
