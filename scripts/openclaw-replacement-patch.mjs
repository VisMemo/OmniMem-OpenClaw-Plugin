import { mkdir, readFile, writeFile, copyFile, access } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  patchSystemPromptSource,
  patchBootstrapSource,
  isSystemPromptPatched,
  isBootstrapPatched,
  sha256,
} from "../src/replacement/patch-core.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const defaultOpenClawRoot = path.resolve(pluginRoot, "..", "openclaw");

const TARGETS = [
  {
    id: "system-prompt",
    relativePath: "src/agents/system-prompt.ts",
    patch: patchSystemPromptSource,
    isPatched: isSystemPromptPatched,
  },
  {
    id: "bootstrap-files",
    relativePath: "src/agents/bootstrap-files.ts",
    patch: patchBootstrapSource,
    isPatched: isBootstrapPatched,
  },
];

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/openclaw-replacement-patch.mjs status [--openclaw-root <path>]",
      "  node scripts/openclaw-replacement-patch.mjs apply  [--openclaw-root <path>]",
      "  node scripts/openclaw-replacement-patch.mjs revert [--openclaw-root <path>] [--force]",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const parsed = {
    command,
    openclawRoot: defaultOpenClawRoot,
    force: false,
  };
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
    if (token === "--force") {
      parsed.force = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return parsed;
}

function buildStateDir(openclawRoot) {
  return path.join(openclawRoot, ".omnimemory", "replacement-patch");
}

function buildStateFile(openclawRoot) {
  return path.join(buildStateDir(openclawRoot), "current.json");
}

async function ensureOpenClawRoot(openclawRoot) {
  for (const target of TARGETS) {
    const absolutePath = path.join(openclawRoot, target.relativePath);
    try {
      await access(absolutePath, constants.F_OK);
    } catch {
      throw new Error(`missing target file: ${absolutePath}`);
    }
  }
}

async function readTarget(openclawRoot, target) {
  const filePath = path.join(openclawRoot, target.relativePath);
  const source = await readFile(filePath, "utf8");
  return {
    ...target,
    filePath,
    source,
    hash: sha256(source),
    patched: target.isPatched(source),
  };
}

async function readCurrentState(openclawRoot) {
  const stateFile = buildStateFile(openclawRoot);
  try {
    const raw = await readFile(stateFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function status(openclawRoot) {
  await ensureOpenClawRoot(openclawRoot);
  const targets = await Promise.all(TARGETS.map((target) => readTarget(openclawRoot, target)));
  const state = await readCurrentState(openclawRoot);
  const report = {
    openclawRoot,
    patched: targets.every((item) => item.patched),
    files: targets.map((item) => ({
      id: item.id,
      filePath: item.filePath,
      patched: item.patched,
      hash: item.hash,
    })),
    stateFile: buildStateFile(openclawRoot),
    hasState: Boolean(state),
    appliedAt: state?.appliedAt || null,
    backupDir: state?.backupDir || null,
  };
  console.log(JSON.stringify(report, null, 2));
}

function buildTimestampId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function apply(openclawRoot) {
  await ensureOpenClawRoot(openclawRoot);
  const current = await Promise.all(TARGETS.map((target) => readTarget(openclawRoot, target)));

  const prepared = current.map((item) => {
    const patched = item.patch(item.source);
    return {
      ...item,
      changed: patched.changed,
      nextSource: patched.source,
      nextHash: sha256(patched.source),
    };
  });

  if (!prepared.some((item) => item.changed)) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          openclawRoot,
          changed: false,
          message: "already patched or no-op",
        },
        null,
        2,
      ),
    );
    return;
  }

  const stateDir = buildStateDir(openclawRoot);
  const backupId = buildTimestampId();
  const backupDir = path.join(stateDir, "backups", backupId);
  await mkdir(backupDir, { recursive: true });

  const stateEntries = [];
  for (const item of prepared) {
    const backupPath = path.join(backupDir, `${item.id}.orig`);
    await copyFile(item.filePath, backupPath);
    if (item.changed) {
      await writeFile(item.filePath, item.nextSource, "utf8");
    }
    stateEntries.push({
      id: item.id,
      filePath: item.filePath,
      backupPath,
      originalHash: item.hash,
      patchedHash: item.nextHash,
      changed: item.changed,
    });
  }

  const state = {
    version: 1,
    appliedAt: new Date().toISOString(),
    openclawRoot,
    backupDir,
    entries: stateEntries,
  };
  await mkdir(stateDir, { recursive: true });
  await writeFile(buildStateFile(openclawRoot), JSON.stringify(state, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        ok: true,
        openclawRoot,
        changed: true,
        backupDir,
        files: stateEntries.map((entry) => ({
          id: entry.id,
          filePath: entry.filePath,
          changed: entry.changed,
        })),
      },
      null,
      2,
    ),
  );
}

async function revert(openclawRoot, force) {
  await ensureOpenClawRoot(openclawRoot);
  const state = await readCurrentState(openclawRoot);
  if (!state?.entries?.length) {
    throw new Error("no patch state found; cannot revert safely");
  }
  for (const entry of state.entries) {
    if (!entry.changed) {
      continue;
    }
    const currentSource = await readFile(entry.filePath, "utf8");
    const currentHash = sha256(currentSource);
    if (!force && currentHash !== entry.patchedHash) {
      throw new Error(
        `refusing to revert ${entry.filePath}: current file hash diverged from patched hash; re-run with --force to override`,
      );
    }
  }
  for (const entry of state.entries) {
    if (!entry.changed) {
      continue;
    }
    await copyFile(entry.backupPath, entry.filePath);
  }
  const revertedStatePath = path.join(
    buildStateDir(openclawRoot),
    `reverted-${buildTimestampId()}.json`,
  );
  await writeFile(revertedStatePath, JSON.stringify(state, null, 2), "utf8");
  await writeFile(buildStateFile(openclawRoot), "", "utf8");
  console.log(
    JSON.stringify(
      {
        ok: true,
        openclawRoot,
        reverted: true,
        revertedStatePath,
      },
      null,
      2,
    ),
  );
}

async function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (!parsed.command || ["-h", "--help", "help"].includes(parsed.command)) {
      printUsage();
      process.exitCode = 0;
      return;
    }
    if (!["status", "apply", "revert"].includes(parsed.command)) {
      throw new Error(`unknown command: ${parsed.command}`);
    }
    if (parsed.command === "status") {
      await status(parsed.openclawRoot);
      return;
    }
    if (parsed.command === "apply") {
      await apply(parsed.openclawRoot);
      return;
    }
    await revert(parsed.openclawRoot, parsed.force);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exitCode = 1;
  }
}

void main();
