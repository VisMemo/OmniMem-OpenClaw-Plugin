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
const memoryPluginPath = path.join(pluginRoot, "plugins", "omnimemory-memory");

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

async function waitForGateway({ port, token, timeoutMs = 30_000 }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tool: "memory_search", args: {} }),
      });
      if (response.status === 400 || response.status === 404 || response.status === 200) {
        return;
      }
    } catch {
      // retry until timeout
    }
    await wait(400);
  }
  throw new Error(`gateway did not become ready on port ${port}`);
}

async function writeConfig({ port, token, baseUrl, stateDir }) {
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

export async function startOpenClawGatewayForMemorySmoke({ port, token, baseUrl }) {
  try {
    await access(path.join(openclawRoot, "node_modules"), constants.F_OK);
  } catch {
    throw new Error(
      `OpenClaw dependencies are not installed at ${openclawRoot}. Run \"pnpm install\" in the openclaw repo before the integration experiment.`,
    );
  }

  const stateDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-openclaw-state-"));
  const { dir: configDir, configPath } = await writeConfig({ port, token, baseUrl, stateDir });

  const child = spawn("pnpm", ["gateway:dev"], {
    cwd: openclawRoot,
    detached: true,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_SKIP_CHANNELS: "1",
      CLAWDBOT_SKIP_CHANNELS: "1",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

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
      `gateway failed to start: ${error instanceof Error ? error.message : String(error)}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }

  return {
    port,
    token,
    child,
    configPath,
    stateDir,
    getLogs() {
      return { stdout, stderr };
    },
    async invokeTool({ tool, args, sessionKey }) {
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
        throw new Error(`tool invoke failed: ${response.status} ${JSON.stringify(payload)}`);
      }
      return payload;
    },
    async close() {
      await terminateProcessTree(child);
      await rm(configDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}
