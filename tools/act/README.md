# Local GitHub Workflow Testing

This repo supports local execution of `.github/workflows/ci.yml` with `act`.

## Why this exists

- fast feedback when editing CI workflows
- reproducible local run for the `test` job before pushing

## Install pinned act version

From repo root:

```bash
npm run install:act
```

This installs `act` to `tools/act/bin/act`.

## Run local CI

```bash
npm run test:workflow
```

This executes the `test` job from `.github/workflows/ci.yml`.

## Pass extra act arguments

```bash
npm run test:workflow -- --verbose
npm run test:workflow -- --container-architecture linux/amd64
```
