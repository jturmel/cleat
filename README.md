# cleat

Cleat is a task-aware AI CLI plugin focused on helping agents discover, explain, recommend, and run project workflows defined in `Taskfile.yaml` (with compatibility for existing `Taskfile.yml` repos).

## OpenCode install and updates

For OpenCode-specific install, pinning, update, and troubleshooting guidance, see `.opencode/INSTALL.md`.

Recommended install style is a pinned release tag, for example:

```json
{
  "plugin": [
    "cleat@git+https://github.com/jturmel/cleat.git#v0.4.4"
  ]
}
```

When updating, move to the next release tag rather than tracking `main`.

## What it does

- exposes task-focused tools for listing, explaining, recommending, and running go-task tasks
- parses `Taskfile.yaml`/`Taskfile.yml` and included taskfiles to build task metadata
- helps guide Makefile-to-go-task migration workflows
- provides task-aware startup guidance without loading external skill packs

## Opinionated migration guidance

Cleat migration guidance is intentionally opinionated when mapping Makefile workflows to go-task:

- generate canonical `.yaml` files only: `Taskfile.yaml`, `taskfiles/_root.yaml`, and `taskfiles/<namespace>.yaml`
- keep `Taskfile.yaml` as a small index; place root/front-door workflows in `taskfiles/_root.yaml`
- keep one-command tasks and shell snippets up to roughly 7-8 lines inline; move longer or complex shell into `taskfiles/scripts/`
- prefer root aggregate semantics for `build`, `build:clean`, `clean`, `test`, `verify`, and `verify:all` when matching signals exist
- let root `clean` clear project-scoped local artifacts aggressively, including Compose services, images, and volumes when clearly local to the project
- use go-task `prompt:` for risky or destructive tasks instead of hand-rolled shell confirmations
- prefer generic namespaces such as `db:*` and `infra:*`; infer package/domain namespaces from the project instead of baking in project-specific defaults
- preserve existing command runners during migration unless the user explicitly wants a hard cutover

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

Run the GitHub CI workflow locally (requires Docker):

```bash
npm run install:act
npm run test:workflow
```

You can pass additional `act` flags through `npm run test:workflow -- <flags>`.
