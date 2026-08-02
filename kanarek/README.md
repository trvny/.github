# Kanarek companion

Reusable PR status companion for `trvny/*` repositories.

## Activation

1. Copy `caller.example.yml` to `.github/workflows/kanarek.yml` in the target repository.
2. Adjust `workflow_run.workflows` and `with.watched_workflows` to the exact CI workflow names used by that repository.
3. Add the repository variable `KANAREK_ENABLED=true`.

The caller intentionally uses a short trigger list. For several watched CI workflows, intermediate completions are coalesced and the PR comment is refreshed after the last one finishes.

## Optional secrets

Secrets belong to the calling repository, not to `trvny/.github`:

- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`

Without provider secrets Kanarek uses presets and PR-local memory. Without Cloudflare credentials the shared KV phrase bank is skipped. The Cloudflare token needs Workers KV Storage read/write access.
