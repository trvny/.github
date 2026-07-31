# trvny GitHub operating rules

Default rules for work across `github.com/trvny/*`, unless a repository-local
`AGENTS.md` is stricter.

- Inspect the current `main`, open pull requests, and recent changes before editing.
- Keep one logical change per pull request. Truly trivial, low-risk one-line fixes may go directly to `main` when branch protection allows it.
- Make changes directly on the target branch with ordinary commits or GitHub API writes. Never create temporary self-pushing workflows, launcher workflows, or cross-branch workflow workarounds.
- Treat Codex review as advisory only. Never ask Codex to implement fixes, push commits, update branches, resolve conflicts, or perform other GitHub actions. Read its comments, apply valid fixes yourself, and resolve the threads.
- Do not repeatedly trigger `@codex review`. Prefer automatic review, or one final manual review when it is useful. A Codex usage-limit or `action_required` result is not a code or CI failure.
- Merge only after the relevant CI is green on the final head SHA, actionable review threads are resolved, and the final diff is clean. Prefer squash merge.
- If bot or `GITHUB_TOKEN` commits leave missing or stale checks, make a normal commit on the actual branch. Do not build automation whose purpose is to trigger more automation.
- Keep comments, pull-request descriptions, and changelogs brief.
