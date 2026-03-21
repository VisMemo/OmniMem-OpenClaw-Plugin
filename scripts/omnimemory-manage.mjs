import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigObject } from "./openclaw-config.mjs";
import {
  assertReplacementCompatibility,
  resolveReplacementCompatibility,
} from "./replacement-compatibility.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const defaultOpenClawRoot = path.resolve(pluginRoot, "..", "openclaw");
const defaultBaseUrl = "https://zdfdulpnyaci.sealoshzh.site/api/v1/memory";

const MODES = {
  overlay: {
    pluginId: "omnimemory-overlay",
    packageDir: path.join(pluginRoot, "plugins", "omnimemory-overlay"),
    defaultEntryConfig(apiKeyValue, baseUrl) {
      return {
        apiKey: apiKeyValue,
        baseUrl,
        autoRecall: true,
        autoCapture: true,
        captureStrategy: "last_turn",
        failSilent: true,
      };
    },
    inactivePluginId: "omnimemory-memory",
  },
  replacement: {
    pluginId: "omnimemory-memory",
    packageDir: path.join(pluginRoot, "plugins", "omnimemory-memory"),
    defaultEntryConfig(apiKeyValue, baseUrl) {
      return {
        apiKey: apiKeyValue,
        baseUrl,
        autoCapture: true,
        captureStrategy: "last_turn",
        suppressLocalMemoryBootstrap: true,
      };
    },
    inactivePluginId: "omnimemory-overlay",
  },
};
let pluginIdsCache = null;

function invalidatePluginCache() {
  pluginIdsCache = null;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = {
    command,
    mode: undefined,
    pluginRoot,
    openclawRoot: defaultOpenClawRoot,
    apiKeyEnv: "OMNI_MEMORY_API_KEY",
    apiKey: undefined,
    baseUrl: defaultBaseUrl,
    applyPatch: false,
    revertPatch: false,
    skipRestart: false,
    dryRun: false,
    keepFiles: false,
    force: true,
    link: false,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--mode") {
      options.mode = args.shift();
      continue;
    }
    if (token === "--plugin-root") {
      options.pluginRoot = path.resolve(args.shift());
      continue;
    }
    if (token === "--openclaw-root") {
      options.openclawRoot = path.resolve(args.shift());
      continue;
    }
    if (token === "--api-key-env") {
      options.apiKeyEnv = args.shift();
      continue;
    }
    if (token === "--api-key") {
      options.apiKey = args.shift();
      continue;
    }
    if (token === "--base-url") {
      options.baseUrl = args.shift();
      continue;
    }
    if (token === "--apply-patch") {
      options.applyPatch = true;
      continue;
    }
    if (token === "--revert-patch") {
      options.revertPatch = true;
      continue;
    }
    if (token === "--skip-restart") {
      options.skipRestart = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--keep-files") {
      options.keepFiles = true;
      continue;
    }
    if (token === "--link") {
      options.link = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  if (!["install", "switch", "uninstall", "rollback", "status", "smoke"].includes(options.command || "")) {
    throw new Error("command must be one of: install, switch, uninstall, rollback, status, smoke");
  }
  if (!["rollback", "status"].includes(options.command) && !options.mode) {
    throw new Error("--mode is required for this command");
  }
  if (options.mode && !Object.prototype.hasOwnProperty.call(MODES, options.mode)) {
    throw new Error("--mode must be overlay or replacement");
  }
  return options;
}

function commandExists(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  return result.status === 0;
}

function resolveOpenClawCommand(openclawRoot) {
  const distEntry = path.join(openclawRoot, "dist", "index.js");
  if (existsSync(distEntry)) {
    return {
      bin: "node",
      prefixArgs: [distEntry],
      label: `node ${distEntry}`,
    };
  }
  if (commandExists("openclaw")) {
    return { bin: "openclaw", prefixArgs: [], label: "openclaw" };
  }
  const packageJson = path.join(openclawRoot, "package.json");
  if (existsSync(packageJson) && commandExists("pnpm")) {
    return {
      bin: "pnpm",
      prefixArgs: ["--dir", openclawRoot, "--silent", "openclaw"],
      label: `pnpm --dir ${openclawRoot} --silent openclaw`,
    };
  }
  throw new Error("could not resolve OpenClaw CLI; install openclaw or provide a valid --openclaw-root");
}

function runCommand(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command.bin, [...command.prefixArgs, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
    },
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0 && !allowFailure) {
    throw new Error(output || `${command.label} ${args.join(" ")} failed`);
  }
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    output,
  };
}

function runNode(args, { allowFailure = false } = {}) {
  const result = spawnSync("node", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
    },
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0 && !allowFailure) {
    throw new Error(output || `node ${args.join(" ")} failed`);
  }
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    output,
  };
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
        const candidate = trimmed.slice(start, end + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // keep trying
        }
      }
    }
    return fallback;
  }
}

function resolveModeSpec(mode, rootDir) {
  const base = MODES[mode];
  const packageDir = path.join(rootDir, "plugins", base.pluginId);
  const manifestPath = path.join(packageDir, "openclaw.plugin.json");
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!existsSync(manifestPath) || !existsSync(packageJsonPath)) {
    throw new Error(`installable package is missing for ${mode}: ${packageDir}`);
  }
  return {
    ...base,
    packageDir,
    manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
    packageJson: JSON.parse(readFileSync(packageJsonPath, "utf8")),
  };
}

function writeConfigObject(configPath, config) {
  mkdirSync(path.dirname(configPath), { recursive: true });
  try {
    const current = readFileSync(configPath, "utf8");
    writeFileSync(`${configPath}.bak`, current, "utf8");
  } catch {
    // no-op when there is no existing config yet
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function getPluginInfo(command, pluginId) {
  const result = runCommand(command, ["plugins", "info", pluginId, "--json"], {
    allowFailure: true,
  });
  return {
    ok: result.ok,
    data: parseMaybeJson(result.output),
    output: result.output,
  };
}

function getDiscoveredPluginIds(command) {
  if (pluginIdsCache) {
    return pluginIdsCache;
  }
  const result = runCommand(command, ["plugins", "list", "--json"], { allowFailure: true });
  const payload = parseMaybeJson(result.output, {});
  const plugins = Array.isArray(payload?.plugins) ? payload.plugins : Array.isArray(payload) ? payload : [];
  pluginIdsCache = plugins
    .map((plugin) => (plugin && typeof plugin.id === "string" ? plugin.id : null))
    .filter(Boolean);
  return pluginIdsCache;
}

function pluginExists(command, pluginId) {
  return getDiscoveredPluginIds(command).includes(pluginId);
}

function formatStep(command, args) {
  return [command.label, ...args].join(" ");
}

function buildPatchArgs(options, action) {
  return [
    path.join(options.pluginRoot, "scripts", "openclaw-replacement-patch.mjs"),
    action,
    "--openclaw-root",
    options.openclawRoot,
  ];
}

function buildConfigMutationDescriptions(spec, options, inactiveExists) {
  const apiKeyValue = options.apiKey || `\${${options.apiKeyEnv}}`;
  const entryConfig = spec.defaultEntryConfig(apiKeyValue, options.baseUrl);
  const descriptions = [
    `patch config plugins.enabled=true`,
    `patch config plugins.entries.${spec.pluginId}.enabled=true`,
    `patch config plugins.entries.${spec.pluginId}.config=${JSON.stringify(entryConfig)}`,
    `patch config plugins.allow += ${spec.pluginId}`,
  ];
  if (options.mode === "overlay") {
    descriptions.push(`patch config plugins.slots.memory=memory-core`);
  } else {
    descriptions.push(`patch config plugins.slots.memory=omnimemory-memory`);
  }
  if (inactiveExists) {
    descriptions.push(`patch config plugins.entries.${spec.inactivePluginId}.enabled=false`);
  }
  return descriptions;
}

function buildInstallPlan(command, options, spec) {
  const steps = [];
  const inactiveExists = pluginExists(command, spec.inactivePluginId);
  if (!pluginExists(command, spec.pluginId)) {
    steps.push(formatStep(command, ["plugins", "install", ...(options.link ? ["--link"] : []), spec.packageDir]));
  }
  steps.push(...buildConfigMutationDescriptions(spec, options, inactiveExists));
  steps.push(formatStep(command, ["config", "validate", "--json"]));
  if (options.applyPatch && options.mode === "replacement") {
    steps.push(["node", ...buildPatchArgs(options, "apply")].join(" "));
  }
  if (options.revertPatch) {
    steps.push(["node", ...buildPatchArgs(options, "revert")].join(" "));
  }
  if (!options.skipRestart) {
    steps.push(formatStep(command, ["gateway", "restart"]));
  }
  steps.push(formatStep(command, ["plugins", "doctor"]));
  return steps;
}

function ensureReplacementCompatibility(openclawRoot, action) {
  return assertReplacementCompatibility(openclawRoot, action);
}

function applyModeConfig(spec, options) {
  const apiKeyValue = options.apiKey || `\${${options.apiKeyEnv}}`;
  const { configPath, config } = loadConfigObject(options.openclawRoot);
  const next = {
    ...(config && typeof config === "object" ? config : {}),
  };
  next.plugins = next.plugins && typeof next.plugins === "object" ? { ...next.plugins } : {};
  next.plugins.enabled = true;
  next.plugins.entries =
    next.plugins.entries && typeof next.plugins.entries === "object" ? { ...next.plugins.entries } : {};
  next.plugins.entries[spec.pluginId] = {
    ...(next.plugins.entries[spec.pluginId] && typeof next.plugins.entries[spec.pluginId] === "object"
      ? next.plugins.entries[spec.pluginId]
      : {}),
    enabled: true,
    config: spec.defaultEntryConfig(apiKeyValue, options.baseUrl),
  };
  if (next.plugins.entries[spec.inactivePluginId] && typeof next.plugins.entries[spec.inactivePluginId] === "object") {
    next.plugins.entries[spec.inactivePluginId] = {
      ...next.plugins.entries[spec.inactivePluginId],
      enabled: false,
    };
  }
  const allow = Array.isArray(next.plugins.allow) ? [...next.plugins.allow] : [];
  if (!allow.includes(spec.pluginId)) {
    allow.push(spec.pluginId);
  }
  next.plugins.allow = allow;
  next.plugins.slots =
    next.plugins.slots && typeof next.plugins.slots === "object" ? { ...next.plugins.slots } : {};
  next.plugins.slots.memory = options.mode === "overlay" ? "memory-core" : "omnimemory-memory";
  writeConfigObject(configPath, next);
}

function runInstallLike(command, options) {
  const spec = resolveModeSpec(options.mode, options.pluginRoot);
  const compatibility =
    options.mode === "replacement"
      ? ensureReplacementCompatibility(options.openclawRoot, "install")
      : null;
  const steps = buildInstallPlan(command, options, spec);
  if (options.dryRun) {
    return {
      ok: true,
      command: options.command,
      mode: options.mode,
      pluginId: spec.pluginId,
      packageDir: spec.packageDir,
      compatibility,
      steps,
    };
  }

  let install;
  if (!pluginExists(command, spec.pluginId)) {
    install = runCommand(command, ["plugins", "install", ...(options.link ? ["--link"] : []), spec.packageDir]);
    invalidatePluginCache();
  } else {
    install = { ok: true, output: "already installed" };
  }

  applyModeConfig(spec, options);
  const validation = runCommand(command, ["config", "validate", "--json"]);
  let patch = null;
  if (options.applyPatch && options.mode === "replacement") {
    patch = runNode(buildPatchArgs(options, "apply"));
  }
  if (options.revertPatch) {
    patch = runNode(buildPatchArgs(options, "revert"));
  }
  const restart = options.skipRestart
    ? null
    : runCommand(command, ["gateway", "restart"], { allowFailure: true });
  const doctor = runCommand(command, ["plugins", "doctor"], { allowFailure: true });
  return {
    ok: !(restart && !restart.ok),
    command: options.command,
    mode: options.mode,
    pluginId: spec.pluginId,
    packageDir: spec.packageDir,
    compatibility,
    install: { ok: install.ok, output: install.output },
    validation: parseMaybeJson(validation.output, { raw: validation.output }),
    patch: patch ? { ok: patch.ok, output: patch.output } : null,
    restart: restart ? { ok: restart.ok, output: restart.output } : null,
    doctor: { ok: doctor.ok, output: doctor.output },
  };
}

function runUninstall(command, options) {
  const targets =
    options.mode === "overlay"
      ? ["omnimemory-overlay"]
      : options.mode === "replacement"
        ? ["omnimemory-memory"]
        : ["omnimemory-overlay", "omnimemory-memory"];
  const steps = targets
    .filter((pluginId) => pluginExists(command, pluginId))
    .map((pluginId) => ["plugins", "uninstall", pluginId, ...(options.keepFiles ? ["--keep-files"] : []), ...(options.force ? ["--force"] : [])]);

  const report = {
    ok: true,
    command: options.command,
    mode: options.mode || "all",
    steps: steps.map((args) => formatStep(command, args)),
  };
  if (options.revertPatch) {
    report.steps.push(["node", ...buildPatchArgs(options, "revert")].join(" "));
  }
  if (!options.skipRestart) {
    report.steps.push(formatStep(command, ["gateway", "restart"]));
  }
  report.steps.push(formatStep(command, ["config", "validate", "--json"]));

  if (options.dryRun) {
    return report;
  }

  const results = [];
  for (const args of steps) {
    results.push(runCommand(command, args, { allowFailure: true }));
    invalidatePluginCache();
  }
  let patch = null;
  if (options.revertPatch) {
    patch = runNode(buildPatchArgs(options, "revert"), { allowFailure: true });
  }
  const restart = options.skipRestart
    ? null
    : runCommand(command, ["gateway", "restart"], { allowFailure: true });
  const validation = runCommand(command, ["config", "validate", "--json"], { allowFailure: true });

  report.uninstall = results.map((result, index) => ({
    pluginId: steps[index]?.[2],
    ok: result.ok,
    output: result.output,
  }));
  report.patch = patch ? { ok: patch.ok, output: patch.output } : null;
  report.restart = restart ? { ok: restart.ok, output: restart.output } : null;
  report.validation = parseMaybeJson(validation.output, { raw: validation.output });
  report.ok = results.every((result) => result.ok || /Plugin not found/i.test(result.output)) && (!restart || restart.ok);
  return report;
}

function runRollback(command, options) {
  const report = {
    ok: true,
    command: "rollback",
    steps: [
      "patch config plugins.slots.memory=memory-core",
      ...(pluginExists(command, "omnimemory-memory")
        ? ["patch config plugins.entries.omnimemory-memory.enabled=false"]
        : []),
      ["node", ...buildPatchArgs(options, "revert")].join(" "),
      ...(!options.skipRestart ? [formatStep(command, ["gateway", "restart"])] : []),
      formatStep(command, ["config", "validate", "--json"]),
    ],
  };
  if (options.dryRun) {
    return report;
  }
  const { configPath, config } = loadConfigObject(options.openclawRoot);
  const next = {
    ...(config && typeof config === "object" ? config : {}),
  };
  next.plugins = next.plugins && typeof next.plugins === "object" ? { ...next.plugins } : {};
  next.plugins.slots =
    next.plugins.slots && typeof next.plugins.slots === "object" ? { ...next.plugins.slots } : {};
  next.plugins.slots.memory = "memory-core";
  if (next.plugins.entries?.["omnimemory-memory"] && typeof next.plugins.entries["omnimemory-memory"] === "object") {
    next.plugins.entries = { ...next.plugins.entries };
    next.plugins.entries["omnimemory-memory"] = {
      ...next.plugins.entries["omnimemory-memory"],
      enabled: false,
    };
  }
  writeConfigObject(configPath, next);
  const patch = runNode(buildPatchArgs(options, "revert"), { allowFailure: true });
  const restart = options.skipRestart
    ? null
    : runCommand(command, ["gateway", "restart"], { allowFailure: true });
  const validation = runCommand(command, ["config", "validate", "--json"], { allowFailure: true });
  report.patch = { ok: patch.ok, output: patch.output };
  report.restart = restart ? { ok: restart.ok, output: restart.output } : null;
  report.validation = parseMaybeJson(validation.output, { raw: validation.output });
  report.ok = patch.ok && (!restart || restart.ok);
  return report;
}

function runStatus(command, options) {
  const slot = runCommand(command, ["config", "get", "plugins.slots.memory"], { allowFailure: true });
  const patchStatus = runNode(buildPatchArgs(options, "status"), { allowFailure: true });
  const replacementCompatibility = resolveReplacementCompatibility(options.openclawRoot);
  const overlayInfo = pluginExists(command, "omnimemory-overlay")
    ? getPluginInfo(command, "omnimemory-overlay")
    : { data: null };
  const replacementInfo = pluginExists(command, "omnimemory-memory")
    ? getPluginInfo(command, "omnimemory-memory")
    : { data: null };
  return {
    ok: true,
    command: "status",
    slot: slot.output || null,
    replacementCompatibility,
    patch: parseMaybeJson(patchStatus.output, { raw: patchStatus.output }),
    overlay: overlayInfo.data || null,
    replacement: replacementInfo.data || null,
  };
}

function runSmoke(command, options) {
  const spec = resolveModeSpec(options.mode, options.pluginRoot);
  const pluginInfo = getPluginInfo(command, spec.pluginId);
  const slot = runCommand(command, ["config", "get", "plugins.slots.memory"], { allowFailure: true });
  const validation = runCommand(command, ["config", "validate", "--json"], { allowFailure: true });
  const doctor = runCommand(command, ["plugins", "doctor"], { allowFailure: true });
  const compatibility =
    options.mode === "replacement" ? resolveReplacementCompatibility(options.openclawRoot) : null;
  const restart = options.skipRestart
    ? null
    : runCommand(command, ["gateway", "restart"], { allowFailure: true });
  const gatewayStatus = runCommand(command, ["gateway", "status", "--json"], { allowFailure: true });
  const report = {
    ok:
      pluginInfo.ok &&
      validation.ok &&
      doctor.ok &&
      (!restart || restart.ok) &&
      gatewayStatus.ok &&
      (!compatibility || compatibility.supported),
    command: "smoke",
    mode: options.mode,
    plugin: pluginInfo.data || null,
    slot: slot.output || null,
    compatibility,
    validation: parseMaybeJson(validation.output, { raw: validation.output }),
    doctor: doctor.output,
    restart: restart ? { ok: restart.ok, output: restart.output } : null,
    gatewayStatus: parseMaybeJson(gatewayStatus.output, { raw: gatewayStatus.output }),
    checks: {
      pluginLoaded: pluginInfo.ok,
      memorySlotMatches:
        options.mode === "replacement" ? slot.output.trim() === '"omnimemory-memory"' : slot.output.trim() === '"memory-core"',
      gatewayReachable: gatewayStatus.ok,
      replacementVersionSupported: compatibility ? compatibility.supported : true,
    },
  };
  return report;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/omnimemory-manage.mjs <install|switch|uninstall|rollback|status|smoke> [options]",
      "Options:",
      "  --mode overlay|replacement",
      "  --plugin-root <path>",
      "  --openclaw-root <path>",
      "  --api-key-env <ENV_NAME>",
      "  --api-key <raw-key>",
      "  --base-url <url>",
      "  --apply-patch",
      "  --revert-patch",
      "  --skip-restart",
      "  --keep-files",
      "  --link",
      "  --dry-run",
    ].join("\n"),
  );
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const command = resolveOpenClawCommand(options.openclawRoot);
    let report;
    if (options.command === "install" || options.command === "switch") {
      report = runInstallLike(command, options);
    } else if (options.command === "uninstall") {
      report = runUninstall(command, options);
    } else if (options.command === "rollback") {
      report = runRollback(command, options);
    } else if (options.command === "status") {
      report = runStatus(command, options);
    } else {
      report = runSmoke(command, options);
    }
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    return 1;
  }
}

process.exit(main());
