---
name: omnimemory-installer
description: Install, switch, repair, or validate OmniMemory for OpenClaw. Use when a user wants OmniMemory connected as an OpenClaw plugin with minimal manual work, including overlay mode, replacement mode, config wiring, optional replacement patching, gateway restart, and post-install verification. Prefer this skill when the goal is "just make OmniMemory work in my OpenClaw".
---

# OmniMemory Installer

Use this skill when the user wants OmniMemory installed or switched inside OpenClaw with as little manual work as possible.

## What this skill handles

1. `Overlay` install
2. `Replacement` install
3. Optional replacement patch apply/revert
4. Standard plugin package install through `openclaw plugins install`
5. Atomic config patching
5. Gateway restart + validation
6. Re-run / repair when a previous install drifted

## Inputs to collect from the user request

Extract or infer these values:

1. mode: `overlay` or `replacement`
2. OpenClaw repo root or installed CLI
3. OmniMemory plugin repo root
4. OmniMemory API key source
5. whether replacement patch is allowed

If the API key is available, prefer storing `${OMNI_MEMORY_API_KEY}` in config instead of plaintext.

## Preferred workflow

1. Verify OpenClaw access:
   - Prefer `openclaw` if it exists on PATH.
   - Otherwise, if working from a repo checkout, prefer `node <openclawRoot>/dist/index.js`.
2. Run the bundled installer script:
   - `skills/omnimemory-installer/scripts/install_omnimemory.mjs`
   - This wrapper delegates to the repository-level `scripts/omnimemory-manage.mjs` install flow instead of re-implementing installation logic inside the skill.
3. Validate:
   - `openclaw config validate`
   - `openclaw plugins doctor`
   - plugin repo `npm run doctor -- --openclaw-root <openclawRoot>`
4. If requested, apply replacement patch.
5. Restart the gateway.
6. Report exactly what changed and whether restart/verification succeeded.

## Commands

Overlay example:

```bash
node skills/omnimemory-installer/scripts/install_omnimemory.mjs \
  --mode overlay \
  --plugin-root /abs/path/to/OmniMem-OpenClaw-Plugin \
  --openclaw-root /abs/path/to/openclaw \
  --api-key-env OMNI_MEMORY_API_KEY
```

Replacement example:

```bash
node skills/omnimemory-installer/scripts/install_omnimemory.mjs \
  --mode replacement \
  --plugin-root /abs/path/to/OmniMem-OpenClaw-Plugin \
  --openclaw-root /abs/path/to/openclaw \
  --api-key-env OMNI_MEMORY_API_KEY \
  --apply-patch
```

## Guardrails

1. Prefer the bundled installer / manage script over ad-hoc config edits.
2. Do not apply replacement patch unless the user asked for replacement or approved the core surgery.
3. Do not store plaintext API keys when an env var path is available.
4. After config writes, always validate before restart.
5. If restart fails, report that clearly instead of pretending install is complete.
