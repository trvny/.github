module.exports = async ({ github, core }) => {
  const repositories = JSON.parse(process.env.REPOSITORIES_JSON || '[]');
  if (repositories.length === 0) {
    core.setFailed('Repository discovery returned an empty list.');
    return;
  }

  const retainDays = 5;
  const keepMinimumCaches = 3;
  const budgetMinimumAgeHours = 24;
  const budgetTriggerBytes = 5 * 1024 ** 3;
  const budgetTargetBytes = 4.5 * 1024 ** 3;
  const deleteBatchSize = 5;
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const budgetCutoff = Date.now() - budgetMinimumAgeHours * 60 * 60 * 1000;
  const failures = [];
  const summaries = [];

  const cacheSize = (cache) => {
    const size = Number(cache.size_in_bytes);
    return Number.isFinite(size) && size > 0 ? size : 0;
  };

  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    const exponent = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1,
    );
    return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
  };

  for (const repository of repositories) {
    const [owner, repo] = repository.split('/');
    let before = null;
    let beforeBytes = null;
    let staleMatched = null;
    let budgetMatched = null;
    let deleted = 0;
    let deletedBytes = 0;
    let failed = 0;

    try {
      const cachesById = new Map();
      for (let page = 1; ; page += 1) {
        const response = await github.request(
          'GET /repos/{owner}/{repo}/actions/caches',
          { owner, repo, per_page: 100, page },
        );
        const pageCaches = response.data.actions_caches ?? [];
        for (const cache of pageCaches) cachesById.set(cache.id, cache);
        if (pageCaches.length < 100) break;
      }

      const caches = [...cachesById.values()];
      caches.sort(
        (left, right) =>
          Date.parse(right.last_accessed_at ?? right.created_at) -
          Date.parse(left.last_accessed_at ?? left.created_at),
      );
      before = caches.length;
      beforeBytes = caches.reduce((total, cache) => total + cacheSize(cache), 0);
      staleMatched = 0;
      budgetMatched = 0;

      const protectedIds = new Set(
        caches.slice(0, keepMinimumCaches).map((cache) => cache.id),
      );
      const selected = new Map();

      for (const cache of caches.slice(keepMinimumCaches)) {
        if (Date.parse(cache.last_accessed_at ?? cache.created_at) < cutoff) {
          selected.set(cache.id, cache);
          staleMatched += 1;
        }
      }

      let projectedBytes = beforeBytes - [...selected.values()].reduce(
        (total, cache) => total + cacheSize(cache),
        0,
      );

      if (projectedBytes > budgetTriggerBytes) {
        for (const cache of [...caches].reverse()) {
          if (projectedBytes <= budgetTargetBytes) break;
          if (protectedIds.has(cache.id) || selected.has(cache.id)) continue;
          if (Date.parse(cache.last_accessed_at ?? cache.created_at) >= budgetCutoff) continue;
          const size = cacheSize(cache);
          if (size === 0) continue;
          selected.set(cache.id, cache);
          projectedBytes -= size;
          budgetMatched += 1;
        }
      }

      const cachesToDelete = [...selected.values()];
      core.info(
        `${repository}: ${staleMatched} stale + ${budgetMatched} budget cache(s) from ${before}`,
      );

      for (let offset = 0; offset < cachesToDelete.length; offset += deleteBatchSize) {
        const batch = cachesToDelete.slice(offset, offset + deleteBatchSize);
        const results = await Promise.allSettled(
          batch.map((cache) =>
            github.request(
              'DELETE /repos/{owner}/{repo}/actions/caches/{cache_id}',
              { owner, repo, cache_id: cache.id },
            ),
          ),
        );

        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          const cache = batch[index];
          if (result.status === 'fulfilled') {
            deleted += 1;
            deletedBytes += cacheSize(cache);
          } else {
            failed += 1;
            failures.push(
              `${repository} cache #${cache.id}: ${result.reason?.message ?? result.reason}`,
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
      beforeBytes === null ? 'N/A' : formatBytes(beforeBytes),
      staleMatched === null ? 'N/A' : String(staleMatched),
      budgetMatched === null ? 'N/A' : String(budgetMatched),
      String(deleted),
      formatBytes(deletedBytes),
      beforeBytes === null ? 'N/A' : formatBytes(Math.max(0, beforeBytes - deletedBytes)),
      String(failed),
    ]);
  }

  await core.summary
    .addHeading('Actions cache cleanup')
    .addRaw(
      `Stale after ${retainDays} days without access. Above ${formatBytes(budgetTriggerBytes)}, least-recently-used caches older than ${budgetMinimumAgeHours}h are pruned toward ${formatBytes(budgetTargetBytes)}. At least ${keepMinimumCaches} newest caches are always kept.`,
    )
    .addTable([
      [
        { data: 'Repository', header: true },
        { data: 'Before', header: true },
        { data: 'Size', header: true },
        { data: 'Stale', header: true },
        { data: 'Budget', header: true },
        { data: 'Deleted', header: true },
        { data: 'Freed', header: true },
        { data: 'After', header: true },
        { data: 'Failed', header: true },
      ],
      ...summaries,
    ])
    .write();

  if (failures.length > 0) {
    core.setFailed(`${failures.length} Actions cache operation(s) failed`);
  }
};
