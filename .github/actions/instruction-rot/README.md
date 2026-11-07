# Instruction Rot composite action

Checks instruction files belonging to the **calling repository**, not shared
instruction files. The rules and scripts live centrally in
`trvny/.github/.github/actions/instruction-rot/checks/`.

Use after `actions/checkout`; `fetch-depth: 0` enables accurate changed-file
selection. When the comparison commits are unavailable, all tracked supported
instructions are checked. Repositories without instructions pass without
downloading the language runtimes.

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
    persist-credentials: false
- uses: trvny/.github/.github/actions/instruction-rot@<pinned-commit-sha>
  with:
    base-sha: ${{ github.event.pull_request.base.sha || github.event.before }}
    head-sha: ${{ github.event.pull_request.head.sha || github.sha }}
```

The action produces `changed`, `rotcheck`, `yaplint`, and `rickcheck`
outputs. Failed RickLang checks retain their WAV artifact behavior. Callers
own their event triggers and token permissions; this action needs only repository
read access and does not post PR comments.

For CI workflows that cannot run on instruction-only changes, keep the
reusable workflow caller instead of silently dropping coverage.
