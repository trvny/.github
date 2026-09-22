#!/usr/bin/env bash
set -euo pipefail

output="${1:-${RUNNER_TEMP:-/tmp}/never-gonna-deploy-you.wav}"
tmp="${RUNNER_TEMP:-/tmp}"
commit="5595a607ba782bd027e8d4102aa36f556e648015"
rick="$tmp/rickroll-lang-$commit"

if [[ ! -d "$rick/.git" ]]; then
  git init -q "$rick"
  git -C "$rick" remote add origin https://github.com/Rick-Lang/rickroll-lang.git
  git -C "$rick" fetch -q --depth=1 origin "$commit"
  git -C "$rick" checkout -q --detach FETCH_HEAD
fi

mkdir -p "$(dirname "$output")"
python3 - "$rick/src/audios" "$output" <<'PY'
import pathlib
import shutil
import sys
import wave

audio_dir = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
parts = [audio_dir / name for name in ("main.wav", "print.wav", "end.wav")]

try:
    params = None
    frames = []
    for path in parts:
        with wave.open(str(path), "rb") as src:
            current = src.getparams()
            signature = current[:4]
            if params is None:
                params = current
                expected = signature
            elif signature != expected:
                raise ValueError("RickLang WAV parts use incompatible formats")
            frames.append(src.readframes(src.getnframes()))

    with wave.open(str(output), "wb") as dst:
        dst.setparams(params)
        for chunk in frames:
            dst.writeframes(chunk)
except Exception as exc:
    print(f"RickLang WAV concat failed ({exc}); using bundled end.wav", file=sys.stderr)
    shutil.copyfile(parts[-1], output)
PY
