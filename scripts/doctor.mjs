import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchSystemPromptSource, patchBootstrapSource } from "../src/replacement/patch-core.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const defaultOpenClawRoot = path.resolve(pluginRoot, "..", "openclaw");

function parseArgs(argv) {
  const args = [...argv];
  const parsed = { openclawRoot: defaultOpenClawRoot };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--openclaw-root") {
      const next = args.shift();
      if (!next) {
        throw new Error("--openclaw-root requires a value");
      }
      parsed.openclawRoot = path.resolve(next);
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return parsed;
}

async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function record(ok, id, message, details = undefined) {
  return { ok, id, message, ...(details === undefined ? {} : { details }) };
}

async function runDoctor(openclawRoot) {
  const checks = [];

  const overlayManifest = path.join(pluginRoot, "plugins/omnimemory-overlay/openclaw.plugin.json");
  const memoryManifest = path.join(pluginRoot, "plugins/omnimemory-memory/openclaw.plugin.json");
  const overlayPackageJson = path.join(pluginRoot, "plugins/omnimemory-overlay/package.json");
  const memoryPackageJson = path.join(pluginRoot, "plugins/omnimemory-memory/package.json");
  checks.push(
    (await fileExists(overlayManifest))
      ? record(true, "plugin.overlay_manifest", "overlay manifest present", { path: overlayManifest })
      : record(false, "plugin.overlay_manifest", "overlay manifest missing", { path: overlayManifest }),
  );
  checks.push(
    (await fileExists(memoryManifest))
      ? record(true, "plugin.memory_manifest", "memory manifest present", { path: memoryManifest })
      : record(false, "plugin.memory_manifest", "memory manifest missing", { path: memoryManifest }),
  );
  checks.push(
    (await fileExists(overlayPackageJson))
      ? record(true, "plugin.overlay_package", "overlay package.json present", { path: overlayPackageJson })
      : record(false, "plugin.overlay_package", "overlay package.json missing", { path: overlayPackageJson }),
  );
  checks.push(
    (await fileExists(memoryPackageJson))
      ? record(true, "plugin.memory_package", "memory package.json present", { path: memoryPackageJson })
      : record(false, "plugin.memory_package", "memory package.json missing", { path: memoryPackageJson }),
  );
  if (await fileExists(overlayPackageJson)) {
    try {
      const overlayPackage = JSON.parse(await readFile(overlayPackageJson, "utf8"));
      const extensions = overlayPackage?.openclaw?.extensions;
      checks.push(
        Array.isArray(extensions) && extensions.includes("./index.js")
          ? record(true, "plugin.overlay_extensions", "overlay package exports OpenClaw extension entry")
          : record(false, "plugin.overlay_extensions", "overlay package missing openclaw.extensions ./index.js"),
      );
    } catch (error) {
      checks.push(
        record(false, "plugin.overlay_extensions", "overlay package.json is invalid JSON", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  if (await fileExists(memoryPackageJson)) {
    try {
      const memoryPackage = JSON.parse(await readFile(memoryPackageJson, "utf8"));
      const extensions = memoryPackage?.openclaw?.extensions;
      checks.push(
        Array.isArray(extensions) && extensions.includes("./index.js")
          ? record(true, "plugin.memory_extensions", "memory package exports OpenClaw extension entry")
          : record(false, "plugin.memory_extensions", "memory package missing openclaw.extensions ./index.js"),
      );
    } catch (error) {
      checks.push(
        record(false, "plugin.memory_extensions", "memory package.json is invalid JSON", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  const systemPromptPath = path.join(openclawRoot, "src/agents/system-prompt.ts");
  const bootstrapPath = path.join(openclawRoot, "src/agents/bootstrap-files.ts");
  const openclawNodeModules = path.join(openclawRoot, "node_modules");

  checks.push(
    (await fileExists(systemPromptPath))
      ? record(true, "openclaw.system_prompt", "system-prompt target present", { path: systemPromptPath })
      : record(false, "openclaw.system_prompt", "system-prompt target missing", { path: systemPromptPath }),
  );
  checks.push(
    (await fileExists(bootstrapPath))
      ? record(true, "openclaw.bootstrap_files", "bootstrap-files target present", { path: bootstrapPath })
      : record(false, "openclaw.bootstrap_files", "bootstrap-files target missing", { path: bootstrapPath }),
  );
  checks.push(
    (await fileExists(openclawNodeModules))
      ? record(true, "openclaw.dependencies", "OpenClaw dependencies installed", {
          path: openclawNodeModules,
        })
      : record(false, "openclaw.dependencies", "OpenClaw dependencies missing (run pnpm install)", {
          path: openclawNodeModules,
        }),
  );

  if ((await fileExists(systemPromptPath)) && (await fileExists(bootstrapPath))) {
    try {
      const systemPromptSource = await readFile(systemPromptPath, "utf8");
      patchSystemPromptSource(systemPromptSource);
      checks.push(record(true, "patch.anchor_system_prompt", "system-prompt patch anchor is compatible"));
    } catch (error) {
      checks.push(
        record(false, "patch.anchor_system_prompt", "system-prompt patch anchor is incompatible", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    try {
      const bootstrapSource = await readFile(bootstrapPath, "utf8");
      patchBootstrapSource(bootstrapSource);
      checks.push(record(true, "patch.anchor_bootstrap", "bootstrap-files patch anchor is compatible"));
    } catch (error) {
      checks.push(
        record(false, "patch.anchor_bootstrap", "bootstrap-files patch anchor is incompatible", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  const ok = checks.every((item) => item.ok);
  return {
    ok,
    pluginRoot,
    openclawRoot,
    checks,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runDoctor(args.openclawRoot);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
