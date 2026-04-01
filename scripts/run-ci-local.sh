#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
act_bin="${repo_root}/tools/act/bin/act"

if [[ ! -x "${act_bin}" ]]; then
  printf 'act is not installed. Run: npm run install:act\n' >&2
  exit 1
fi

exec "${act_bin}" --bind pull_request -W "${repo_root}/.github/workflows/ci.yml" -j test "$@"
