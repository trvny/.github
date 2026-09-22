#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}}"
checks_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="${RUNNER_TEMP:-/tmp}"
commit="5595a607ba782bd027e8d4102aa36f556e648015"
rick="$tmp/rickroll-lang-$commit"
manifest="$tmp/instruction-files.txt"

"$checks_root/changed-files.sh" "$repo_root" > "$manifest"
export INSTRUCTION_MANIFEST="$manifest"

if [[ ! -s "$manifest" ]]; then
  echo "rickcheck: no supported instruction files changed"
  exit 0
fi

if [[ ! -d "$rick/.git" ]]; then
  git init -q "$rick"
  git -C "$rick" remote add origin https://github.com/Rick-Lang/rickroll-lang.git
  git -C "$rick" fetch -q --depth=1 origin "$commit"
  git -C "$rick" checkout -q --detach FETCH_HEAD
fi

cd "$repo_root"
python3 "$rick/src/RickRoll.py" \
  "$checks_root/never-gonna-deploy-you.rickroll"
