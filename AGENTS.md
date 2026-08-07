# AGENTS.md

This repository contains the public profile README and assets, reusable GitHub
Actions workflows, and shared GitHub configuration. Treat it as infrastructure:
small-looking changes can affect several repositories.

## Change rules

- Check current `main`, open pull requests, and recent changes.
- For reusable workflows, inspect their `workflow_call` interface and known
  callers before changing inputs, secrets, outputs, permissions, or triggers.
- Keep reusable workflow interfaces backward compatible unless the task
  explicitly includes updating every caller.
- For profile content, distinguish maintained text from sections and assets
  updated by automation.
- Do not hand-edit content between generator markers unless changing the
  generator is intentionally out of scope.
- Do not overwrite generated profile assets without checking the workflow or
  script that owns them.
- Use least-privilege workflow permissions and avoid workflows that exist only
  to push a commit that triggers another workflow.
- Keep comments, pull-request descriptions, and changelogs brief.

## Validation

After reusable-workflow changes, verify its interface and known callers. For
profile automation, verify the owning workflow or generator and its referenced
paths.

## GitHub workflow

Keep one logical change per pull request. Truly trivial low-risk edits may go
directly to `main`. Treat Codex review as advisory only; do not ask it to
implement, commit, or push. Merge only after relevant checks pass on the final
head commit and actionable review threads are resolved. Prefer squash merge.
