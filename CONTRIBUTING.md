# Contributing

Thanks for helping improve OmniMem-OpenClaw-Plugin.

## Local setup

1. Clone this repository next to a local OpenClaw checkout.
2. Use Node.js 22 or newer.
3. Keep `OMNI_MEMORY_API_KEY` available in your shell if you want to run live smoke tests.
4. If you use the installer workflow, prefer the bundled manage script instead of editing OpenClaw config by hand.

## Common commands

```bash
npm test
npm run test:installer-local
npm run test:integration
npm run smoke:standard-install
npm run doctor
npm run packages:sync
```

`npm test` is the portable repository-level suite. `npm run test:installer-local` expects a local OpenClaw checkout next to this repository.

For live checks:

```bash
npm run test:live:overlay
npm run test:live:replacement
```

For plugin management:

```bash
node scripts/omnimemory-manage.mjs status
node scripts/omnimemory-manage.mjs install --mode overlay
node scripts/omnimemory-manage.mjs switch --mode replacement --apply-patch
node scripts/omnimemory-manage.mjs rollback
```

## Pull requests

1. Keep commits focused and descriptive.
2. Include the tests you ran in the PR description.
3. If a change affects installation or runtime behavior, add or update an integration test.
4. Do not modify the OpenClaw core from this repository unless the change is explicitly meant for the upstream OpenClaw repo.

## Style

1. Keep JSON examples minimal and valid.
2. Prefer ASCII in new files unless a Chinese translation is explicitly needed.
3. Match the existing script-first workflow.

## Reporting issues

When filing an issue, include:

1. The plugin mode you used: `overlay` or `replacement`
2. Your OpenClaw version
3. The exact command or config you used
4. The expected result and the actual result
5. Relevant logs or screenshots

## Notes

`overlay` is the default recommended path. `replacement` is the advanced path and may require a supported OpenClaw version plus the optional replacement patch.
