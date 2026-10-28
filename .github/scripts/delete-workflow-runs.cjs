module.exports = async ({ github, core }) => {
  const repositories = JSON.parse(process.env.REPOSITORIES_JSON || '[]');
  if (repositories.length === 0) {
    core.setFailed('Repository discovery returned an empty list.');
    return;
  }

  const retainDays = 3;
  const keepMinimumRuns = 3;
  const deleteBatchSize = 5;
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoff).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const failures = [];
  const summaries = [];

  // Server-side `created` filter: fetch only old runs to delete, plus recent ones just
  // to count per workflow (keepMinimumRuns). Full-history pagination burned the PAT quota.
  // Filtered listings cap at 1000 results; any remainder goes on the next run.
  const listRuns = (owner, repo, created) =>
    github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
      owner,
      repo,
      status: 'completed',
      created,
      per_page: 100,
    });

  for (const repository of repositories) {
    const [owner, repo] = repository.split('/');
    let before = null;
    let matched = null;
    let deleted = 0;
    let failed = 0;

    try {
      const [workflows, recentRuns, oldRuns] = await Promise.all([
        github.paginate(
          github.rest.actions.listRepoWorkflows,
          { owner, repo, per_page: 100 },
        ),
        listRuns(owner, repo, `>=${cutoffDate}`),
        listRuns(owner, repo, `<${cutoffDate}`),
      ]);
      before = recentRuns.length + oldRuns.length;
      const activeWorkflowIds = new Set(workflows.map((workflow) => workflow.id));
      const recentCount = new Map();
      for (const run of recentRuns) {
        recentCount.set(run.workflow_id, (recentCount.get(run.workflow_id) ?? 0) + 1);
      }

      const oldByWorkflow = new Map();
      for (const run of oldRuns) {
        const workflowRuns = oldByWorkflow.get(run.workflow_id) ?? [];
        workflowRuns.push(run);
        oldByWorkflow.set(run.workflow_id, workflowRuns);
      }

      // Same outcome as before: newest keepMinimumRuns per active workflow survive,
      // so old runs are kept only when the window has fewer than that.
      const runsToDelete = [];
      for (const [workflowId, workflowRuns] of oldByWorkflow) {
        workflowRuns.sort(
          (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
        );
        const minimum = activeWorkflowIds.has(workflowId) ? keepMinimumRuns : 0;
        const keepOld = Math.max(0, minimum - (recentCount.get(workflowId) ?? 0));
        runsToDelete.push(...workflowRuns.slice(keepOld));
      }

      matched = runsToDelete.length;
      core.info(`${repository}: ${matched} run(s) to delete from ${before}`);

      for (let offset = 0; offset < runsToDelete.length; offset += deleteBatchSize) {
        const batch = runsToDelete.slice(offset, offset + deleteBatchSize);
        const results = await Promise.allSettled(
          batch.map((run) =>
            github.rest.actions.deleteWorkflowRun({ owner, repo, run_id: run.id }),
          ),
        );

        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          const run = batch[index];
          if (result.status === 'fulfilled') {
            deleted += 1;
          } else {
            failed += 1;
            failures.push(
              `${repository}#${run.id}: ${result.reason?.message ?? result.reason}`,
            );
            core.error(failures.at(-1));
          }
        }
      }
    } catch (error) {
      failed += 1;
      failures.push(`${repository}: ${error.message}`);
      core.error(failures.at(-1));
    }

    summaries.push([
      repository,
      before === null ? 'N/A' : String(before),
      matched === null ? 'N/A' : String(matched),
      String(deleted),
      String(failed),
      before === null ? 'N/A' : String(Math.max(0, before - deleted)),
    ]);
  }

  await core.summary
    .addHeading('Workflow run cleanup')
    .addRaw(`Retention: ${retainDays} days; minimum kept per active workflow: ${keepMinimumRuns}.`)
    .addTable([
      [
        { data: 'Repository', header: true },
        { data: 'Completed before', header: true },
        { data: 'Matched', header: true },
        { data: 'Deleted', header: true },
        { data: 'Failed', header: true },
        { data: 'Completed remaining', header: true },
      ],
      ...summaries,
    ])
    .write();

  if (failures.length > 0) {
    core.setFailed(`${failures.length} workflow run(s) could not be deleted`);
  }
};
