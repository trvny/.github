#!/usr/bin/env bash
set -euo pipefail

root="${1:-${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}}"
pattern='(^|/)(AGENTS|CLAUDE|GEMINI|CODEX)\.md$|(^|/)copilot-instructions\.md$|(^|/)\.github/instructions/.*\.instructions\.md$|(^|/)\.cursor/rules/.*\.mdc$|(^|/)\.(cursorrules|windsurfrules|clinerules)$'
base="${BASE_SHA:-}"
head="${HEAD_SHA:-${GITHUB_SHA:-HEAD}}"

list_all() {
  git -C "$root" ls-files | grep -E "$pattern" || true
}

if [[ -z "$base" || "$base" =~ ^0+$ ]] ||
  ! git -C "$root" cat-file -e "${base}^{commit}" 2>/dev/null ||
  ! git -C "$root" cat-file -e "${head}^{commit}" 2>/dev/null; then
  list_all
  exit 0
fi

mapfile -t changed < <(
  git -C "$root" diff --name-only --diff-filter=ACMRT "$base" "$head"
)
matched=0

for path in "${changed[@]}"; do
  if [[ "$path" =~ $pattern && -f "$root/$path" ]]; then
    printf '%s\n' "$path"
    matched=1
  fi
done

if (( matched == 0 )); then
  for path in "${changed[@]}"; do
    case "$path" in
      .github/instruction-checks/*|.github/workflows/instruction-rot.yml)
        list_all
        break
        ;;
    esac
  done
fi
