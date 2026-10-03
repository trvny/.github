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
  const failures = [];
  const summaries = [];

  for (const repository of repositories) {
    const [owner, repo] = repository.split('/');
    let before = null;
    let matched = null;
    let deleted = 0;
    let failed = 0;

    try {
      const [workflows, runs] = await Promise.all([
        github.paginate(
          github.rest.actions.listRepoWorkflows,
          { owner, repo, per_page: 100 },
        ),
        github.paginate(
          github.rest.actions.listWorkflowRunsForRepo,
          { owner, repo, per_page: 100 },
        ),
      ]);
      const completedRuns = runs.filter((run) => run.status === 'completed');
      before = completedRuns.length;
      const activeWorkflowIds = new Set(workflows.map((workflow) => workflow.id));
      const runsByWorkflow = new Map();

      for (const run of completedRuns) {
        const workflowRuns = runsByWorkflow.get(run.workflow_id) ?? [];
        workflowRuns.push(run);
        runsByWorkflow.set(run.workflow_id, workflowRuns);
      }

      const runsToDelete = [];
      for (const [workflowId, workflowRuns] of runsByWorkflow) {
        workflowRuns.sort(
          (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
        );
        const minimum = activeWorkflowIds.has(workflowId) ? keepMinimumRuns : 0;

        for (const run of workflowRuns.slice(minimum)) {
          if (Date.parse(run.created_at) < cutoff) runsToDelete.push(run);
        }
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
