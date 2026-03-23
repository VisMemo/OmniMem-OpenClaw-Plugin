# Agent Installation

This project supports an agent-driven installation workflow so users do not have to edit OpenClaw config by hand.

## What Exists Today

1. A reusable installer skill: `skills/omnimemory-installer`
2. A repository-level install manager: `scripts/omnimemory-manage.mjs`
3. Standard OpenClaw-installable plugin packages for both modes

## Recommended Policy

1. Start with `Overlay`
2. Use `Replacement` only when you need memory-slot takeover
3. Apply the optional replacement patch only when the operator explicitly accepts a version-gated OpenClaw core patch

## Agent Workflow

An agent can typically handle:

1. Installing the plugin package through OpenClaw
2. Writing `plugins.entries.<id>` configuration
3. Switching `plugins.slots.memory` in `Replacement`
4. Running config validation
5. Restarting the gateway
6. Reporting what changed and whether the install is active

## Skill Entry Point

The skill-level script is intentionally thin:

- `skills/omnimemory-installer/scripts/install_omnimemory.mjs`

It delegates to:

- `scripts/omnimemory-manage.mjs`

That keeps the public skill entry stable while the repository-level installation logic evolves in one place.

## Inputs An Agent Still Needs

1. Whether to use `overlay` or `replacement`
2. The OpenClaw repo root or installed CLI
3. The OmniMem plugin repo root
4. The OmniMemory API key or environment variable name
