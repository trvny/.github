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


code_path = Path("gh-apps/kanarek-companion/src/code-change-orchestration.ts")
code = code_path.read_text()

if "recoverBranchHistory(" not in code:
    old_types = """type EditFile = { path: string; content: string | null };
type EditAction = { type: 'edit'; message: string; files: EditFile[] };
type VerificationAction = {
  type: 'verification';
  status: 'passed' | 'failed' | 'unavailable';
  reason?: string;
  results?: JsonObject[];
  pullRequest?: { title: string; body: string };
};
"""
    new_types = """type EditFile = { path: string; content: string | null };
type EditAction = { type: 'edit'; message: string; files: EditFile[] };
type VerificationResult = JsonObject & {
  status: 'passed' | 'failed';
  cwd: string;
  command: string;
};
type VerificationAction = {
  type: 'verification';
  status: 'passed' | 'failed' | 'unavailable';
  verifiedHeadSha: string;
  reason?: string;
  results?: VerificationResult[];
  pullRequest?: { title: string; body: string };
};
"""
    code = replace_once(code, old_types, new_types, "verification types")

    marker = "class CodeChangeError extends Error {"
    recovery_types = """export type RecoveryCommitSnapshot = {
  sha: string;
  parentSha: string;
  files: string[];
};

export function recoveryHistoryBlockers(
  expectedBaseSha: string,
  currentHead: string,
  targetPaths: string[],
  commits: RecoveryCommitSnapshot[],
): string[] {
  const allowed = new Set(targetPaths);
  const blockers: string[] = [];
  let previous = expectedBaseSha.toLowerCase();
  for (const commit of commits) {
    if (commit.parentSha.toLowerCase() !== previous) {
      blockers.push(`parent_changed:${commit.sha}`);
    }
    for (const path of commit.files) {
      if (!allowed.has(path)) blockers.push(`outside_scope:${path}`);
    }
    previous = commit.sha.toLowerCase();
  }
  if (previous !== currentHead.toLowerCase()) blockers.push('head_not_reached');
  return [...new Set(blockers)];
}

"""
    code = replace_once(code, marker, recovery_types + marker, "recovery helper")

    verification_results = """function verificationResults(value: unknown): VerificationResult[] {
  if (!Array.isArray(value) || value.length > 30) {
    throw new CodeChangeError('invalid_verification_results');
  }
  return value.map((entry) => {
    if (!isObject(entry) || (entry.status !== 'passed' && entry.status !== 'failed')) {
      throw new CodeChangeError('invalid_verification_result');
    }
    const cwd = requiredText(entry.cwd, 'verification_cwd', 2_000);
    const command = requiredText(entry.command, 'verification_command', 16_000);
    return { ...entry, status: entry.status, cwd, command } as VerificationResult;
  });
}

"""
    code = replace_once(
        code,
        "function action(value: unknown, scope: string[]): Action | undefined {",
        verification_results + "function action(value: unknown, scope: string[]): Action | undefined {",
        "verification result parser",
    )

    new_verification_action = """  if (value.type === 'verification') {
    if (value.status !== 'passed' && value.status !== 'failed' && value.status !== 'unavailable') {
      throw new CodeChangeError('invalid_verification_status');
    }
    const verifiedHeadSha = expectedSha(value.verifiedHeadSha, 'verified_head_sha');
    const reason = value.reason === undefined ? undefined : requiredText(value.reason, 'verification_reason', 2_000);
    if (value.status === 'unavailable' && !reason) throw new CodeChangeError('verification_reason_required');
    const results = value.results === undefined ? undefined : verificationResults(value.results);
    let pullRequest: VerificationAction['pullRequest'];
    if (value.pullRequest !== undefined) {
      if (!isObject(value.pullRequest)) throw new CodeChangeError('invalid_pull_request');
      pullRequest = {
        title: requiredText(value.pullRequest.title, 'pull_request_title', 500),
        body: typeof value.pullRequest.body === 'string' && value.pullRequest.body.length <= 8_000
          ? value.pullRequest.body
          : '',
      };
    }
    return {
      type: 'verification',
      status: value.status,
      verifiedHeadSha,
      ...(reason ? { reason } : {}),
      ...(results ? { results } : {}),
      ...(pullRequest ? { pullRequest } : {}),
    };
  }
"""
    code = replace_between(
        code,
        "  if (value.type === 'verification') {",
        "  if (value.type === 'review') {",
        new_verification_action,
        "verification action parser",
    )

    optional_branch = """async function optionalBranchHead(
  source: Request,
  invoke: Invoke,
  core: CoreInput,
): Promise<string | null> {
  const { response, payload } = await invokePayload(
    source,
    invoke,
    READ_PATH,
    { path: `/repos/${repoPath(core.repository)}/git/ref/heads/${refPath(core.branch)}` },
    true,
  );
  if (response.status === 404) return null;
  if (!response.ok || payload.ok !== true) {
    throw new CodeChangeError(
      typeof payload.error === 'string' ? payload.error : 'branch_ref_read_failed',
      response.status,
    );
  }
  const raw = payload.data;
  const sha = isObject(raw) && isObject(raw.object) ? stringValue(raw.object.sha) : null;
  if (!sha || !SHA_RE.test(sha)) throw new CodeChangeError('invalid_branch_ref_response', 502);
  return sha.toLowerCase();
}

"""
    code = replace_once(
        code,
        "async function branchHead(source: Request, invoke: Invoke, core: CoreInput): Promise<string> {",
        optional_branch + "async function branchHead(source: Request, invoke: Invoke, core: CoreInput): Promise<string> {",
        "optional branch head",
    )

    recovery_functions = """async function assertExpectedBaseAncestor(
  source: Request,
  invoke: Invoke,
  core: CoreInput,
  headSha: string,
): Promise<void> {
  if (headSha === core.expectedBaseSha) return;
  const raw = await readData(
    source,
    invoke,
    `/repos/${repoPath(core.repository)}/compare/${core.expectedBaseSha}...${headSha}?per_page=1`,
  );
  if (!isObject(raw)) throw new CodeChangeError('invalid_compare_response', 502);
  const mergeBase = isObject(raw.merge_base_commit) ? stringValue(raw.merge_base_commit.sha) : null;
  if (mergeBase?.toLowerCase() !== core.expectedBaseSha || raw.status !== 'ahead') {
    throw new CodeChangeError('unsafe_recovery_base', 409);
  }
}

async function recoverBranchHistory(
  source: Request,
  invoke: Invoke,
  core: CoreInput,
  currentHead: string,
): Promise<RecoveryCommitSnapshot[]> {
  if (currentHead === core.expectedBaseSha) return [];
  const raw = await readData(
    source,
    invoke,
    `/repos/${repoPath(core.repository)}/compare/${core.expectedBaseSha}...${currentHead}?per_page=100`,
  );
  if (!isObject(raw)) throw new CodeChangeError('invalid_compare_response', 502);
  const mergeBase = isObject(raw.merge_base_commit) ? stringValue(raw.merge_base_commit.sha) : null;
  const aheadBy = numberValue(raw.ahead_by);
  const summaries = Array.isArray(raw.commits) ? raw.commits.filter(isObject) : [];
  if (
    mergeBase?.toLowerCase() !== core.expectedBaseSha ||
    raw.status !== 'ahead' ||
    aheadBy === null ||
    aheadBy < 1 ||
    aheadBy > 100 ||
    summaries.length !== aheadBy
  ) {
    throw new CodeChangeError('unsafe_recovery_history', 409);
  }

  const commits: RecoveryCommitSnapshot[] = [];
  for (const summary of summaries) {
    const sha = stringValue(summary.sha);
    if (!sha || !SHA_RE.test(sha)) throw new CodeChangeError('invalid_recovery_commit', 502);
    const detail = await readData(
      source,
      invoke,
      `/repos/${repoPath(core.repository)}/commits/${sha}`,
    );
    if (!isObject(detail) || !Array.isArray(detail.parents) || detail.parents.length !== 1) {
      throw new CodeChangeError('unsafe_recovery_history', 409, { commit: sha });
    }
    const parent = isObject(detail.parents[0]) ? stringValue(detail.parents[0].sha) : null;
    if (!parent || !SHA_RE.test(parent)) throw new CodeChangeError('invalid_recovery_commit', 502);
    const filesRaw = Array.isArray(detail.files) ? detail.files : [];
    const files = filesRaw.map((file) => (isObject(file) ? stringValue(file.filename) : null));
    if (files.some((path) => !path)) throw new CodeChangeError('invalid_recovery_commit', 502);
    commits.push({
      sha: sha.toLowerCase(),
      parentSha: parent.toLowerCase(),
      files: files as string[],
    });
  }

  const blockers = recoveryHistoryBlockers(
    core.expectedBaseSha,
    currentHead,
    core.targetPaths,
    commits,
  );
  if (blockers.length) {
    throw new CodeChangeError('unsafe_recovery_history', 409, { blockers });
  }
  return commits;
}

async function recoveredOpenPullRequest(
  source: Request,
  invoke: Invoke,
  core: CoreInput,
  currentHead: string,
  defaultBranch: string,
): Promise<PullRequestProgress | undefined> {
  const raw = await readData(
    source,
    invoke,
    `/repos/${repoPath(core.repository)}/pulls?state=open&head=${encodeURIComponent(`trvny:${core.branch}`)}&per_page=10`,
  );
  const matches = Array.isArray(raw) ? raw.filter(isObject) : [];
  if (matches.length > 1) throw new CodeChangeError('ambiguous_pull_request', 409);
  const pullRequest = matches[0];
  if (!pullRequest) return undefined;
  const head = isObject(pullRequest.head) ? pullRequest.head : {};
  const base = isObject(pullRequest.base) ? pullRequest.base : {};
  const number = numberValue(pullRequest.number);
  const headSha = stringValue(head.sha);
  if (
    !number ||
    stringValue(pullRequest.state) !== 'open' ||
    typeof pullRequest.merged_at === 'string' ||
    stringValue(head.ref) !== core.branch ||
    !headSha ||
    headSha.toLowerCase() !== currentHead ||
    stringValue(base.ref) !== defaultBranch
  ) {
    throw new CodeChangeError('unsafe_recovery_pull_request', 409);
  }
  return {
    number,
    headSha: currentHead,
    htmlUrl: stringValue(pullRequest.html_url),
  };
}

"""
    code = replace_once(
        code,
        "async function preparationContext(",
        recovery_functions + "async function preparationContext(",
        "recovery functions",
    )

    new_preparation = """async function preparationContext(source: Request, invoke: Invoke, core: CoreInput): Promise<JsonObject> {
  const prepareBody: JsonObject = {
    repository: core.repository,
    branch: core.branch,
    expectedBaseSha: core.expectedBaseSha,
    targetPaths: core.targetPaths,
    ...(core.issueNumber ? { issueNumber: core.issueNumber } : {}),
  };
  const prepared = await invokePayload(source, invoke, PREPARE_CHANGE_PATH, prepareBody, true);
  if (prepared.response.ok && prepared.payload.ok === true) return prepared.payload;

  const error = stringValue(prepared.payload.error) ?? `action_${prepared.response.status}`;
  const recoverable = new Set(['branch_already_exists', 'pull_request_already_exists', 'base_head_changed']);
  if (!recoverable.has(error)) {
    throw new CodeChangeError(error, prepared.response.status, prepared.payload);
  }

  const currentBranch = await optionalBranchHead(source, invoke, core);
  if (!currentBranch) {
    throw new CodeChangeError(error, prepared.response.status, prepared.payload);
  }
  const currentBase = await defaultBranchHead(source, invoke, core);
  await assertExpectedBaseAncestor(source, invoke, core, currentBase.sha);
  const commits = await recoverBranchHistory(source, invoke, core, currentBranch);
  const [guidance, pullRequest] = await Promise.all([
    targetGuidance(source, invoke, core, currentBranch),
    recoveredOpenPullRequest(source, invoke, core, currentBranch, currentBase.defaultBranch),
  ]);
  return {
    ok: true,
    recovered: true,
    repository: {
      name: core.repository,
      defaultBranch: currentBase.defaultBranch,
      baseSha: core.expectedBaseSha,
      currentDefaultSha: currentBase.sha,
    },
    branch: { name: core.branch, sha: currentBranch, created: false },
    agentGuidance: guidance,
    recovery: {
      revision: commits.length,
      touchedPaths: [...new Set(commits.flatMap((commit) => commit.files))],
    },
    ...(pullRequest ? { pullRequest } : {}),
  };
}

"""
    code = replace_between(
        code,
        "async function preparationContext(",
        "async function investigationContext(",
        new_preparation,
        "preparation context",
    )

    new_initial = """async function initialProgress(
  source: Request,
  invoke: Invoke,
  core: CoreInput,
): Promise<{ progress: Progress; body: JsonObject }> {
  const prepared = await preparationContext(source, invoke, core);
  const repositoryData = isObject(prepared.repository) ? prepared.repository : {};
  const branchData = isObject(prepared.branch) ? prepared.branch : {};
  const recoveryData = isObject(prepared.recovery) ? prepared.recovery : {};
  const defaultBranch = stringValue(repositoryData.defaultBranch);
  const branchHeadSha = stringValue(branchData.sha);
  if (!defaultBranch || !branchHeadSha || !SHA_RE.test(branchHeadSha)) {
    throw new CodeChangeError('invalid_prepare_change_response', 502);
  }
  const revision = numberValue(recoveryData.revision) ?? 0;
  const pullRequestData = isObject(prepared.pullRequest) ? prepared.pullRequest : null;
  let pullRequest: PullRequestProgress | undefined;
  if (pullRequestData) {
    const number = numberValue(pullRequestData.number);
    const headSha = stringValue(pullRequestData.headSha);
    if (!number || !headSha || headSha.toLowerCase() !== branchHeadSha.toLowerCase()) {
      throw new CodeChangeError('invalid_recovered_pull_request', 502);
    }
    pullRequest = {
      number,
      headSha: headSha.toLowerCase(),
      htmlUrl: stringValue(pullRequestData.htmlUrl),
    };
  }

  const recoveredEvolved = branchHeadSha.toLowerCase() !== core.expectedBaseSha || Boolean(pullRequest);
  const progress: Progress = {
    stage: recoveredEvolved ? 'verifying' : 'editing',
    defaultBranch,
    branchHead: branchHeadSha.toLowerCase(),
    revision,
    ...(pullRequest ? { pullRequest } : {}),
  };

  if (progress.stage === 'verifying') {
    const verificationPlan = await targetedVerification(source, invoke, core, progress.branchHead);
    return {
      progress,
      body: {
        ok: true,
        recovered: true,
        stage: 'verifying',
        revision: progress.revision,
        headSha: progress.branchHead,
        verificationPlan,
        finalGate: 'Recovered branch state must be freshly verified before PR creation or final review.',
        nextAction: {
          type: 'verification',
          verifiedHeadSha: progress.branchHead,
          allowedStatuses: ['passed', 'failed', 'unavailable'],
        },
      },
    };
  }

  const [investigated, targetFiles] = await Promise.all([
    investigationContext(source, invoke, core, progress.branchHead),
    targetFileSnapshots(source, invoke, core, progress.branchHead),
  ]);
  return {
    progress,
    body: {
      ok: true,
      stage: 'editing',
      goal: core.goal,
      branch: { name: core.branch, headSha: progress.branchHead },
      preparation: prepared,
      targetFiles,
      ...investigated,
      nextAction: {
        type: 'edit',
        note: 'Use targetFiles as the authoritative full snapshot. Submit complete replacement contents only for declared targetPaths; missing targets are marked exists:false.',
      },
    },
  };
}

"""
    code = replace_between(
        code,
        "async function initialProgress(",
        "async function run(",
        new_initial,
        "initial progress",
    )

    old_edit = """      if (progress.stage === 'waiting_ci_review') {
        await assertPullRequestEditable(request, invoke, core, progress);
      }
      const newHead = await commitEdit(request, invoke, core, progress, submitted);
"""
    new_edit = """      let newHead: string;
      if (progress.stage === 'waiting_ci_review') {
        const currentHead = await branchHead(request, invoke, core);
        if (currentHead === progress.branchHead) {
          await assertPullRequestEditable(request, invoke, core, progress);
          newHead = await commitEdit(request, invoke, core, progress, submitted);
        } else {
          const recovered = await verifyRecoveredCommit(
            request,
            invoke,
            core,
            progress.branchHead,
            currentHead,
            submitted,
          );
          if (!recovered) {
            throw new CodeChangeError('branch_head_changed', 409, {
              expected: progress.branchHead,
              current: currentHead,
            });
          }
          const recoveredProgress: Progress = {
            ...progress,
            branchHead: currentHead,
            pullRequest: progress.pullRequest
              ? { ...progress.pullRequest, headSha: currentHead }
              : undefined,
          };
          await assertPullRequestEditable(request, invoke, core, recoveredProgress);
          newHead = currentHead;
        }
      } else {
        newHead = await commitEdit(request, invoke, core, progress, submitted);
      }
"""
    code = replace_once(code, old_edit, new_edit, "follow-up recovery ordering")

    old_verification_start = """      if (progress.stage !== 'verifying') {
        throw new CodeChangeError('verification_not_allowed_in_stage', 409, { stage: progress.stage });
      }
      const verificationPlan = await targetedVerification(request, invoke, core, progress.branchHead);
"""
    new_verification_start = """      if (progress.stage !== 'verifying') {
        throw new CodeChangeError('verification_not_allowed_in_stage', 409, { stage: progress.stage });
      }
      if (submitted.verifiedHeadSha !== progress.branchHead) {
        throw new CodeChangeError('verified_head_changed', 409, {
          verified: submitted.verifiedHeadSha,
          expected: progress.branchHead,
        });
      }
      const verificationPlan = await targetedVerification(request, invoke, core, progress.branchHead);
"""
    code = replace_once(code, old_verification_start, new_verification_start, "verification head binding")

    old_edit_next = """        headSha: newHead,
        verificationPlan,
        finalGate: 'Normal repository CI on the final PR head remains mandatory.',
        nextAction: { type: 'verification', allowedStatuses: ['passed', 'failed', 'unavailable'] },
"""
    new_edit_next = """        headSha: newHead,
        verificationPlan,
        finalGate: 'Normal repository CI on the final PR head remains mandatory.',
        nextAction: {
          type: 'verification',
          verifiedHeadSha: newHead,
          allowedStatuses: ['passed', 'failed', 'unavailable'],
        },
"""
    code = replace_once(code, old_edit_next, new_edit_next, "edit verification next action")

    old_resume_next = """        headSha: progress.branchHead,
        verificationPlan,
        finalGate: 'Normal repository CI on the final PR head remains mandatory.',
        nextAction: { type: 'verification', allowedStatuses: ['passed', 'failed', 'unavailable'] },
"""
    new_resume_next = """        headSha: progress.branchHead,
        verificationPlan,
        finalGate: 'Normal repository CI on the final PR head remains mandatory.',
        nextAction: {
          type: 'verification',
          verifiedHeadSha: progress.branchHead,
          allowedStatuses: ['passed', 'failed', 'unavailable'],
        },
"""
    code = replace_once(code, old_resume_next, new_resume_next, "resume verification next action")

    old_openapi_verification = """                    {
                      type: 'object',
                      required: ['type', 'status'],
                      properties: {
                        type: { type: 'string', enum: ['verification'] },
                        status: { type: 'string', enum: ['passed', 'failed', 'unavailable'] },
                        reason: { type: 'string' },
                        results: { type: 'array', items: { type: 'object', properties: {} } },
                        pullRequest: {
                          type: 'object',
                          required: ['title'],
                          properties: { title: { type: 'string' }, body: { type: 'string' } },
                        },
                      },
                    },
"""
    new_openapi_verification = """                    {
                      type: 'object',
                      required: ['type', 'status', 'verifiedHeadSha'],
                      properties: {
                        type: { type: 'string', enum: ['verification'] },
                        status: { type: 'string', enum: ['passed', 'failed', 'unavailable'] },
                        verifiedHeadSha: {
                          type: 'string',
                          description: 'Exact branch head SHA that these verification results were run against.',
                        },
                        reason: { type: 'string' },
                        results: {
                          type: 'array',
                          items: {
                            type: 'object',
                            required: ['status', 'cwd', 'command'],
                            properties: {
                              status: { type: 'string', enum: ['passed', 'failed'] },
                              cwd: { type: 'string' },
                              command: { type: 'string' },
                            },
                            additionalProperties: true,
                          },
                        },
                        pullRequest: {
                          type: 'object',
                          required: ['title'],
                          properties: { title: { type: 'string' }, body: { type: 'string' } },
                        },
                      },
                    },
"""
    code = replace_once(code, old_openapi_verification, new_openapi_verification, "verification OpenAPI")
    code = replace_once(
        code,
        "function verificationEvidenceMissing(plan: JsonObject, results: JsonObject[]): string[] {",
        "function verificationEvidenceMissing(plan: JsonObject, results: VerificationResult[]): string[] {",
        "verification evidence type",
    )
    code_path.write_text(code)


gpt_path = Path("gh-apps/kanarek-companion/src/gpt-actions.ts")
gpt = gpt_path.read_text()
if "existingPathMode(" not in gpt:
    mode_helpers = """type PreservedBlobMode = '100644' | '100755' | '120000';
type GitTreeEntry = { path?: string; mode?: string; type?: string; sha?: string };

export function preservedBlobMode(value: unknown): PreservedBlobMode {
  if (value === undefined || value === null || value === '100644') return '100644';
  if (value === '100755' || value === '120000') return value;
  throw new ActionError('unsupported_file_mode', 409);
}

async function gitTreeEntries(
  client: GitHubInstallationClient,
  repositoryName: string,
  treeSha: string,
  cache: Map<string, GitTreeEntry[]>,
): Promise<GitTreeEntry[]> {
  const cached = cache.get(treeSha);
  if (cached) return cached;
  const data = await client.json<{ tree?: GitTreeEntry[]; truncated?: boolean }>(
    `/repos/${repoPath(repositoryName)}/git/trees/${treeSha}`,
    'gpt_action_get_tree',
  );
  if (!Array.isArray(data.tree) || data.truncated === true) {
    throw new ActionError('invalid_tree_response', 502);
  }
  cache.set(treeSha, data.tree);
  return data.tree;
}

async function existingPathMode(
  client: GitHubInstallationClient,
  repositoryName: string,
  rootTreeSha: string,
  path: string,
  cache: Map<string, GitTreeEntry[]>,
): Promise<PreservedBlobMode> {
  let treeSha = rootTreeSha;
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    const entries = await gitTreeEntries(client, repositoryName, treeSha, cache);
    const entry = entries.find((candidate) => candidate.path === parts[index]);
    if (!entry) return '100644';
    const last = index === parts.length - 1;
    if (last) {
      if (entry.type !== 'blob' || !entry.sha || !SHA_RE.test(entry.sha)) {
        throw new ActionError('path_not_editable_blob', 409);
      }
      return preservedBlobMode(entry.mode);
    }
    if (entry.type !== 'tree' || !entry.sha || !SHA_RE.test(entry.sha)) {
      throw new ActionError('path_parent_not_tree', 409);
    }
    treeSha = entry.sha;
  }
  return '100644';
}

"""
    gpt = replace_once(gpt, "async function commitFiles(\n", mode_helpers + "async function commitFiles(\n", "mode helpers")

    old_tree = """  const tree = await Promise.all(
    files.map(async (file) => {
      if (file.content === null) {
        return { path: file.path, mode: '100644', type: 'blob', sha: null };
      }
      const blob = await client.json<{ sha?: string }>(
        `/repos/${repoPath(repositoryName)}/git/blobs`,
        'gpt_action_create_blob',
        {
          method: 'POST',
          body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
        },
      );
      if (!blob.sha || !SHA_RE.test(blob.sha)) throw new ActionError('invalid_created_blob', 502);
      return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
    }),
  );
"""
    new_tree = """  const treeCache = new Map<string, GitTreeEntry[]>();
  const modes = await Promise.all(
    files.map((file) => existingPathMode(
      client,
      repositoryName,
      baseCommit.tree.sha,
      file.path,
      treeCache,
    )),
  );
  const tree = await Promise.all(
    files.map(async (file, index) => {
      const mode = modes[index];
      if (file.content === null) {
        return { path: file.path, mode, type: 'blob', sha: null };
      }
      const blob = await client.json<{ sha?: string }>(
        `/repos/${repoPath(repositoryName)}/git/blobs`,
        'gpt_action_create_blob',
        {
          method: 'POST',
          body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
        },
      );
      if (!blob.sha || !SHA_RE.test(blob.sha)) throw new ActionError('invalid_created_blob', 502);
      return { path: file.path, mode, type: 'blob', sha: blob.sha };
    }),
  );
"""
    gpt = replace_once(gpt, old_tree, new_tree, "commit tree modes")
    gpt = replace_once(
        gpt,
        "'Preferred way to edit repository files. Requires the expected branch head SHA to prevent overwriting concurrent work. content=null deletes a file.',",
        "'Preferred way to edit repository files. Requires the expected branch head SHA to prevent overwriting concurrent work. Existing regular, executable and symlink blob modes are preserved automatically; new files default to 100644. content=null deletes a file.',",
        "commitFiles OpenAPI description",
    )
    gpt_path.write_text(gpt)


test_path = Path("gh-apps/kanarek-companion/test/code-change-orchestration.test.ts")
test_text = test_path.read_text()
if "recovery history only accepts" not in test_text:
    test_text = replace_once(
        test_text,
        """  addCodeChangeAutopilotOpenApi,
  reviewGateBlockers,
""",
        """  addCodeChangeAutopilotOpenApi,
  recoveryHistoryBlockers,
  reviewGateBlockers,
""",
        "code test imports",
    )
    old_test_tail = """  assert.deepEqual(variants.map((entry: Record<string, any>) => entry.properties.type.enum[0]), [
    'edit',
    'verification',
    'review',
  ]);
});
"""
    new_test_tail = """  assert.deepEqual(variants.map((entry: Record<string, any>) => entry.properties.type.enum[0]), [
    'edit',
    'verification',
    'review',
  ]);
  const verification = variants[1];
  assert.ok(verification.required.includes('verifiedHeadSha'));
  const result = verification.properties.results.items;
  assert.deepEqual(result.required, ['status', 'cwd', 'command']);
  assert.deepEqual(result.properties.status.enum, ['passed', 'failed']);
});

test('recovery history only accepts a linear chain inside declared targets', () => {
  const base = 'a'.repeat(40);
  const first = 'b'.repeat(40);
  const second = 'c'.repeat(40);
  assert.deepEqual(
    recoveryHistoryBlockers(base, second, ['src/a.ts'], [
      { sha: first, parentSha: base, files: ['src/a.ts'] },
      { sha: second, parentSha: first, files: ['src/a.ts'] },
    ]),
    [],
  );
  assert.deepEqual(
    recoveryHistoryBlockers(base, second, ['src/a.ts'], [
      { sha: first, parentSha: base, files: ['src/other.ts'] },
      { sha: second, parentSha: base, files: ['src/a.ts'] },
    ]),
    [`outside_scope:src/other.ts`, `parent_changed:${second}`],
  );
});
"""
    test_text = replace_once(test_text, old_test_tail, new_test_tail, "code tests")
    test_path.write_text(test_text)


gpt_test_path = Path("gh-apps/kanarek-companion/test/gpt-actions.test.ts")
gpt_test = gpt_test_path.read_text()
if "preserves supported blob modes" not in gpt_test:
    gpt_test = replace_once(
        gpt_test,
        """  githubBotRequestAllowed,
  githubReadAllowed,
  openApiDocument,
""",
        """  githubBotRequestAllowed,
  githubReadAllowed,
  openApiDocument,
  preservedBlobMode,
""",
        "gpt test imports",
    )
    insert = """test('commit file mode helper preserves supported blob modes', () => {
  assert.equal(preservedBlobMode(undefined), '100644');
  assert.equal(preservedBlobMode('100644'), '100644');
  assert.equal(preservedBlobMode('100755'), '100755');
  assert.equal(preservedBlobMode('120000'), '120000');
  assert.throws(() => preservedBlobMode('160000'), /unsupported_file_mode/);
});

"""
    gpt_test = replace_once(
        gpt_test,
        "test('OpenAPI advertises hybrid identities and OAuth token proxy', () => {",
        insert + "test('OpenAPI advertises hybrid identities and OAuth token proxy', () => {",
        "gpt mode test",
    )
    gpt_test_path.write_text(gpt_test)
