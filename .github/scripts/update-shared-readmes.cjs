'use strict';

const updateSourceReadme = require('./update-readme-quote.cjs');

const QUOTE_START_MARKER = '<!--STARTS_HERE_QUOTE_README-->';
const QUOTE_END_MARKER = '<!--ENDS_HERE_QUOTE_README-->';
const FEED_START_MARKER = '<!--README_FEED:START-->';
const FEED_END_MARKER = '<!--README_FEED:END-->';
const README_MODES = new Set(['both', 'feed', 'quote']);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerPattern(start, end) {
  return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
}

function extractBlock(readme, start, end) {
  const block = readme.match(markerPattern(start, end))?.[0];
  if (!block) {
    throw new Error(`Missing dynamic README block: ${start}`);
  }
  return block;
}

function parseTargets(value) {
  const targets = (value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const parsed = new Map();

  for (const target of targets) {
    const separator = target.lastIndexOf(':');
    const repository = separator === -1 ? target : target.slice(0, separator);
    const mode = separator === -1 ? 'both' : target.slice(separator + 1).toLowerCase();

    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
      throw new Error(`Invalid README target: ${target}`);
    }
    if (!README_MODES.has(mode)) {
      throw new Error(`Invalid README mode for ${repository}: ${mode}`);
    }
    if (parsed.has(repository) && parsed.get(repository) !== mode) {
      throw new Error(`Conflicting README modes for ${repository}`);
    }
    parsed.set(repository, mode);
  }

  return [...parsed].map(([repository, mode]) => ({ repository, mode }));
}

function syncBlocks(readme, feedBlock, quoteBlock, mode = 'both') {
  if (!README_MODES.has(mode)) {
    throw new Error(`Invalid README mode: ${mode}`);
  }

  const feedPattern = markerPattern(FEED_START_MARKER, FEED_END_MARKER);
  const quotePattern = markerPattern(QUOTE_START_MARKER, QUOTE_END_MARKER);
  const additions = [];
  let updated = readme;

  if (mode !== 'quote') {
    if (feedPattern.test(updated)) {
      updated = updated.replace(feedPattern, feedBlock);
    } else {
      additions.push(`## 📰 Mininewsy\n\n${feedBlock}`);
    }
  }

  if (mode !== 'feed') {
    if (quotePattern.test(updated)) {
      updated = updated.replace(quotePattern, quoteBlock);
    } else {
      additions.push(
        [
          '## 💬 Cytat z szuflady',
          '',
          '<!-- markdownlint-disable MD033 -->',
          quoteBlock,
          '<!-- markdownlint-enable MD033 -->',
        ].join('\n'),
      );
    }
  }

  if (additions.length > 0) {
    updated = `${updated.trimEnd()}\n\n${additions.join('\n\n')}\n`;
  }

  return updated;
}

async function fetchReadme(github, owner, repo, path = 'README.md') {
  const repository = await github.rest.repos.get({ owner, repo });
  const branch = repository.data.default_branch;
  const response = await github.rest.repos.getContent({
    owner,
    repo,
    path,
    ref: branch,
  });

  if (Array.isArray(response.data) || response.data.type !== 'file') {
    throw new Error(`${owner}/${repo}/${path} is not a file`);
  }

  return {
    branch,
    content: Buffer.from(response.data.content, 'base64').toString('utf8'),
    sha: response.data.sha,
  };
}

module.exports = async function updateSharedReadmes({ github, context, core }) {
  await updateSourceReadme({ github, context, core });

  const source = await fetchReadme(github, context.repo.owner, context.repo.repo);
  const feedBlock = extractBlock(source.content, FEED_START_MARKER, FEED_END_MARKER);
  const quoteBlock = extractBlock(
    source.content,
    QUOTE_START_MARKER,
    QUOTE_END_MARKER,
  );
  const failures = [];

  for (const target of parseTargets(process.env.README_TARGET_REPOS)) {
    const [owner, repo] = target.repository.split('/');
    core.startGroup(`Update ${target.repository} (${target.mode})`);
    try {
      const readme = await fetchReadme(github, owner, repo);
      const updated = syncBlocks(
        readme.content,
        feedBlock,
        quoteBlock,
        target.mode,
      );
      if (updated === readme.content) {
        core.info(`${target.repository}: dynamic README content is unchanged.`);
        continue;
      }

      await github.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: 'README.md',
        branch: readme.branch,
        message: 'chore(readme): refresh shared content [skip ci]',
        content: Buffer.from(updated, 'utf8').toString('base64'),
        sha: readme.sha,
      });
      core.info(`${target.repository}: README updated.`);
    } catch (error) {
      failures.push(`${target.repository}: ${error.message}`);
      core.error(failures.at(-1));
    } finally {
      core.endGroup();
    }
  }

  if (failures.length > 0) {
    core.setFailed(`${failures.length} README target(s) could not be updated`);
  }
};

module.exports._test = {
  extractBlock,
  parseTargets,
  syncBlocks,
};
