# cleat

Cleat is a task-aware AI CLI plugin focused on helping agents discover, explain, recommend, and run project workflows defined in `Taskfile.yml`.

## OpenCode install and updates

For OpenCode-specific install, pinning, update, and troubleshooting guidance, see `.opencode/INSTALL.md`.

Recommended install style is a pinned release tag, for example:

```json
{
  "plugin": [
    "cleat@git+https://github.com/jturmel/cleat.git#v0.4.0"
  ]
}
```

When updating, move to the next release tag rather than tracking `main`.

## What it does

- exposes task-focused tools for listing, explaining, recommending, and running go-task tasks
- parses `Taskfile.yml` and included taskfiles to build task metadata
- helps guide Makefile-to-go-task migration workflows
- provides task-aware startup guidance without loading external skill packs

## Opinionated migration guidance

Cleat migration guidance is intentionally opinionated when mapping Makefile workflows to go-task:

- keep root commands as a small front door (`dev`, `build`, `test`, `verify`, `deploy`) when analogs exist
- keep most workflow depth in namespaces (`db:*`, `verify:*`, `deploy:*`, `dev:*`)
- normalize legacy names toward consistent task names when there is clear signal
- treat safety as separate from root placement (`deploy` can be root and still production-risky)
- emit a dedicated `proposedSurfaceArtifact` block with deterministic recommendations
- include migration confidence scoring to decide whether guided mode should ask questions or apply defaults directly

Common normalization examples:

- `dj-migrate-dev` -> `db:migrate`
- `load-dev-fixtures` -> `db:load`
- `py-lint` -> `verify:lint`
- `dj-test` -> `test`
- `promote` -> `deploy:promote`

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
