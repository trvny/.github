from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)


def replace_between(text: str, start: str, end: str, new: str, label: str) -> str:
    first = text.find(start)
    if first < 0:
        raise SystemExit(f"{label}: start marker missing")
    second = text.find(end, first + len(start))
    if second < 0:
        raise SystemExit(f"{label}: end marker missing")
    return text[:first] + new + text[second:]


path = Path("gh-apps/kanarek-companion/src/code-change-orchestration.ts")
text = path.read_text()

if "recoveryHistoryBlockers(" in text:
    old_helper_start = "export type RecoveryCommitSnapshot = {"
    old_helper_end = "class CodeChangeError extends Error {"
    new_helper = """export function recoveryScopeBlockers(targetPaths: string[], files: string[]): string[] {
  const allowed = new Set(targetPaths);
  const blockers = files
    .filter((path) => !allowed.has(path))
    .map((path) => `outside_scope:${path}`);
  if (files.length > allowed.size) blockers.push('too_many_changed_paths');
  return [...new Set(blockers)];
}

"""
    text = replace_between(text, old_helper_start, old_helper_end, new_helper, "recovery scope helper")

    new_recovery = """async function recoverBranchHistory(
  source: Request,
  invoke: Invoke,
  core: CoreInput,
  currentHead: string,
  currentDefaultSha: string,
): Promise<{ revision: number; touchedPaths: string[] }> {
  if (currentHead === core.expectedBaseSha) return { revision: 0, touchedPaths: [] };
  const ancestry = await readData(
    source,
    invoke,
    `/repos/${repoPath(core.repository)}/compare/${core.expectedBaseSha}...${currentHead}?per_page=1`,
  );
  if (!isObject(ancestry)) throw new CodeChangeError('invalid_compare_response', 502);
  const mergeBase = isObject(ancestry.merge_base_commit) ? stringValue(ancestry.merge_base_commit.sha) : null;
  const aheadBy = numberValue(ancestry.ahead_by);
  if (
    mergeBase?.toLowerCase() !== core.expectedBaseSha ||
    ancestry.status !== 'ahead' ||
    aheadBy === null ||
    aheadBy < 1 ||
    aheadBy > 10_000
  ) {
    throw new CodeChangeError('unsafe_recovery_history', 409);
  }

  const scope = await readData(
    source,
    invoke,
    `/repos/${repoPath(core.repository)}/compare/${currentDefaultSha}...${currentHead}?per_page=1`,
  );
  if (!isObject(scope)) throw new CodeChangeError('invalid_compare_response', 502);
  const status = stringValue(scope.status);
  if (!Array.isArray(scope.files) && status !== 'identical' && status !== 'behind') {
    throw new CodeChangeError('invalid_compare_response', 502);
  }
  const filesRaw = Array.isArray(scope.files) ? scope.files : [];
  const files = filesRaw.map((file) => (isObject(file) ? stringValue(file.filename) : null));
  if (files.some((file) => !file)) throw new CodeChangeError('invalid_compare_response', 502);
  const touchedPaths = [...new Set(files as string[])];
  const blockers = recoveryScopeBlockers(core.targetPaths, touchedPaths);
  if (blockers.length) {
    throw new CodeChangeError('unsafe_recovery_history', 409, { blockers });
  }
  return { revision: aheadBy, touchedPaths };
}

"""
    text = replace_between(
        text,
        "async function recoverBranchHistory(",
        "async function recoveredOpenPullRequest(",
        new_recovery,
        "recovery history implementation",
    )

    text = replace_once(
        text,
        "const commits = await recoverBranchHistory(source, invoke, core, currentBranch);",
        "const recovery = await recoverBranchHistory(source, invoke, core, currentBranch, currentBase.sha);",
        "recovery call",
    )
    text = replace_once(
        text,
        """    recovery: {
      revision: commits.length,
      touchedPaths: [...new Set(commits.flatMap((commit) => commit.files))],
    },
""",
        "    recovery,\n",
        "recovery payload",
    )
    path.write_text(text)


test_path = Path("gh-apps/kanarek-companion/test/code-change-orchestration.test.ts")
test = test_path.read_text()
if "recoveryHistoryBlockers" in test:
    test = test.replace("recoveryHistoryBlockers", "recoveryScopeBlockers")
    start = "test('recovery history only accepts a linear chain inside declared targets', () => {"
    end = "test('review gate requires exact base, reviewed head and successful final CI', () => {"
    new_test = """test('recovery scope only accepts the final diff inside declared targets', () => {
  assert.deepEqual(recoveryScopeBlockers(['src/a.ts'], ['src/a.ts']), []);
  assert.deepEqual(
    recoveryScopeBlockers(['src/a.ts'], ['src/a.ts', 'src/other.ts']),
    ['outside_scope:src/other.ts', 'too_many_changed_paths'],
  );
});

"""
    test = replace_between(test, start, end, new_test, "recovery scope test")
    test_path.write_text(test)
