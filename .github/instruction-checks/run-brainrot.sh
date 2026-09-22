#!/usr/bin/env bash
set -euo pipefail

program="${1:-}"
repo_root="${2:-${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}}"
case "$program" in
  rotcheck|yaplint) ;;
  *)
    echo "usage: $0 {rotcheck|yaplint} [repo-root]" >&2
    exit 2
    ;;
esac

checks_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="${RUNNER_TEMP:-/tmp}"
version="v0.5.3"
platform="linux-amd64"
archive="brainrot-${version}-${platform}.tar.gz"
tarball="$tmp/$archive"
install_dir="$tmp/brainrot-${version}-${platform}-unpacked"
sha256="4383eb930451bd163b6545f9c51ee78970beea9af982d4d32f2e56c25c9ec638"

curl --fail --location --silent --show-error --retry 3 \
  "https://github.com/Brainrotlang/brainrot/releases/download/${version}/${archive}" \
  --output "$tarball"
printf '%s  %s\n' "$sha256" "$tarball" | sha256sum --check --status
rm -rf "$install_dir"
mkdir -p "$install_dir"
tar -xzf "$tarball" -C "$install_dir"

brainrot="$(find "$install_dir" -type f -name brainrot -perm -u+x -print -quit)"
if [[ -z "$brainrot" ]]; then
  echo "brainrot binary not found after extraction" >&2
  exit 1
fi

manifest="$tmp/instruction-files.txt"
"$checks_root/changed-files.sh" "$repo_root" > "$manifest"

if [[ ! -s "$manifest" ]]; then
  echo "$program: no supported instruction files changed"
  exit 0
fi

status=0
while IFS= read -r file; do
  cp -- "$repo_root/$file" /tmp/instruction-check.md
  echo "::group::$program: $file"
  if ! "$brainrot" "$checks_root/${program}.brainrot"; then
    status=1
  fi
  echo "::endgroup::"
done < "$manifest"

exit "$status"
