# cleat

Cleat is a task-aware AI CLI plugin focused on helping agents discover, explain, recommend, and run project workflows defined in `Taskfile.yml`.

## OpenCode install and updates

For OpenCode-specific install, pinning, update, and troubleshooting guidance, see `.opencode/INSTALL.md`.

Recommended install style is a pinned release tag, for example:

```json
{
  "plugin": [
    "cleat@git+https://github.com/jturmel/cleat.git#v0.3.0"
  ]
}
```

When updating, move to the next release tag rather than tracking `main`.

## What it does

- exposes task-focused tools for listing, explaining, recommending, and running go-task tasks
- parses `Taskfile.yml` and included taskfiles to build task metadata
- helps guide Makefile-to-go-task migration workflows
- provides task-aware startup guidance without loading external skill packs

## Development

Install dependencies:

```bash
npm ci
```

Build the plugin:

```bash
npm run build
```

Run tests:

```bash
npm test
```
