#!/usr/bin/env bash
set -euo pipefail

root="${1:-${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}}"
pattern='(^|/)(AGENTS|CLAUDE|GEMINI|CODEX)\.md$|(^|/)copilot-instructions\.md$|(^|/)\.github/instructions/.*\.instructions\.md$|(^|/)\.cursor/rules/.*\.mdc$|(^|/)\.(cursorrules|windsurfrules|clinerules)$'

git -C "$root" ls-files | grep -E "$pattern" || true
