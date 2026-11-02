# DeepSource PR report action

Central composite action for `trvny/*` and `travnie/*` repositories.
Reads DeepSource issues for an analyzed commit and updates one marked GitHub Actions
comment on any open same-repository PR whose head still matches that commit.
Includes issues outside PR diffs; skips stale reports. No external Python packages.

## Usage

Caller workflow requires `issues: write`, `pull-requests: read`, `contents: read`.
Run on `status` events where `context` starts with `DeepSource:`, ignoring `pending`.
Composite actions do not declare event triggers. Add a minimal caller job in each
repository that needs PR reporting. Keep unrelated jobs gated against `status` events.

```yaml
- uses: trvny/.github/.github/actions/deepsource-pr-report@PINNED_COMMIT_SHA
  with:
    deepsource-token: ${{ secrets.DEEPSOURCE_PAT }}
    github-token: ${{ github.token }}
    commit-sha: ${{ github.event.sha || inputs.sha }}
```

DeepSource PAT must be configured as an Actions secret in each caller repository
(or an appropriate organization secret). It is never stored in code.
Without the secret, the action exits successfully with a notice.

Only call from trusted events. Don't run external PR code with write tokens.
DeepSource GraphQL requires a PAT with access to the target repository.
