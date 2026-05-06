#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)

required_runtime_files=(
  "package.json"
  "package-lock.json"
  ".opencode/plugins/cleat-entry.js"
  ".opencode/plugins/cleat-plugin.js"
  "tasks.js"
)

missing=()
for path in "${required_runtime_files[@]}"; do
  if ! git -C "$repo_root" ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    missing+=("$path")
  fi
done

if (( ${#missing[@]} > 0 )); then
  printf 'Missing tracked runtime files required for Bun/OpenCode git installs:\n' >&2
  printf ' - %s\n' "${missing[@]}" >&2
  exit 1
fi

tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/cleat-opencode-install.XXXXXX")
trap 'rm -rf "$tmp_root"' EXIT

package_dir="$tmp_root/package"
consumer_dir="$tmp_root/consumer"
mkdir -p "$package_dir" "$consumer_dir"

(
  cd "$repo_root"
  git ls-files -z | tar --null -T - -cf -
) | (
  cd "$package_dir"
  tar -xf -
)

cat > "$consumer_dir/package.json" <<JSON
{
  "private": true,
  "type": "module",
  "dependencies": {
    "cleat": "file:$tmp_root/cleat.tgz"
  }
}
JSON

(
  cd "$package_dir"
  tar -czf "$tmp_root/cleat.tgz" .
)

npx --yes bun install --cwd "$consumer_dir" >/dev/null

node --input-type=module -e "import('file://' + process.argv[1] + '/node_modules/cleat/.opencode/plugins/cleat-entry.js').then(() => process.stdout.write('opencode git install import: PASS\\n'))" "$consumer_dir"
