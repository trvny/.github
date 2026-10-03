module.exports = async ({ github, context, core }) => {
  const owners = new Set(process.env.OWNERS.trim().split(/\s+/));
  const visible = await github.paginate(
    github.rest.repos.listForAuthenticatedUser,
    {
      affiliation: 'owner,organization_member',
      visibility: 'all',
      sort: 'full_name',
      direction: 'asc',
      per_page: 100,
    },
  );

  const active = visible
    .filter((repo) => owners.has(repo.owner.login))
    .filter((repo) => !repo.archived && !repo.disabled);
  const repositories = [...new Set(active.map((repo) => repo.full_name))]
    .sort((left, right) => left.localeCompare(right));
  const publicRepositories = [...new Set(
    active.filter((repo) => !repo.private).map((repo) => repo.full_name),
  )].sort((left, right) => left.localeCompare(right));
  const privateRepositories = [...new Set(
    active.filter((repo) => repo.private).map((repo) => repo.full_name),
  )].sort((left, right) => left.localeCompare(right));

  if (repositories.length === 0) {
    core.setFailed(`No active repositories found for: ${[...owners].join(', ')}`);
    return;
  }

  const dayOfMonth = Number(new Date().toISOString().slice(8, 10));
  const scheduledEol = (dayOfMonth - 1) % 4 === 0;
  const manualEol =
    context.eventName === 'workflow_dispatch' &&
    ['all', 'eol'].includes(process.env.MAINTENANCE_TASK);
  const runEol = manualEol || (context.eventName === 'schedule' && scheduledEol);

  core.setOutput('repositories', JSON.stringify(repositories));
  core.setOutput('public_repositories', publicRepositories.join('\n'));
  core.setOutput('run_eol', String(runEol));

  if (privateRepositories.length > 0) {
    core.notice(
      `EOL guard skips private repositories: ${privateRepositories.join(', ')}`,
    );
  }

  await core.summary
    .addHeading('Repository discovery')
    .addRaw(
      `Owners: ${[...owners].join(', ')}. Active: ${repositories.length}. ` +
      `Public for EOL guard: ${publicRepositories.length}. ` +
      `EOL due this run: ${runEol}.`,
    )
    .addList(repositories)
    .write();
};
