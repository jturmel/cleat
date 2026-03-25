#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cmd=("${ROOT_DIR}/scripts/act" pull_request -W "${ROOT_DIR}/.github/workflows/ci.yml" --bind)

if git -C "${ROOT_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  common_git_dir="$(git -C "${ROOT_DIR}" rev-parse --path-format=absolute --git-common-dir)"
  cmd+=(--container-options "-v ${common_git_dir}:${common_git_dir}")
fi

cmd+=("$@")

exec "${cmd[@]}"
