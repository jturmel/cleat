# Installing Cleat for OpenCode

## Prerequisites

- OpenCode installed

## Install (recommended: pinned release tag)

Add cleat to the `plugin` array in your `opencode.json`:

```json
{
  "plugin": [
    "cleat@git+https://github.com/jturmel/cleat.git#v0.3.0"
  ]
}
```

Then restart OpenCode.

## Update to a new release

When a new release is published (for example `v0.3.1`), update the plugin ref and reinstall:

```bash
opencode plugin "cleat@git+https://github.com/jturmel/cleat.git#v0.3.1" --global --force
```

Using pinned tags gives deterministic installs and avoids ambiguity from floating branch refs.

## Verify install

Run from any directory:

```bash
opencode debug config
```

Confirm:

- the cleat plugin ref is present in `plugin`
- commands include `cleat-scan-makefile`, `cleat-plan-taskfile`, and related cleat commands

You can also run a command directly:

```bash
opencode run --command "cleat-scan-makefile" "smoke"
```

## Troubleshooting

### Plugin appears installed but commands are missing

1. Verify the installed package in OpenCode's cache:

```bash
readlink -f ~/.cache/opencode/node_modules/cleat
```

2. Force-refresh the cached package to the exact tag:

```bash
cd ~/.cache/opencode
npm install --force "cleat@git+https://github.com/jturmel/cleat.git#v0.3.0"
```

3. Restart OpenCode and re-check `opencode debug config`.

### Need a temporary hotfix pin

If needed, you can pin to a commit SHA while debugging:

```json
{
  "plugin": [
    "cleat@git+https://github.com/jturmel/cleat.git#<commit-sha>"
  ]
}
```

Switch back to a release tag once the fix is released.
