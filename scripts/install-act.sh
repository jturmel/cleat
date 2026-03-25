#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${ROOT_DIR}/.tools/bin"
ACT_VERSION="${ACT_VERSION:-latest}"

mkdir -p "${BIN_DIR}"

echo "Installing nektos/act@${ACT_VERSION} to ${BIN_DIR}"
GOBIN="${BIN_DIR}" go install "github.com/nektos/act@${ACT_VERSION}"

echo "Installed act at ${BIN_DIR}/act"
"${BIN_DIR}/act" --version
