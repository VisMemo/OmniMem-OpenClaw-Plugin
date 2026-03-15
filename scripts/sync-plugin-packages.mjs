import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const runtimeSourceDir = path.join(pluginRoot, "src", "runtime");
const sharedSourceDir = path.join(pluginRoot, "src", "shared");

const PACKAGE_SPECS = [
  {
    id: "omnimemory-overlay",
    packageName: "@omnimem/omnimemory-overlay",
    displayName: "OmniMemory Overlay",
    description: "Non-destructive external long-term memory overlay for OpenClaw.",
  },
  {
    id: "omnimemory-memory",
    packageName: "@omnimem/omnimemory-memory",
    displayName: "OmniMemory",
    description: "OmniMemory-backed memory slot plugin for OpenClaw.",
  },
];

function buildPackageJson(spec) {
  return {
    name: spec.packageName,
    version: "0.1.0",
    type: "module",
    description: spec.description,
    openclaw: {
      extensions: ["./index.js"],
    },
    peerDependencies: {
      openclaw: ">=2026.3.11",
    },
    peerDependenciesMeta: {
      openclaw: {
        optional: true,
      },
    },
  };
}

function buildReadme(spec) {
  return [
    `# ${spec.displayName}`,
    "",
    `Install from a local checkout with:`,
    "",
    "```bash",
    `openclaw plugins install /abs/path/to/OmniMem-OpenClaw-Plugin/plugins/${spec.id}`,
    "```",
    "",
    "This package is generated from the OmniMem-OpenClaw-Plugin source tree.",
  ].join("\n");
}

async function syncPackage(spec) {
  const dir = path.join(pluginRoot, "plugins", spec.id);
  const runtimeTargetDir = path.join(dir, "runtime");
  const sharedTargetDir = path.join(dir, "shared");

  await mkdir(dir, { recursive: true });
  await rm(runtimeTargetDir, { recursive: true, force: true });
  await rm(sharedTargetDir, { recursive: true, force: true });
  await cp(runtimeSourceDir, runtimeTargetDir, { recursive: true });
  await cp(sharedSourceDir, sharedTargetDir, { recursive: true });

  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify(buildPackageJson(spec), null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(dir, "README.md"), `${buildReadme(spec)}\n`, "utf8");

  const manifestPath = path.join(dir, "openclaw.plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.id !== spec.id) {
    throw new Error(`manifest id mismatch for ${spec.id}: got ${manifest.id}`);
  }
}

async function main() {
  for (const spec of PACKAGE_SPECS) {
    await syncPackage(spec);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        packages: PACKAGE_SPECS.map((spec) => path.join(pluginRoot, "plugins", spec.id)),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
