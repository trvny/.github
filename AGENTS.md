# AGENTS.md

This repository contains the public profile README and assets, reusable GitHub
Actions workflows, and shared GitHub configuration. Treat it as infrastructure:
small-looking changes can affect several repositories.

## Change rules

- When work could overlap ongoing changes, check `main`, open pull requests, and
  recent commits first.
- For reusable workflows, inspect their `workflow_call` interface and known
  callers before changing inputs, secrets, outputs, permissions, or triggers.
- Prefer backward-compatible reusable-workflow interfaces. When a breaking
  change is intentional, update the known callers with it.
- Treat content between generator markers and generated profile assets as owned
  by their generator or workflow; prefer changing the maintained source.
- Keep workflow permissions least-privilege and avoid workflows whose main job
  is pushing a commit that only triggers another workflow.

## GitHub workflow

- When available, use `gptomek[bot]` for commits, comments, review replies, and
  reactions. Open pull requests as `trvny` so external automatic reviews are
  triggered.
- Prefer one logical change per pull request. Truly trivial low-risk edits can
  go directly to `main`.
- Let automatic Codex review handle review when available; treat its findings as
  advisory and apply the useful ones directly.
- Merge after relevant checks pass on the final head commit and actionable
  review threads are resolved. Prefer squash merge.
- Keep pull-request descriptions, comments, and changelogs brief.

## Validation

After reusable-workflow changes, verify the interface and known callers. For
profile automation, verify the owning workflow or generator and its referenced
paths.
