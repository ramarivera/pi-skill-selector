# pi-skill-selector Agent Notes

This repo is a Bun/TypeScript Pi extension that adds a `$` skill selector to the Pi editor.

## Workflow

- Run `bun test` after behavior changes.
- Run `bun run check` before reporting type-level correctness.
- Keep the real extension source in `src/index.ts`.
- Keep `.pi/extensions/pi-skill-selector/index.ts` as a local Pi test shim only.

## Packaging

- Package name is `@ramarivera/pi-skill-selector`.
- Pi package metadata lives in `package.json` under `pi.extensions`.
- Do not publish `.pi/`, `node_modules/`, or local session artifacts.
