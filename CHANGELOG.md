# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Changed
- Replaced staged Makefile migration slash commands with `/cleat-sync-from-makefile`, a single plan-then-apply workflow for initial Taskfile bootstrap and incremental Makefile coverage sync.

## [0.4.0] - 2026-04-01

### Added
- Opinionated migration defaults for `/cleat-migrate-makefile` with canonical root bias: `dev`, `build`, `test`, `verify`, `deploy`.
- Canonical normalization heuristics for common Make targets (for example `dj-migrate-dev` -> `db:migrate`, `promote` -> `deploy:promote`).
- `proposedSurfaceArtifact` output containing deterministic migration recommendations (root entrypoints, namespaces, renames, ambiguities, production variants).
- Migration confidence scoring with explicit question policy support for guided sessions.
- Tests covering proposed surface output, confidence gating, and promote placement.

### Changed
- Guided migration prompt now defaults to cleat house style and asks questions only for unresolved ambiguities.
- Policy scoring now evaluates root surface using recommended root entrypoints instead of broad safe-target candidate counts.

### Documentation
- Added opinionated migration behavior details to `README.md`.
- Added release notes for this version.
