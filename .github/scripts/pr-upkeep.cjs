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
    (response) => response.data.check_runs,
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
  };
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
  const repository = await github.rest.repos.get({ owner, repo });
  const defaultBranch = repository.data.default_branch;
  const automergeEnabled =
    (process.env.AUTOMERGE_ENABLED || 'false').toLowerCase() === 'true';
  const automergeLabel = process.env.AUTOMERGE_LABEL || 'automerge';
  const idleHours = Number.parseFloat(process.env.AUTOMERGE_IDLE_HOURS || '4');
  const mergeMethod = process.env.AUTOMERGE_METHOD || 'squash';
  const allowNoChecks =
    (process.env.AUTOMERGE_ALLOW_NO_CHECKS || 'false').toLowerCase() ===
    'true';
  const failures = [];

  if (automergeEnabled) {
    if (!Number.isFinite(idleHours) || idleHours < 0) {
      throw new Error(
        `Invalid AUTOMERGE_IDLE_HOURS: ${process.env.AUTOMERGE_IDLE_HOURS}`,
      );
    }
    if (!MERGE_METHODS.has(mergeMethod)) {
      throw new Error(`Invalid AUTOMERGE_METHOD: ${mergeMethod}`);
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
        await github.request(
          'PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch',
          {
            owner,
            repo,
            pull_number: pullRequest.number,
            expected_head_sha: pullRequest.head.sha,
          },
        );
        core.info(
          `${prefix}: updated with ${defaultBranch}; merge deferred for fresh CI.`,
        );
      } catch (error) {
        if ([403, 422].includes(error.status)) {
          const message =
            `${prefix}: branch update rejected (${error.status}): ${error.message}`;
          failures.push(message);
          core.warning(message);
          continue;
        }
        throw error;
      }
      continue;
    }

    if (!automergeEnabled) {
      core.info(`${prefix}: branch is current; automerge disabled.`);
      continue;
    }

    if (pullRequest.draft) {
      core.info(
        `${prefix}: branch is current; draft is not eligible for automerge.`,
      );
      continue;
    }

    if (!hasLabel(pullRequest, automergeLabel)) {
      core.info(`${prefix}: up to date; no ${automergeLabel} label.`);
      continue;
    }

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

    try {
      const merge = await github.rest.pulls.merge({
        owner,
        repo,
        pull_number: pullRequest.number,
        merge_method: mergeMethod,
        sha: pullRequest.head.sha,
      });
      if (merge.data.merged) {
        core.info(`${prefix}: merged via ${mergeMethod}.`);
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
