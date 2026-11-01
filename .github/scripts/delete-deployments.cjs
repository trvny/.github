module.exports = async ({ github, core }) => {
  const repositories = JSON.parse(process.env.REPOSITORIES_JSON || '[]');
  if (repositories.length === 0) {
    core.setFailed('Repository discovery returned an empty list.');
    return;
  }

  const keepNewest = 20;
  const retainDays = 30;
  const maxPages = 10;
  const maxChecksPerRepo = 50;
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const failures = [];
  const summaries = [];

  for (const repository of repositories) {
    const [owner, repo] = repository.split('/');
    let deployments = [];
    let matched = 0;
    let checked = 0;
    let deleted = 0;
    let skipped = 0;
    let truncated = false;

    try {
      // Only github-pages. Other deployments can represent live applications.
      for (let page = 1; page <= maxPages; page += 1) {
        const response = await github.rest.repos.listDeployments({
          owner, repo, environment: 'github-pages', per_page: 100, page,
        });
        deployments.push(...response.data);
        if (response.data.length < 100) break;
        if (page === maxPages) truncated = true;
      }

      deployments.sort((left, right) =>
        Date.parse(right.created_at) - Date.parse(left.created_at) ||
        right.id - left.id,
      );

      // Never touch newest 20, even if inactive. Age alone is insufficient.
      const candidates = deployments.slice(keepNewest).filter(
        (deployment) =>
          Number.isFinite(Date.parse(deployment.created_at)) &&
          Date.parse(deployment.created_at) < cutoff,
      );
      matched = candidates.length;

      // Rotate the bounded checks across runs, without persistent state.
      const runNumber = Number(process.env.GITHUB_RUN_NUMBER) || 0;
      const start = candidates.length > 0
        ? (runNumber * maxChecksPerRepo) % candidates.length
        : 0;
      const selected = [...candidates.slice(start), ...candidates.slice(0, start)]
        .slice(0, maxChecksPerRepo);
      for (const deployment of selected) {
        const statusResponse = await github.rest.repos.listDeploymentStatuses({
          owner, repo, deployment_id: deployment.id, per_page: 1,
        });
        checked += 1;
        // Do not mutate deployment statuses or mark old deployments inactive.
        if (statusResponse.data[0]?.state !== 'inactive') {
          skipped += 1;
          continue;
        }

        try {
          await github.rest.repos.deleteDeployment({
            owner, repo, deployment_id: deployment.id,
          });
          deleted += 1;
        } catch (error) {
          // GitHub itself blocks deletion if a deployment became active.
          if (error.status === 422) {
            skipped += 1;
            core.warning(repository + ' deployment #' + deployment.id +
              ': state changed or deletion rejected');
            continue;
          }
          throw error;
        }
      }

      if (truncated) {
        core.notice(repository + ': scanned first ' + deployments.length +
          ' deployments; older pages deferred');
      }
    } catch (error) {
      failures.push(repository + ': ' + error.message);
      core.error(failures.at(-1));
    }

    if (deployments.length > 0 || failures.some((item) =>
      item.startsWith(repository + ':'))) {
      summaries.push([
        repository,
        String(deployments.length) + (truncated ? '+' : ''),
        String(matched),
        String(checked),
        String(deleted),
        String(skipped),
      ]);
    }
  }

  await core.summary
    .addHeading('GitHub Pages deployment cleanup')
    .addRaw('Environment: github-pages; retain newest ' + keepNewest +
      ' and anything newer than ' + retainDays + ' days. ' +
      'Inspect at most ' + maxChecksPerRepo +
      ' older deployments per repository per run. Inactive only; ' +
      'active/pending deployments are never modified.')
    .addTable([
      [
        { data: 'Repository', header: true },
        { data: 'Listed', header: true },
        { data: 'Old', header: true },
        { data: 'Checked', header: true },
        { data: 'Deleted', header: true },
        { data: 'Skipped', header: true },
      ],
      ...summaries,
    ])
    .write();

  if (failures.length > 0) {
    core.setFailed(failures.length + ' deployment cleanup failure(s)');
  }
};
