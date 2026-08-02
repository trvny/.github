# AGENTS.md

## Scope

These instructions apply only to the `trvny/.github` repository.

They are not automatically inherited by sibling repositories under
`github.com/trvny`. Each repository that needs agent guidance must keep its own
local `AGENTS.md` or provider entry point.

## Repository role

This repository contains the public profile README and assets, reusable GitHub
Actions workflows, and shared GitHub configuration. Treat it as infrastructure:
small-looking changes can affect several repositories.

## Before changing anything

- Check current `main`, open pull requests, and recent changes.
- For reusable workflows, inspect their `workflow_call` interface and known
  callers before changing inputs, secrets, outputs, permissions, or triggers.
- For profile content, distinguish maintained text from sections and assets
  updated by automation.

## Change rules

- Keep reusable workflow interfaces backward compatible unless the task
  explicitly includes updating every caller.
- Use least-privilege permissions and avoid workflows that exist only to push a
  commit that triggers another workflow.
- Do not hand-edit content between generator markers unless changing the
  generator is intentionally out of scope.
- Do not overwrite generated profile assets without checking the workflow or
  script that owns them.
- Preserve unrelated profile, workflow, and licensing changes.
- Keep comments, pull-request descriptions, and changelogs brief.

## Validation

Use the narrowest relevant checks. At minimum:

- validate edited YAML, JSON, Markdown, or SVG syntax,
- verify referenced paths, actions, workflow names, inputs, and secrets,
- inspect callers after changing a reusable workflow,
- state what was not run or could not be verified.

## GitHub workflow

Keep one logical change per pull request. Truly trivial low-risk edits may go
directly to `main`. Treat Codex review as advisory only; do not ask it to
implement, commit, or push. Merge only after relevant checks pass on the final
head commit and actionable review threads are resolved. Prefer squash merge.
