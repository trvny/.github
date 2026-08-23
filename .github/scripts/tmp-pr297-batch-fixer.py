from pathlib import Path
import runpy

fixer = Path('gh-apps/kanarek-companion/scripts/.tmp-fix-pr297-p2.py')
if not fixer.is_file():
    raise SystemExit('private PR 297 fixer missing')
runpy.run_path(str(fixer), run_name='__main__')
