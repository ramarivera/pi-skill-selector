# @ramarivera/pi-skill-selector

Pi extension that turns `$` into a fuzzy skill selector.

## What it does

- listens to raw terminal input so it works alongside editor-owning extensions like `pi-powerline-footer`
- intercepts `$` anywhere in the prompt before the active editor consumes it
- opens an overlay skill picker
- fuzzy-filters skills case-insensitively by name and description
- inserts `/skill:<name> ` at the cursor so Pi's built-in skill expansion loads the selected skill
- also provides `/skill-selector` as a command fallback

## Install

### From npm

```bash
pi install npm:@ramarivera/pi-skill-selector
```

### From GitHub

```bash
pi install git:github.com/ramarivera/pi-skill-selector
```

### From a local checkout

```bash
pi install /absolute/path/to/pi-skill-selector
```

## Use

In interactive Pi, type:

```text
$
```

Pick a skill, press Enter, and the extension inserts:

```text
/skill:<skill-name> 
```

You can also run:

```text
/skill-selector
```

## Development

```bash
bun install
bun test
bun run check
```

For local Pi auto-discovery while developing, this repo includes a `.pi/extensions/pi-skill-selector/index.ts` shim that re-exports `src/index.ts`.

## Publishing

Publishing is handled by `.github/workflows/publish.yml` using npm trusted publishing. Before the workflow can publish, configure the package on npm with `ramarivera/pi-skill-selector` and workflow `.github/workflows/publish.yml` as a trusted publisher.

## Notes

This package is meant to be installed as a Pi package, so it declares its extension entry under the `pi` key in `package.json`.

## License

MIT
