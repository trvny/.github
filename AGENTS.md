# AGENTS.md

Working motto:
> one thing at a time, no rush

## Scope

Default rules for work across `github.com/trvny/*`, unless a repository-local
`AGENTS.md` is stricter.

## Collaboration style

- Answer normally instead of launching an agentic
  contraption for a simple question.
- Reply in the user's language. Polish may be casual and direct, without
  corporate filler.
- Lead with the useful part. Expand only as much as the decision or correct
  execution requires.
- Avoid theatrical role-play and prompts such as “world-class principal
  architect.” Demonstrate competence through the result.
- Do not praise every idea automatically. Give honest, concrete feedback.
- Ask questions only when missing information blocks progress or materially
  changes the outcome.
- Do not expose private chain-of-thought. Provide the conclusion, key evidence,
  assumptions, and a way to verify the result.
- Do not end every response with a generic offer to do more.

## Persistence

- Never stop at uncertainty — research or deduce the most reasonable approach and continue.
- Do not ask the human to confirm assumptions — document them, act on them, and adjust mid-task if proven wrong.

## Exploration

- If you are not sure about file content or codebase structure pertaining to the user’s request, use your tools to read files and gather the relevant information: do NOT make up an answer.
- Resolve ambiguity proactively: choose the most probable interpretation based on repo context, conventions, and dependency docs.

## trvny GitHub operating rules

- Inspect the current `main`, open pull requests, and recent changes before editing.
- Keep one logical change per pull request. Truly trivial, low-risk one-line fixes may go directly to `main` when branch protection allows it.
- Make changes directly on the target branch with ordinary commits or GitHub API writes. Avoid create temporary self-pushing workflows, launcher workflows, or cross-branch workflow workarounds.
- Treat Codex review as advisory only. Never ask Codex to implement fixes, push commits, update branches, resolve conflicts, or perform other GitHub actions. Read its comments, apply valid fixes yourself, and resolve the threads. Do not repeatedly trigger `@codex review`. Prefer automatic review, or one final manual review when it is useful. A Codex usage-limit or `action_required` result is not a code or CI failure.
- Merge only after the relevant CI is green on the final head SHA, actionable review threads are resolved, and the final diff is clean. Prefer squash merge.
- If bot or `GITHUB_TOKEN` commits leave missing or stale checks, make a normal commit on the actual branch. Do not build automation whose purpose is to trigger more automation.
- Keep comments, pull-request descriptions, and changelogs brief.

### Repository changes

1. Inspect the existing structure, configuration, and conventions first.
2. Prefer small, reversible changes over broad rewrites.
3. Do not move or delete files without a clear reason.
4. Do not create a framework, abstraction layer, skill, or subagent when a
   normal file or function is enough.
5. Do not duplicate sources of truth. Each configuration domain should have one
   primary home.
6. Preserve the project's existing style unless the task explicitly changes it.
7. Mark or place generated files so they cannot be confused with manually
   maintained sources.
8. Do not modify unrelated files.

### Technical context

Repositories in this namespace may use:
- TypeScript and JavaScript,
- Python,
- Kotlin and Gradle,
- npm,
- JSON, YAML, and TOML,
- Android,
- Cloudflare Workers and Pages,
- LLM tools, skills, MCP servers, and agents.
- others
Do not assume one stack across the whole repository. Detect the local stack
from project files and nearby documentation.

## Validation

Before finishing a task:
- run the existing tests, lint, and build when available and proportionate to
  the change,
- for documentation changes, verify paths, links, and filenames,
- state exactly what was not validated when full verification is not possible.

Start with the narrowest useful check. Broaden validation only when the change
or risk warrants it.

## Knowledge, memory, and maintained wiki

Keep these layers distinct:
- raw or primary sources,
- maintained synthesis or wiki,
- indexes and runtime state,
- conversation memory,
- model inference.

A wiki or memory entry is a navigation and synthesis layer, not automatically
the source of truth. Return to primary sources for exact numbers, quotations,
code, legal text, and high-stakes claims. Surface contradictions instead of
silently blending them away.

## Other model runtimes

- Use `AGENTS.md` as the main repository contract for agents.
- Keep communication style separate from tools, guardrails, permissions,
  routing, and execution policy.
- Keep instructions, tools, handoffs, guardrails, sessions, and tracing as
  separate concerns.
- Read API keys from the environment or a secret manager. Never store them in
  the repository.

## Secrets and security

Never commit:

- Secret API keys,
- GitHub tokens,
- Cloudflare tokens,
- Azure or Microsoft secrets,
- `.env` or `.dev.vars` contents,
- private keys,
- cookies or session data.
