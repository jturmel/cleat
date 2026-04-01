# Taskfile YAML Canonicalization Design

## Goal

Update Cleat's Makefile-to-go-task guidance so new generated Taskfile output is always canonical `.yaml`, with a thin root `Taskfile.yaml` that imports `taskfiles/_root.yaml`. Root/direct tasks should live in `_root.yaml`, namespace taskfiles should live under `taskfiles/*.yaml`, helper scripts should live under `taskfiles/scripts/`, and inline shell in `cmds` guidance should default to silenced execution.

## Architecture

Cleat should be tolerant when reading existing projects and canonical when generating guidance.

- Read compatibility:
  - Accept `Taskfile.yaml` and `Taskfile.yml` roots.
  - Prefer `Taskfile.yaml` when both exist.
  - Accept included taskfiles in either extension.
- Generated/recommended structure:
  - Root `Taskfile.yaml` with `flatten: true`.
  - Root file imports `taskfiles/_root.yaml`.
  - `taskfiles/_root.yaml` owns root/front-door tasks and imports namespace taskfiles.
  - Namespace taskfiles are `taskfiles/*.yaml`.
  - Shell-heavy helpers are extracted to `taskfiles/scripts/`.

## Behavior Requirements

1. Existing repos using `Taskfile.yml` must continue to work.
2. Existing repos using `Taskfile.yaml` must continue to work.
3. If both root files exist, parser/tooling should choose `Taskfile.yaml`.
4. Included taskfiles should load with either `.yaml` or `.yml`.
5. New migration output and examples should use `.yaml` paths.
6. Cleat may suggest renaming Taskfile-related `.yml` files to `.yaml`.
7. Migration guidance should recommend:
   - thin root `Taskfile.yaml`
   - `flatten: true`
   - root import of `taskfiles/_root.yaml`
   - namespace taskfiles in `taskfiles/`
   - extracted scripts in `taskfiles/scripts/`

## Shell Guidance Requirements

1. Inline shell inside `cmds` should be marked `silent: true` in recommended snippets.
2. Shell-heavy task logic should be recommended for extraction into `taskfiles/scripts/`.
3. Prompt/policy text should explicitly reinforce both rules.

## Components and Impacted Files

- `tasks.ts` and generated `tasks.js`
  - Add root Taskfile resolver (`.yaml` preferred, `.yml` fallback).
  - Add include fallback resolver (`.yaml` <-> `.yml`).
- `.opencode/plugins/cleat-plugin.js`
  - Replace hardcoded `Taskfile.yml` checks with shared resolver.
  - Update migration plan and prompt text to canonical paths and shell guidance.
- `tests/cleat-plugin.test.js`
  - Add/adjust tests for dual-extension loading and canonical output recommendations.
- `README.md` and `package.json` description
  - Update wording to canonical `Taskfile.yaml` while noting compatibility behavior.

## Data Flow

1. Detect root Taskfile path via resolver.
2. Parse root includes and resolve include paths with extension fallback.
3. Build scan/map/plan artifacts as before.
4. Emit migration guidance that is canonical `.yaml` and includes `_root.yaml`, `flatten: true`, script extraction guidance, and silenced inline shell guidance.

## Error Handling

- Missing includes remain non-fatal.
- If configured include path is missing with one extension, attempt the alternate extension before skipping.
- Unreadable include files continue to be skipped.

## Testing Strategy

Add or update tests for:

1. Root detection for `Taskfile.yaml`.
2. Root detection for `Taskfile.yml`.
3. Precedence when both files exist (`.yaml` wins).
4. Include fallback across `.yaml` and `.yml`.
5. Canonical migration guidance mentioning:
   - `Taskfile.yaml`
   - `taskfiles/_root.yaml`
   - `flatten: true`
   - `taskfiles/scripts/`
   - silenced inline `cmds` behavior.
