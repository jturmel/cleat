# Cleat Sync From Makefile Design

## Goal

Simplify Cleat's Makefile migration command surface to one command: `/cleat-sync-from-makefile`. The command should guide users from an empty go-task setup through initial Taskfile bootstrap, and later reconcile Makefile drift into an existing Taskfile setup when teammates add Makefile targets.

## Command Surface

Cleat should register and support only one Makefile-related slash command:

- `/cleat-sync-from-makefile`

The old staged commands should be removed from the public and internal slash-command surface:

- `/cleat-migrate-makefile`
- `/cleat-scan-makefile`
- `/cleat-map-make-targets`
- `/cleat-plan-taskfile`
- `/cleat-shore-up-taskfile`

Any text after `/cleat-sync-from-makefile` is free-form user context. The first version should not add formal command flags such as `--plan-only`, `--check`, or `--apply`.

## Source Of Truth Model

The Makefile is a required coverage source, not the exclusive source of truth. Every relevant public Makefile target should be accounted for in the Taskfile setup, but existing Taskfile-only tasks are allowed and should be preserved. Cleat should not try to sync Taskfile-only tasks back into the Makefile.

Coverage means each public Makefile target is one of:

- already covered by an existing Taskfile task
- proposed as a new or updated Taskfile task
- ambiguous and blocked on one focused user question
- intentionally skipped because it is helper/internal or otherwise not a public workflow

## Architecture

`/cleat-sync-from-makefile` should be a single public entrypoint over the existing internal migration pipeline. The implementation can keep the current scan, classify, map, proposed-surface, migration-policy, and plan artifacts, but those artifacts should be produced together for the sync command instead of being selected by separate slash commands.

The command should add a sync coverage artifact that compares public Makefile targets against parsed Taskfile tasks. This artifact gives the prompt a clear reconciliation model for initial bootstrap and incremental updates.

The primary internal units are:

- command registration and parsing for the single command
- Makefile scan and target classification
- Taskfile inventory and parsed task lookup
- Makefile-to-Taskfile coverage calculation
- sync prompt construction
- tests and documentation for the new contract

## Workflow Behavior

The command should be context-sensitive:

- If no Makefile exists, explain that there is nothing to sync from.
- If no Taskfile exists, enter bootstrap mode and recommend the canonical Cleat layout.
- If a Taskfile exists, preserve Taskfile-only tasks and add or update coverage for Makefile targets only.
- If the Makefile has changed since a previous setup, detect uncovered targets and sync the Taskfile side.
- If a target is ambiguous, ask one focused question only when Cleat cannot safely choose the Taskfile name, namespace, or safety behavior.

The default flow is plan then apply. The generated prompt should instruct the agent to present a concise sync plan, then apply it unless ambiguity or destructive-risk handling blocks progress.

## Canonical Taskfile Guidance

The command should preserve Cleat's existing migration guidance:

- generate canonical `.yaml` files only
- use root `Taskfile.yaml`
- keep `Taskfile.yaml` as a thin index with `flatten: true`
- place root/front-door workflows in `taskfiles/_root.yaml`
- place namespaced workflows in `taskfiles/<namespace>.yaml`
- place extracted helper scripts in `taskfiles/scripts/`
- keep one-command tasks and short shell snippets inline with `silent: true`
- use go-task `prompt:` for risky or destructive tasks

Existing projects that use `Taskfile.yml` should still be readable, but generated guidance should continue recommending canonical `.yaml` paths.

## Error Handling

The command should fail soft wherever possible:

- Missing Makefile: return explanatory guidance and do not invent work.
- Missing Taskfile: treat as bootstrap mode.
- Both `Taskfile.yaml` and `Taskfile.yml`: use existing `.yaml` preference and recommend canonical `.yaml` output.
- Ambiguous Makefile target: block only that decision and ask one focused question.
- Risky or destructive target: require safe Taskfile patterns such as `prompt:` rather than hand-rolled shell confirmations.
- Existing Taskfile-only task: preserve it unless it directly conflicts with generated coverage.

## Data Flow

1. Parse `/cleat-sync-from-makefile` from the OpenCode command hook.
2. Detect automation context from Makefile, Taskfile, `taskfiles/`, docs, and CI files.
3. Parse Makefile targets and classify each target.
4. Parse existing Taskfile tasks when a Taskfile exists.
5. Build mapping, proposed surface, migration policy, plan, and sync coverage artifacts.
6. Store artifacts in the session state for continuity.
7. Inject a sync prompt that tells the agent to present a concise plan and apply Taskfile-side changes.

## Testing Strategy

Tests should lock in the new single-command contract:

- `config.command` registers only `cleat-sync-from-makefile` among Cleat migration commands.
- Old slash commands no longer parse or trigger Cleat handling.
- `/cleat-sync-from-makefile` builds scan, classification, mapping, proposed-surface, migration-policy, plan, and sync coverage artifacts in one workflow.
- Prompt text describes Makefile coverage semantics and plan-then-apply behavior.
- Bootstrap mode is represented when no Taskfile exists.
- Existing Taskfile-only tasks are preserved in the coverage model.
- Documentation mentions only `/cleat-sync-from-makefile` for Makefile sync.

## Out Of Scope

The first version should not include:

- formal slash-command flags
- a standalone dry-run/check mode
- syncing Taskfile-only tasks back into Makefile
- deleting existing Taskfile tasks solely because they are absent from Makefile
- a complete deterministic file-edit engine separate from the existing agent-guided workflow
