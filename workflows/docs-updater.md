---
on:
  schedule: weekly

permissions:
  contents: read
  pull-requests: read

engine: gemini

safe-outputs:
  create-pull-request:
    branch: docs/automation
    title-prefix: "[docs] "
    draft: true
---

# Documentation Updater

Review code and documentation changes from the last seven days and detect meaningful documentation drift.

Update only documentation that is demonstrably stale: setup steps, configuration and option descriptions, examples, commands, paths, architecture notes, or user-facing behavior that no longer matches the repository.

Follow the repository's `AGENTS.md`, documentation structure, terminology, and local style. Prefer improving existing documentation over creating parallel files. When localized counterparts exist, keep them aligned where the same change applies.

Keep changes narrow. Do not modify product code, generated files, release artifacts, or changelogs unless repository instructions explicitly require it.

If documentation is already accurate, do not open a pull request. Otherwise open one concise draft pull request describing what drift was corrected and anything that still needs human review.
