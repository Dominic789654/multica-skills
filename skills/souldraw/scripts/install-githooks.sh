#!/bin/sh
set -eu

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

chmod +x "$repo_root/.githooks/pre-commit"
git -C "$repo_root" config core.hooksPath .githooks

echo "Installed git hooks path: .githooks"
echo "pre-commit will now normalize all .json/.jsonl files."
