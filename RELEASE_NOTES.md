# Release Notes

## v0.4.2 (2026-04-01)

### Highlights
- Prevented test runner side effects during plugin startup by moving tests out of the plugin directory and guarding direct execution.
- Excluded `tests/` from packaged artifacts to keep OpenCode installs clean and deterministic.

### Upgrade
Pin the plugin to this release tag:

```json
{
  "plugin": [
    "cleat@git+https://github.com/jturmel/cleat.git#v0.4.2"
  ]
}
```

## v0.4.0 (2026-04-01)

### Highlights
- Stronger opinionated guidance for Makefile-to-go-task migration.
- Deterministic `proposedSurfaceArtifact` output for migration recommendations.
- Confidence-based guided behavior so cleat asks fewer structural questions when inference is strong.

### Migration guidance updates
- Root front-door defaults now prefer: `dev`, `build`, `test`, `verify`, `deploy` when analogs exist.
- Promote paths now default under deploy namespace: `deploy:promote`.
- Canonical naming normalization expanded for common migration/test/lint/fixture patterns.

### Guided-mode behavior
- Guided prompt now applies default house style first.
- Questioning is now exception-driven and confidence-aware.
- Outputs now carry an explicit confidence score and ambiguity list.

### Upgrade
Pin the plugin to this release tag:

```json
{
  "plugin": [
    "cleat@git+https://github.com/jturmel/cleat.git#v0.4.0"
  ]
}
```
