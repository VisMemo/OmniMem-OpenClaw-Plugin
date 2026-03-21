import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
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
const requireFromOpenClaw = createRequire(path.join(openclawRoot, "package.json"));
const { WebSocket } = requireFromOpenClaw("ws");
let openClawBuildPromise;
const GATEWAY_PROTOCOL_VERSION = 3;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resetOpenClawBuildCache() {
  openClawBuildPromise = undefined;
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

async function writeConfig({
  port,
  token,
  baseUrl,
  stateDir,
  workspaceDir,
  pluginConfig = {},
  modelsConfig,
  extraPluginPaths = [],
  extraPluginEntries = {},
}) {
  const {
    hookToken,
    modelRef = "openai/gpt-5-mini",
    ...memoryPluginConfig
  } = pluginConfig;
  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
    },
    hooks: {
      enabled: true,
      token: hookToken || undefined,
      allowRequestSessionKey: true,
    },
    plugins: {
      enabled: true,
      load: {
        paths: [...extraPluginPaths, memoryPluginPath],
      },
      slots: {
        memory: "omnimemory-memory",
      },
      entries: {
        ...extraPluginEntries,
        "omnimemory-memory": {
          enabled: true,
          config: {
            apiKey: "test-omni-key",
            baseUrl,
            failSilent: false,
            autoCapture: false,
            timeoutMs: 5000,
            ...memoryPluginConfig,
          },
        },
      },
    },
    agents: {
      defaults: {
        ...(workspaceDir ? { workspace: workspaceDir } : {}),
        model: {
          primary: modelRef,
        },
        timeoutSeconds: 5,
      },
    },
    ...(modelsConfig ? { models: modelsConfig } : {}),
  };
  if (!hookToken) {
    delete config.hooks;
  }
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
  workspaceDir,
  modelRef = "openai/gpt-5-mini",
  pluginConfig = {},
  modelsConfig,
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
        ...(workspaceDir ? { workspace: workspaceDir } : {}),
        model: {
          primary: modelRef,
        },
        timeoutSeconds: 5,
      },
    },
    ...(modelsConfig ? { models: modelsConfig } : {}),
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
    NODE_DISABLE_COMPILE_CACHE: "1",
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

function base64UrlEncode(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" });
  if (
    Buffer.isBuffer(spki) &&
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return Buffer.isBuffer(spki) ? spki : Buffer.from(spki);
}

function createEphemeralDeviceIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const deviceId = crypto.createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
  return { deviceId, publicKeyPem, privateKeyPem };
}

function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(signature);
}

function buildDeviceAuthPayloadV3({
  deviceId,
  clientId,
  clientMode,
  role,
  scopes,
  signedAtMs,
  token,
  nonce,
  platform,
  deviceFamily,
}) {
  return [
    "v3",
    deviceId,
    clientId,
    clientMode,
    role,
    Array.isArray(scopes) ? scopes.join(",") : "",
    String(signedAtMs),
    token ?? "",
    nonce,
    platform ?? "",
    deviceFamily ?? "",
  ].join("|");
}

function createSessionHeader({ sessionId }) {
  return {
    type: "session",
    version: 1,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
}

function normalizeSeedMessage(message, index) {
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const normalized = { ...message };
    if (typeof normalized.content === "string") {
      normalized.content = [{ type: "text", text: normalized.content }];
    }
    if (!normalized.timestamp) {
      normalized.timestamp = new Date(Date.now() + index).toISOString();
    }
    return normalized;
  }
  return {
    role: "user",
    content: [{ type: "text", text: String(message ?? "") }],
    timestamp: new Date(Date.now() + index).toISOString(),
  };
}

async function seedGatewaySessions(stateDir, seedSessions = []) {
  for (const seed of seedSessions) {
    const agentId = typeof seed.agentId === "string" && seed.agentId.trim() ? seed.agentId.trim() : "main";
    const storeKey =
      typeof seed.storeKey === "string" && seed.storeKey.trim()
        ? seed.storeKey.trim()
        : `agent:${agentId}:${seed.sessionKey || "main"}`;
    const sessionId =
      typeof seed.sessionId === "string" && seed.sessionId.trim() ? seed.sessionId.trim() : `seed-${Date.now()}`;
    const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    const storePath = path.join(sessionsDir, "sessions.json");
    const messages = Array.isArray(seed.messages) ? seed.messages : [];
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      sessionFile,
      [JSON.stringify(createSessionHeader({ sessionId }))]
        .concat(
          messages.map((message, index) =>
            JSON.stringify({
              type: "message",
              message: normalizeSeedMessage(message, index),
            }),
          ),
        )
        .join("\n"),
      "utf8",
    );
    const entry = {
      sessionId,
      sessionFile,
      updatedAt: seed.updatedAt || Date.now(),
    };
    const aliases = Array.isArray(seed.aliases)
      ? seed.aliases.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)
      : [];
    const store = Object.fromEntries([storeKey, ...aliases].map((key) => [key, entry]));
    await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
  }
}

async function waitForWebSocketOpen(ws, timeoutMs = 10_000) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws open")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`ws closed ${code}: ${Buffer.from(reason || "").toString("utf8")}`));
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

function onceWsMessage(ws, filter, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws message")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`ws closed ${code}: ${Buffer.from(reason || "").toString("utf8")}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onMessage = (data) => {
      try {
        const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
        const obj = JSON.parse(text);
        if (filter(obj)) {
          cleanup();
          resolve(obj);
        }
      } catch {
        // ignore unrelated or malformed frames
      }
    };
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

async function openGatewayRpcClient({ port, token }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await waitForWebSocketOpen(ws);
  const challenge = await onceWsMessage(
    ws,
    (obj) => obj?.type === "event" && obj?.event === "connect.challenge",
    10_000,
  );
  const nonce = challenge?.payload?.nonce;
  if (typeof nonce !== "string" || !nonce.trim()) {
    throw new Error(`gateway ws connect challenge missing nonce: ${JSON.stringify(challenge)}`);
  }
  const client = {
    id: "cli",
    version: "1.0.0",
    platform: "test",
    mode: "cli",
  };
  const scopes = ["operator.admin"];
  const role = "operator";
  const identity = createEphemeralDeviceIdentity();
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId: client.id,
    clientMode: client.mode,
    role,
    scopes,
    signedAtMs,
    token,
    nonce,
    platform: client.platform,
    deviceFamily: undefined,
  });
  const connectId = `connect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ws.send(
    JSON.stringify({
      type: "req",
      id: connectId,
      method: "connect",
      params: {
        minProtocol: GATEWAY_PROTOCOL_VERSION,
        maxProtocol: GATEWAY_PROTOCOL_VERSION,
        client,
        caps: [],
        commands: [],
        role,
        scopes,
        auth: {
          token,
        },
        device: {
          id: identity.deviceId,
          publicKey: base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem)),
          signature: signDevicePayload(identity.privateKeyPem, payload),
          signedAt: signedAtMs,
          nonce,
        },
      },
    }),
  );
  const connectResponse = await onceWsMessage(
    ws,
    (obj) => obj?.type === "res" && obj?.id === connectId,
    10_000,
  );
  if (!connectResponse?.ok) {
    throw new Error(`gateway ws connect failed: ${JSON.stringify(connectResponse)}`);
  }
  return {
    ws,
    async request(method, params, timeoutMs = 10_000) {
      const id = `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      ws.send(JSON.stringify({ type: "req", id, method, params }));
      return await onceWsMessage(ws, (obj) => obj?.type === "res" && obj?.id === id, timeoutMs);
    },
    async close() {
      ws.close();
      await wait(50);
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

export async function startOpenClawGatewayForMemorySmoke({
  port,
  token,
  baseUrl,
  workspaceDir,
  pluginConfig,
  modelsConfig,
}) {
  await ensureOpenClawReady();
  await ensureOpenClawBuilt();

  const stateDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-openclaw-state-"));
  const { dir: configDir, configPath } = await writeConfig({
    port,
    token,
    baseUrl,
    stateDir,
    workspaceDir,
    pluginConfig,
    modelsConfig,
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

export async function startOpenClawGatewayForMemoryHookSmoke({
  port,
  token,
  hookToken,
  baseUrl,
  workspaceDir,
  modelRef,
  pluginConfig,
  modelsConfig,
  seedSessions = [],
  extraPluginPaths = [],
  extraPluginEntries = {},
}) {
  await ensureOpenClawReady();
  await ensureOpenClawBuilt();

  const stateDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-openclaw-memory-hook-state-"));
  await seedGatewaySessions(stateDir, seedSessions);
  const { dir: configDir, configPath } = await writeConfig({
    port,
    token,
    baseUrl,
    stateDir,
    workspaceDir,
    modelsConfig,
    extraPluginPaths,
    extraPluginEntries,
    pluginConfig: {
      autoCapture: true,
      hookToken,
      modelRef,
      ...pluginConfig,
    },
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
      name = "memory-hook-smoke",
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
    async openRpcClient() {
      return await openGatewayRpcClient({ port, token });
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
  workspaceDir,
  modelRef,
  pluginConfig,
  modelsConfig,
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
    workspaceDir,
    modelRef,
    modelsConfig,
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
