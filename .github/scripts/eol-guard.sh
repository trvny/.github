#!/usr/bin/env bash
set -uo pipefail
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
failed=0
checked=0

# Never let a global config decide line endings for us; .gitattributes
# in each repository is the only thing that may. Passed per command
# rather than written with `git config --global`, so running this
# script by hand cannot modify the caller's own git configuration.
noautocrlf=(-c core.autocrlf=false)

while IFS= read -r repository; do
  [ -n "$repository" ] || continue
  checked=$((checked + 1))
  target="$workdir/${repository//\//_}"

  # Ask before cloning. A repository with no .gitattributes has nothing
  # to enforce, and some of these are hundreds of megabytes.
  probe="https://raw.githubusercontent.com/$repository/HEAD/.gitattributes"
  if ! probe_status="$(curl --retry 3 --retry-all-errors --retry-delay 1 \
      --connect-timeout 10 --max-time 30 -sS -o /dev/null -w '%{http_code}' -I "$probe")"; then
    echo "::error::$repository - .gitattributes probe failed"
    failed=1
    continue
  fi
  case "$probe_status" in
    200) ;;
    404)
      echo "$repository - no .gitattributes, nothing to enforce"
      continue
      ;;
    *)
      echo "::error::$repository - .gitattributes probe returned HTTP $probe_status"
      failed=1
      continue
      ;;
  esac

  if ! git "${noautocrlf[@]}" clone --quiet --depth 1 \
      "https://github.com/$repository.git" "$target"; then
    echo "::error::$repository - clone failed"
    failed=1
    continue
  fi

  git "${noautocrlf[@]}" -C "$target" add --renormalize .
  if git -C "$target" diff --cached --quiet; then
    echo "$repository - ok"
    continue
  fi

  failed=1
  echo "::error::$repository stores line endings that contradict its .gitattributes"
  git -C "$target" diff --cached --name-only | sed 's/^/    /'
  {
    echo "### $repository"
    echo
    echo '```'
    git -C "$target" diff --cached --name-only
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
done <<< "$REPOSITORIES"

echo
echo "Checked $checked repositories."
if [ "$failed" -ne 0 ]; then
  echo
  echo "Fix each listed repository in a clone:"
  echo "  git add --renormalize ."
  echo "  git diff --cached --ignore-cr-at-eol --stat  # empty == EOL-only, safe"
  echo "  git commit -m 'chore: renormalize line endings'"
  echo
  echo "If a listed file is meant to keep its bytes verbatim, give it -text"
  echo "or binary in .gitattributes rather than excluding it here."
  exit 1
fi
