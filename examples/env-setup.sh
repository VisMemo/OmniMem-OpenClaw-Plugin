#!/usr/bin/env bash

set -euo pipefail

# Adjust these paths for your workspace layout.
export OPENCLAW_REPO_ROOT="/abs/path/to/openclaw"
export OMNI_MEMORY_PLUGIN_ROOT="/abs/path/to/OmniMem-OpenClaw-Plugin"

# Use a real OmniMemory API key or keep the config file value as ${OMNI_MEMORY_API_KEY}.
export OMNI_MEMORY_API_KEY="qbk_xxx"

# Optional: point OpenClaw at a non-default config file if needed.
# export OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json"
