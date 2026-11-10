'use strict';

const FAILURE_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'stale',
  'startup_failure',
  'timed_out',
]);
const PASSING_CONCLUSIONS = new Set(['neutral', 'skipped', 'success']);
const MERGE_METHODS = new Set(['merge', 'rebase', 'squash']);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function hasLabel(pullRequest, label) {
  return pullRequest.labels.some(
    (item) => item.name.toLocaleLowerCase() === label.toLocaleLowerCase(),
  );
}

async function getPullRequest(github, owner, repo, pullNumber) {
  let response = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  if (response.data.mergeable === null) {
    await sleep(1200);
    response = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });
  }

  return response.data;
}

async function compareHeadToBase(github, owner, repo, baseSha, headSha) {
  const response = await github.request(
    'GET /repos/{owner}/{repo}/compare/{basehead}',
    {
      owner,
      repo,
      basehead: `${baseSha}...${headSha}`,
    },
  );
  return response.data;
}

async function checkState(github, owner, repo, headSha) {
  const checkRuns = await github.paginate(
    github.rest.checks.listForRef,
    {
      owner,
      repo,
      ref: headSha,
      filter: 'latest',
      per_page: 100,
    },
  );

  const statusResponse = await github.rest.repos.getCombinedStatusForRef({
    owner,
    repo,
    ref: headSha,
    per_page: 100,
  });
  const statuses = statusResponse.data.statuses;

  const pendingChecks = checkRuns.filter((run) => run.status !== 'completed');
  const failedChecks = checkRuns.filter(
    (run) =>
      run.status === 'completed' &&
      (!run.conclusion || FAILURE_CONCLUSIONS.has(run.conclusion)),
  );
  const unusualChecks = checkRuns.filter(
    (run) =>
      run.status === 'completed' &&
      run.conclusion &&
      !PASSING_CONCLUSIONS.has(run.conclusion) &&
      !FAILURE_CONCLUSIONS.has(run.conclusion),
  );
  const pendingStatuses = statuses.filter((status) => status.state === 'pending');
  const failedStatuses = statuses.filter((status) =>
    ['error', 'failure'].includes(status.state),
  );

  return {
    failed: [...failedChecks, ...unusualChecks, ...failedStatuses],
    observed: checkRuns.length + statuses.length > 0,
    pending: [...pendingChecks, ...pendingStatuses],
    allGreen: checkRuns.length + statuses.length > 0 &&
      checkRuns.every((run) =>
        run.status === 'completed' && run.conclusion === 'success') &&
      statuses.every((status) => status.state === 'success'),
  };
}

async function safeDependabotUpdate(github, owner, repo, pullRequest) {
  if (
    pullRequest.user?.login !== 'dependabot[bot]' ||
    !pullRequest.head.ref?.startsWith('dependabot/')
  ) return false;

  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: pullRequest.number,
    per_page: 100,
  });
  const updates = commits.filter((commit) => commit.parents?.length !== 2);
  if (!updates.length) return false;

  return updates.every((commit) => {
    if (
      commit.author?.login !== 'dependabot[bot]' &&
      commit.committer?.login !== 'dependabot[bot]'
    ) return false;

    const types = [...(commit.commit?.message || '').matchAll(
      /^\s*-?\s*update-type:\s*(\S+)/gm,
    )].map((match) => match[1]);
    return types.length > 0 && types.every((type) =>
      type === 'version-update:semver-patch' ||
      type === 'version-update:semver-minor');
  });
}

async function blockingReviewFeedback(github, owner, repo, pullRequest) {
  if (
    pullRequest.requested_reviewers?.length ||
    pullRequest.requested_teams?.length
  ) return 'requested reviewers are still pending';

  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullRequest.number,
    per_page: 100,
  });
  const latest = new Map();
  for (const review of reviews) {
    if (!review.user?.login) continue;
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
      latest.set(review.user.login.toLowerCase(), review.state);
    }
  }
  if ([...latest.values()].includes('CHANGES_REQUESTED')) {
    return 'changes requested in reviews';
  }

  let cursor = null;
  do {
    const data = await github.graphql(`query(
      $owner: String!, $repo: String!, $number: Int!, $cursor: String
    ) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            nodes { isResolved }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`, { owner, repo, number: pullRequest.number, cursor });
    const page = data.repository?.pullRequest?.reviewThreads;
    if (!page) return 'review threads could not be verified';
    if (page.nodes.some((thread) => !thread.isResolved)) {
      return 'unresolved review threads';
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return null;
}

function describeChecks(items) {
  return items
    .map((item) => item.name ?? item.context ?? item.id)
    .slice(0, 8)
    .join(', ');
}

module.exports = async function keepPullRequestsCurrent({
  github,
  context,
  core,
}) {
  const { owner, repo } = context.repo;
  const repository = await github.rest.repos.get({
    owner,
    repo,
    request: { timeout: 30_000 },
  });
  const defaultBranch = repository.data.default_branch;
  const updateMethod = process.env.PR_BRANCH_UPDATE_METHOD || 'rebase';
  if (!['merge', 'rebase'].includes(updateMethod)) {
    throw new Error(`Invalid PR_BRANCH_UPDATE_METHOD: ${updateMethod}`);
  }
  const automergeEnabled =
    (process.env.AUTOMERGE_ENABLED || 'false').toLowerCase() === 'true';
  const automergeLabel = process.env.AUTOMERGE_LABEL || 'automerge';
  const idleHours = Number.parseFloat(process.env.AUTOMERGE_IDLE_HOURS || '4');
  const mergeMethod = process.env.AUTOMERGE_METHOD || 'squash';
  const allowNoChecks =
    (process.env.AUTOMERGE_ALLOW_NO_CHECKS || 'false').toLowerCase() ===
    'true';
  const dependabotEnabled =
    (process.env.DEPENDABOT_AUTOMERGE_ENABLED || 'true').toLowerCase() ===
    'true';
  const dependabotMethod =
    process.env.DEPENDABOT_AUTOMERGE_METHOD || 'squash';
  const failures = [];

  if (automergeEnabled || dependabotEnabled) {
    if (!Number.isFinite(idleHours) || idleHours < 0) {
      throw new Error(
        `Invalid AUTOMERGE_IDLE_HOURS: ${process.env.AUTOMERGE_IDLE_HOURS}`,
      );
    }
    if (automergeEnabled && !MERGE_METHODS.has(mergeMethod)) {
      throw new Error(`Invalid AUTOMERGE_METHOD: ${mergeMethod}`);
    }
    if (dependabotEnabled && !['squash', 'rebase'].includes(dependabotMethod)) {
      throw new Error(`Invalid DEPENDABOT_AUTOMERGE_METHOD: ${dependabotMethod}`);
    }
  }

  const pullRequests = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    base: defaultBranch,
    sort: 'updated',
    direction: 'asc',
    per_page: 100,
  });

  core.info(`Found ${pullRequests.length} open PR(s) targeting ${defaultBranch}.`);

  for (const listed of pullRequests) {
    let pullRequest = await getPullRequest(github, owner, repo, listed.number);
    const prefix = `PR #${pullRequest.number}`;

    const comparison = await compareHeadToBase(
      github,
      owner,
      repo,
      pullRequest.base.sha,
      pullRequest.head.sha,
    );

    if (comparison.behind_by > 0) {
      if (pullRequest.head.ref === 'gptomek/control') {
        core.info(`${prefix}: reserved GPTomek control branch; left untouched.`);
        continue;
      }
      const sameRepository =
        pullRequest.head.repo?.full_name === pullRequest.base.repo.full_name;
      if (!sameRepository) {
        core.info(
          `${prefix}: fork branch is behind; cannot update it with this token.`,
        );
        continue;
      }
      if (
        pullRequest.mergeable === false ||
        pullRequest.mergeable_state === 'dirty'
      ) {
        core.warning(`${prefix}: behind with merge conflicts, left untouched.`);
        continue;
      }

      try {
        if (updateMethod === 'rebase') {
          await github.graphql(`mutation(
            $pullRequestId: ID!, $expectedHeadOid: GitObjectID!
          ) {
            updatePullRequestBranch(input: {
              pullRequestId: $pullRequestId
              expectedHeadOid: $expectedHeadOid
              updateMethod: REBASE
            }) {
              pullRequest { id }
            }
          }`, {
            pullRequestId: pullRequest.node_id,
            expectedHeadOid: pullRequest.head.sha,
          });
        } else {
          await github.request(
            'PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch',
            {
              owner,
              repo,
              pull_number: pullRequest.number,
              expected_head_sha: pullRequest.head.sha,
            },
          );
        }
        core.info(
          `${prefix}: ${updateMethod} update requested onto ${defaultBranch}; ` +
          'merge deferred for fresh CI.',
        );
      } catch (error) {
        const graphqlRejected = updateMethod === 'rebase' &&
          (error.name === 'GraphqlResponseError' || Array.isArray(error.errors));
        if ([403, 422].includes(error.status) || graphqlRejected) {
          const reason = error.status || 'GraphQL';
          const message =
            `${prefix}: branch update rejected (${reason}): ${error.message}`;
          failures.push(message);
          core.warning(message);
          continue;
        }
        throw error;
      }
      continue;
    }

    const dependabotAuthor = pullRequest.user?.login === 'dependabot[bot]';
    let dependabotEligible = false;
    if (dependabotEnabled && dependabotAuthor) {
      try {
        dependabotEligible = await safeDependabotUpdate(
          github, owner, repo, pullRequest,
        );
      } catch (error) {
        core.warning(`${prefix}: Dependabot metadata unavailable: ${error.message}`);
        continue;
      }
    }
    const labelledEligible = automergeEnabled &&
      hasLabel(pullRequest, automergeLabel);

    if (!dependabotEligible && !labelledEligible) {
      core.info(`${prefix}: no automerge route${dependabotAuthor
        ? ' (Dependabot update not eligible for safe semver automerge)' : ''}.`);
      continue;
    }

    if (pullRequest.draft) {
      core.info(`${prefix}: draft is not eligible for automerge.`);
      continue;
    }

    const selectedMethod = dependabotEligible ? dependabotMethod : mergeMethod;

    pullRequest = await getPullRequest(github, owner, repo, pullRequest.number);
    if (
      pullRequest.mergeable !== true ||
      pullRequest.mergeable_state !== 'clean'
    ) {
      core.info(
        `${prefix}: not cleanly mergeable (` +
          `${pullRequest.mergeable_state ?? 'unknown'}).`,
      );
      continue;
    }

    const idleMilliseconds = Date.now() - Date.parse(pullRequest.updated_at);
    const requiredIdleMilliseconds = idleHours * 60 * 60 * 1000;
    if (idleMilliseconds < requiredIdleMilliseconds) {
      const remainingMinutes = Math.ceil(
        (requiredIdleMilliseconds - idleMilliseconds) / 60000,
      );
      core.info(
        `${prefix}: waiting about ${remainingMinutes} more minute(s) of inactivity.`,
      );
      continue;
    }

    const checks = await checkState(
      github,
      owner,
      repo,
      pullRequest.head.sha,
    );
    if (!checks.observed && !allowNoChecks) {
      core.info(
        `${prefix}: no checks or commit statuses found on the current SHA.`,
      );
      continue;
    }
    if (checks.failed.length > 0) {
      core.warning(`${prefix}: failing checks: ${describeChecks(checks.failed)}.`);
      continue;
    }
    if (checks.pending.length > 0) {
      core.info(`${prefix}: pending checks: ${describeChecks(checks.pending)}.`);
      continue;
    }
    if (dependabotEligible && !checks.allGreen) {
      core.info(`${prefix}: Dependabot requires every observed check to succeed.`);
      continue;
    }

    let reviewBlocker;
    try {
      reviewBlocker = await blockingReviewFeedback(
        github, owner, repo, pullRequest,
      );
    } catch (error) {
      core.warning(`${prefix}: cannot verify review state: ${error.message}`);
      continue;
    }
    if (reviewBlocker) {
      core.info(`${prefix}: ${reviewBlocker}; merge deferred.`);
      continue;
    }

    try {
      const merge = await github.rest.pulls.merge({
        owner,
        repo,
        pull_number: pullRequest.number,
        merge_method: selectedMethod,
        sha: pullRequest.head.sha,
      });
      if (merge.data.merged) {
        core.info(`${prefix}: merged via ${selectedMethod}.`);
      } else {
        core.warning(`${prefix}: merge declined: ${merge.data.message}`);
      }
    } catch (error) {
      if ([403, 405, 409, 422].includes(error.status)) {
        core.warning(
          `${prefix}: merge rejected (${error.status}): ${error.message}`,
        );
        continue;
      }
      throw error;
    }
  }

  return { failures };
};
