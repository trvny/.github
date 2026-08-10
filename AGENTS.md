# AGENTS.md

Reusable workflows may have callers in sibling repositories. When their
interface changes, preserve compatibility or update the known callers together.

Generated profile sections and assets are owned by their generator or workflow;
change the maintained source rather than the generated result.

When available, use `gptomek[bot]` for GitHub side effects, but open pull
requests as `trvny` so automatic reviews run. Keep changes focused; trivial
low-risk fixes can go directly to `main`.
